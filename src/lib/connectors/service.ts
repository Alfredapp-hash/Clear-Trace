import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { connectorConfigs, organizations } from "@/lib/db/schema";
import { decryptValue, encryptValue, redactValue } from "@/lib/crypto/encryption";
import { logAuditEvent } from "@/lib/audit/logger";
import { CONNECTOR_REGISTRY, getConnectorDefinition } from "./registry";
import { testConnectorConnection } from "./connection/providers";
import { ConnectionHelper } from "./connection/helper";
import { getSetupGuide } from "./connection/setup-guides";
import {
  CATEGORY_DEFAULT_CONNECTORS,
  breachIntelConnectorTypes,
  discoveryConnectorTypes,
  emailConnectorTypes,
} from "./requirements";
import type {
  AgentDefaults,
  ConnectorCredentials,
  ConnectorPublicView,
  ConnectorType,
} from "./types";

function maskCredentials(
  type: ConnectorType,
  credentials: ConnectorCredentials,
): string {
  const secretKey =
    credentials.apiKey ??
    credentials.clientSecret ??
    credentials.password ??
    credentials.refreshToken ??
    credentials.authHeader ??
    credentials.url;
  if (secretKey) return redactValue(secretKey);
  const first = Object.values(credentials).find((v) => v?.trim());
  return first ? redactValue(first) : "configured";
}

function parseMetadata(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function parseAgentDefaults(raw: string | null | undefined): AgentDefaults {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as AgentDefaults;
  } catch {
    return {};
  }
}

function toPublicView(
  def: (typeof CONNECTOR_REGISTRY)[number],
  row?: typeof connectorConfigs.$inferSelect,
): ConnectorPublicView {
  if (!row) {
    return {
      type: def.type,
      name: def.name,
      category: def.category,
      description: def.description,
      fields: def.fields,
      metadataFields: def.metadataFields,
      docsUrl: def.docsUrl,
      configured: false,
      status: "not_configured",
      enabled: true,
    };
  }

  let status: ConnectorPublicView["status"] = row.status as ConnectorPublicView["status"];
  if (!row.enabled) status = "disabled";

  return {
    type: def.type,
    name: def.name,
    category: def.category,
    description: def.description,
    fields: def.fields,
    metadataFields: def.metadataFields,
    docsUrl: def.docsUrl,
    configured: true,
    status,
    maskedPreview: row.maskedPreview,
    lastTestedAt: row.lastTestedAt,
    lastError: row.lastError,
    metadata: parseMetadata(row.metadataJson),
    enabled: row.enabled,
  };
}

export async function listOrgConnectors(organizationId: string): Promise<ConnectorPublicView[]> {
  const rows = await db.query.connectorConfigs.findMany({
    where: eq(connectorConfigs.organizationId, organizationId),
  });
  const byType = new Map(rows.map((r) => [r.connectorType, r]));

  return CONNECTOR_REGISTRY.map((def) => toPublicView(def, byType.get(def.type)));
}

export async function getConnectorStatus(
  organizationId: string,
  type: ConnectorType,
): Promise<{ configured: boolean; status: string; connected: boolean }> {
  const row = await db.query.connectorConfigs.findFirst({
    where: and(
      eq(connectorConfigs.organizationId, organizationId),
      eq(connectorConfigs.connectorType, type),
    ),
  });
  if (!row || !row.enabled) {
    return { configured: false, status: "not_configured", connected: false };
  }
  return {
    configured: true,
    status: row.status,
    connected: row.status === "connected",
  };
}

export async function getOrgConnector(
  organizationId: string,
  type: ConnectorType,
): Promise<{
  credentials: ConnectorCredentials;
  metadata: Record<string, string>;
} | null> {
  const row = await db.query.connectorConfigs.findFirst({
    where: and(
      eq(connectorConfigs.organizationId, organizationId),
      eq(connectorConfigs.connectorType, type),
      eq(connectorConfigs.enabled, true),
    ),
  });
  if (!row || row.status !== "connected") return null;

  try {
    const credentials = JSON.parse(decryptValue(row.encryptedCredentials)) as ConnectorCredentials;
    return { credentials, metadata: parseMetadata(row.metadataJson) };
  } catch {
    return null;
  }
}

export async function resolveDiscoveryConnector(
  organizationId: string,
): Promise<ConnectorType | null> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  const defaults = parseAgentDefaults(org?.agentDefaultsJson);
  const preferred = defaults.discovery;

  const candidates = preferred
    ? [preferred, ...discoveryConnectorTypes().filter((t) => t !== preferred)]
    : discoveryConnectorTypes();

  for (const type of candidates) {
    const status = await getConnectorStatus(organizationId, type);
    if (status.connected) return type;
  }
  return null;
}

