import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { connectorConfigs, organizations } from "@/lib/db/schema";
import { decryptValue, encryptValue, redactValue } from "@/lib/crypto/encryption";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireBillingFeature } from "@/lib/billing/service";
import { assertSafeUrl } from "@/lib/tools/safe-fetch";
import { CONNECTOR_REGISTRY, getConnectorDefinition } from "./registry";
import { testConnectorConnection } from "./connection/providers";
import { ConnectionHelper } from "./connection/helper";
import {
  resolveIntelligenceConnection,
  type IntelligenceFeature,
  type IntelligenceResolverDeps,
} from "./connection/intelligence";
import { classifyOllamaBaseUrl } from "./connection/ollama-origin";
import { classifyAppleBridgeUrl } from "./connection/apple-bridge";
import { getSetupGuide } from "./connection/setup-guides";
import {
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
  const allowed = discoveryConnectorTypes();
  // Ignore stale / retired preferences (e.g. the removed bing_search).
  const preferred = defaults.discovery && allowed.includes(defaults.discovery) ? defaults.discovery : undefined;

  const candidates = preferred
    ? [preferred, ...allowed.filter((t) => t !== preferred)]
    : allowed;

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
  const allowed = breachIntelConnectorTypes();
  // Ignore stale / retired preferences (e.g. the removed bing_search).
  const preferred = defaults.breachIntel && allowed.includes(defaults.breachIntel) ? defaults.breachIntel : undefined;

  const candidates = preferred
    ? [preferred, ...allowed.filter((t) => t !== preferred)]
    : allowed;

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
  const allowed = emailConnectorTypes();
  // Ignore stale / retired preferences (e.g. the removed bing_search).
  const preferred = defaults.email && allowed.includes(defaults.email) ? defaults.email : undefined;

  const candidates = preferred
    ? [preferred, ...allowed.filter((t) => t !== preferred)]
    : allowed;

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

/** Fields that decide *where* credentials are sent. */
export const DESTINATION_FIELDS = ["url", "host", "baseUrl", "port"] as const;

function trimmedNonEmpty(credentials: ConnectorCredentials): ConnectorCredentials {
  const out: ConnectorCredentials = {};
  for (const [key, value] of Object.entries(credentials ?? {})) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

/**
 * Merge incoming form values onto stored credentials ("leave blank to keep").
 * If any destination field changes, stored *secret* fields are discarded so a
 * saved key/password can never be replayed against a new destination; they
 * must be re-entered in the same request.
 */
export function mergeStoredCredentials(
  type: ConnectorType,
  stored: ConnectorCredentials | null,
  incoming: ConnectorCredentials,
): { credentials: ConnectorCredentials; destinationChanged: boolean } {
  const fresh = trimmedNonEmpty(incoming);
  if (!stored) return { credentials: fresh, destinationChanged: false };

  const destinationChanged = DESTINATION_FIELDS.some(
    (key) => fresh[key] !== undefined && fresh[key] !== (stored[key] ?? "").trim(),
  );
  if (!destinationChanged) return { credentials: { ...stored, ...fresh }, destinationChanged };

  const def = getConnectorDefinition(type);
  const secretKeys = new Set(
    (def?.fields ?? []).filter((f) => f.type === "password").map((f) => f.key),
  );
  const kept: ConnectorCredentials = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!secretKeys.has(key)) kept[key] = value;
  }
  const merged = { ...kept, ...fresh };

  const missing = (def?.fields ?? []).filter(
    (f) => f.type === "password" && f.required && !merged[f.key],
  );
  if (missing.length) {
    throw new Error(
      `CONNECTOR_TEST_FAILED:Destination changed — re-enter ${missing.map((f) => f.label).join(", ")}`,
    );
  }
  return { credentials: merged, destinationChanged };
}

async function loadStoredCredentials(
  organizationId: string,
  type: ConnectorType,
): Promise<ConnectorCredentials | null> {
  const existing = await db.query.connectorConfigs.findFirst({
    where: and(
      eq(connectorConfigs.organizationId, organizationId),
      eq(connectorConfigs.connectorType, type),
    ),
  });
  if (!existing) return null;
  try {
    return JSON.parse(decryptValue(existing.encryptedCredentials)) as ConnectorCredentials;
  } catch {
    return null;
  }
}

async function mergeCredentialsOnUpdate(
  organizationId: string,
  type: ConnectorType,
  incoming: ConnectorCredentials,
): Promise<ConnectorCredentials> {
  const stored = await loadStoredCredentials(organizationId, type);
  return mergeStoredCredentials(type, stored, incoming).credentials;
}