export async function resolveBreachIntelConnector(
  organizationId: string,
): Promise<ConnectorType | null> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  const defaults = parseAgentDefaults(org?.agentDefaultsJson);
  const preferred = defaults.breachIntel;

  const candidates = preferred
    ? [preferred, ...breachIntelConnectorTypes().filter((t) => t !== preferred)]
    : breachIntelConnectorTypes();

  for (const type of candidates) {
    const status = await getConnectorStatus(organizationId, type);
    if (status.connected) return type;
  }
  return null;
}

export async function resolveEmailConnector(
  organizationId: string,
): Promise<ConnectorType | null> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  const defaults = parseAgentDefaults(org?.agentDefaultsJson);
  const preferred = defaults.email;

  const candidates = preferred
    ? [preferred, ...emailConnectorTypes().filter((t) => t !== preferred)]
    : emailConnectorTypes();

  for (const type of candidates) {
    const status = await getConnectorStatus(organizationId, type);
    if (status.connected) return type;
  }
  return null;
}

export interface ConnectorHealthSummary {
  discoveryReady: boolean;
  intelligenceReady: boolean;
  emailReady: boolean;
  connectedCount: number;
  blockedSkills: string[];
  missingCategories: string[];
}

export async function getConnectorHealth(
  organizationId: string,
): Promise<ConnectorHealthSummary> {
  const connectors = await listOrgConnectors(organizationId);
  const connected = connectors.filter((c) => c.status === "connected");

  const discoveryReady = connected.some((c) => c.category === "discovery");
  const intelligenceReady = connected.some((c) => c.category === "intelligence");
  const emailReady = connected.some((c) => c.category === "email");

  const missingCategories: string[] = [];
  if (!discoveryReady) missingCategories.push("discovery");
  if (!emailReady) missingCategories.push("email");

  const blockedSkills: string[] = [];
  if (!discoveryReady) blockedSkills.push("discover-public-exposure (live SERP)");
  if (!emailReady) blockedSkills.push("Gmail draft push (optional)");

  return {
    discoveryReady,
    intelligenceReady,
    emailReady,
    connectedCount: connected.length,
    blockedSkills,
    missingCategories,
  };
}

async function mergeCredentialsOnUpdate(
  organizationId: string,
  type: ConnectorType,
  incoming: ConnectorCredentials,
): Promise<ConnectorCredentials> {
  const existing = await db.query.connectorConfigs.findFirst({
    where: and(
      eq(connectorConfigs.organizationId, organizationId),
      eq(connectorConfigs.connectorType, type),
    ),
  });
  if (!existing) return incoming;

  try {
    const stored = JSON.parse(
      decryptValue(existing.encryptedCredentials),
    ) as ConnectorCredentials;
    const merged = { ...stored };
    for (const [key, value] of Object.entries(incoming)) {
      if (value?.trim()) merged[key] = value.trim();
    }
    return merged;
  } catch {
    return incoming;
  }
}

export async function saveOrgConnector(
  organizationId: string,
  userId: string,
  type: ConnectorType,
  credentials: ConnectorCredentials,
  metadata: Record<string, string> = {},
  options: { test?: boolean } = { test: true },
) {
  const def = getConnectorDefinition(type);
  if (!def) throw new Error("UNKNOWN_CONNECTOR");

  const mergedCredentials = await mergeCredentialsOnUpdate(
    organizationId,
    type,
    credentials,
  );

  let testResult = { ok: true, message: "Saved without test" };
  if (options.test !== false) {
    testResult = await testConnectorConnection(type, mergedCredentials);
    if (!testResult.ok) throw new Error(`CONNECTOR_TEST_FAILED:${testResult.message}`);
  }

  const now = new Date().toISOString();
  const encrypted = encryptValue(JSON.stringify(mergedCredentials));
  const maskedPreview = maskCredentials(type, mergedCredentials);
  const existing = await db.query.connectorConfigs.findFirst({
    where: and(
      eq(connectorConfigs.organizationId, organizationId),
      eq(connectorConfigs.connectorType, type),
    ),
  });

  const values = {
    encryptedCredentials: encrypted,
    maskedPreview,
    status: testResult.ok ? "connected" : "error",
    lastTestedAt: now,
    lastError: testResult.ok ? null : testResult.message,
    metadataJson: JSON.stringify(metadata),
    enabled: true,
    updatedAt: now,
  };

  if (existing) {
    await db
      .update(connectorConfigs)
      .set(values)
      .where(eq(connectorConfigs.id, existing.id));
  } else {
    await db.insert(connectorConfigs).values({
      id: uuid(),
      organizationId,
      connectorType: type,
      label: def.name,
      createdAt: now,
      ...values,
    });
  }

  await logAuditEvent({
    organizationId,
    userId,
    eventType: "connector_saved",
    summary: `${def.name} connector saved`,
    detail: { connectorType: type, status: values.status, testMessage: testResult.message },
  });

  return { ok: true, message: testResult.message, status: values.status };
}

export async function testOrgConnector(
  organizationId: string,
  type: ConnectorType,
  credentials?: ConnectorCredentials,
) {
  let creds = credentials;
  if (!creds) {
    const row = await db.query.connectorConfigs.findFirst({
      where: and(
        eq(connectorConfigs.organizationId, organizationId),
        eq(connectorConfigs.connectorType, type),
      ),
    });
    if (!row) throw new Error("CONNECTOR_NOT_FOUND");
    creds = JSON.parse(decryptValue(row.encryptedCredentials)) as ConnectorCredentials;
  } else {
    creds = await mergeCredentialsOnUpdate(organizationId, type, creds);
  }

  const result = await testConnectorConnection(type, creds);
  const now = new Date().toISOString();

  const row = await db.query.connectorConfigs.findFirst({
    where: and(
      eq(connectorConfigs.organizationId, organizationId),
      eq(connectorConfigs.connectorType, type),
    ),
  });
  if (row) {
    await db
      .update(connectorConfigs)
      .set({
        status: result.ok ? "connected" : "error",
        lastTestedAt: now,
        lastError: result.ok ? null : result.message,
        updatedAt: now,
      })
      .where(eq(connectorConfigs.id, row.id));
  }

  return result;
}

export async function removeOrgConnector(
  organizationId: string,
  userId: string,
  type: ConnectorType,
) {
  await db
    .delete(connectorConfigs)
    .where(
      and(
        eq(connectorConfigs.organizationId, organizationId),
        eq(connectorConfigs.connectorType, type),
      ),
    );

  await logAuditEvent({
    organizationId,
    userId,
    eventType: "connector_removed",
    summary: `Connector removed: ${type}`,
    detail: { connectorType: type },
  });

  return { removed: true };
}

export async function updateAgentDefaults(
  organizationId: string,
  userId: string,
  defaults: AgentDefaults,
) {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  const current = parseAgentDefaults(org?.agentDefaultsJson);
  const merged = { ...current, ...defaults };

  if (defaults.ruthlessMode !== undefined) {
    const { applyRuthlessOrgSettings } = await import("@/lib/ruthless/service");
    await applyRuthlessOrgSettings(organizationId, !!merged.ruthlessMode);
  }

  await db
    .update(organizations)
    .set({ agentDefaultsJson: JSON.stringify(merged) })
    .where(eq(organizations.id, organizationId));

  await logAuditEvent({
    organizationId,
    userId,
    eventType: "agent_defaults_updated",
    summary: "Agent default connectors updated",
    detail: merged,
  });

  return merged;
}

export async function getAgentDefaults(organizationId: string): Promise<AgentDefaults> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  return parseAgentDefaults(org?.agentDefaultsJson);
}

export async function resolveIntelligenceConnector(
  organizationId: string,
): Promise<ConnectorType | null> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  const defaults = parseAgentDefaults(org?.agentDefaultsJson);
  const preferred = defaults.intelligence;
  if (!preferred || preferred === "rules_only") return null;

  const candidates = preferred
    ? [preferred, ...CATEGORY_DEFAULT_CONNECTORS.intelligence.filter((t) => t !== preferred)]
    : CATEGORY_DEFAULT_CONNECTORS.intelligence;

  for (const type of candidates) {
    const status = await getConnectorStatus(organizationId, type);
    if (status.connected) return type;
  }
  return null;
}

export function getConnectionHelper(organizationId: string): ConnectionHelper {
  return new ConnectionHelper(organizationId, {
    getOrgConnector: (type) => getOrgConnector(organizationId, type),
    resolveDiscoveryType: () => resolveDiscoveryConnector(organizationId),
    resolveEmailType: () => resolveEmailConnector(organizationId),
    getAgentDefaults: () => getAgentDefaults(organizationId),
    intelligenceTypes: CATEGORY_DEFAULT_CONNECTORS.intelligence,
  });
}

export { getSetupGuide };