async function orgHasFeature(organizationId: string, feature: IntelligenceFeature) {
  try {
    await requireBillingFeature(organizationId, feature);
    return true;
  } catch {
    return false;
  }
}

/** Connector-specific policy checks that apply whether or not a live test runs. */
async function assertConnectorPolicy(
  organizationId: string,
  type: ConnectorType,
  credentials: ConnectorCredentials,
) {
  if (type === "ollama") {
    const endpoint = classifyOllamaBaseUrl(credentials.baseUrl);
    if (!endpoint) {
      throw new Error(
        "CONNECTOR_TEST_FAILED:Ollama URL must be https://ollama.com or a local origin listed in OLLAMA_ALLOWED_ORIGINS",
      );
    }
    if (endpoint.mode === "cloud") {
      if (!credentials.apiKey) {
        throw new Error("CONNECTOR_TEST_FAILED:An API key is required for Ollama Cloud");
      }
      if (!(await orgHasFeature(organizationId, "ollama_cloud"))) {
        throw new Error("CONNECTOR_TEST_FAILED:Ollama Cloud requires the Pro plan");
      }
    }
  }
  if (type === "apple_intelligence" && !classifyAppleBridgeUrl(credentials.baseUrl)) {
    throw new Error(
      "CONNECTOR_TEST_FAILED:Apple bridge URL must be a local origin listed in APPLE_BRIDGE_ALLOWED_ORIGINS",
    );
  }
  if (type === "generic_webhook" && credentials.url) {
    try {
      await assertSafeUrl(credentials.url);
    } catch {
      throw new Error("CONNECTOR_TEST_FAILED:Webhook URL must not target private or internal hosts");
    }
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
  await assertConnectorPolicy(organizationId, type, mergedCredentials);
  if (type === "ollama") {
    // Server-derived, never trusted from the client: drives the Local/Cloud badge.
    const endpoint = classifyOllamaBaseUrl(mergedCredentials.baseUrl);
    metadata = { ...metadata, mode: endpoint?.mode ?? "local" };
  }
  if (type === "apple_intelligence") metadata = { ...metadata, mode: "local" };

  let testResult = { ok: true, message: "Saved without test" };
  if (options.test !== false) {
    testResult = await testConnectorConnection(type, mergedCredentials, metadata);
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
  metadata?: Record<string, string>,
) {
  const row = await db.query.connectorConfigs.findFirst({
    where: and(
      eq(connectorConfigs.organizationId, organizationId),
      eq(connectorConfigs.connectorType, type),
    ),
  });

  let creds: ConnectorCredentials;
  const hasIncoming = !!credentials && Object.values(credentials).some((v) => v?.trim?.());
  if (!hasIncoming) {
    if (!row) throw new Error("CONNECTOR_NOT_FOUND");
    creds = JSON.parse(decryptValue(row.encryptedCredentials)) as ConnectorCredentials;
  } else {
    creds = await mergeCredentialsOnUpdate(organizationId, type, credentials!);
  }
  await assertConnectorPolicy(organizationId, type, creds);

  const meta = metadata && Object.keys(metadata).length
    ? metadata
    : parseMetadata(row?.metadataJson ?? null);
  const result = await testConnectorConnection(type, creds, meta);
  const now = new Date().toISOString();

  // Only record status when testing what is actually stored.
  if (row && !hasIncoming) {
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

function intelligenceDeps(organizationId: string): IntelligenceResolverDeps {
  return {
    getAgentDefaults: () => getAgentDefaults(organizationId),
    getOrgConnector: (type) => getOrgConnector(organizationId, type),
    isFeatureEnabled: (feature) => orgHasFeature(organizationId, feature),
  };
}

/** Same resolution as ConnectionHelper.resolveIntelligence() (shared implementation). */
export async function resolveIntelligenceConnector(
  organizationId: string,
): Promise<ConnectorType | null> {
  const connection = await resolveIntelligenceConnection(intelligenceDeps(organizationId));
  return connection?.type ?? null;
}

export function getConnectionHelper(organizationId: string): ConnectionHelper {
  return new ConnectionHelper(organizationId, {
    getOrgConnector: (type) => getOrgConnector(organizationId, type),
    resolveDiscoveryType: () => resolveDiscoveryConnector(organizationId),
    resolveEmailType: () => resolveEmailConnector(organizationId),
    getAgentDefaults: () => getAgentDefaults(organizationId),
    isFeatureEnabled: (feature) => orgHasFeature(organizationId, feature),
  });
}

export { getSetupGuide };