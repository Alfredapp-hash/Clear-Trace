import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import {
  getAgentDefaults,
  getConnectorHealth,
  getSetupGuide,
  listOrgConnectors,
  removeOrgConnector,
  saveOrgConnector,
  testOrgConnector,
  updateAgentDefaults,
} from "@/lib/connectors/service";
import { isOrgAdmin, requireOrgAdminSession } from "@/lib/auth/org-role";
import type { ConnectorType } from "@/lib/connectors/types";
import { getConnectorDefinition, listConnectorTypes } from "@/lib/connectors/registry";
import {
  breachIntelConnectorTypes,
  discoveryConnectorTypes,
  emailConnectorTypes,
} from "@/lib/connectors/requirements";
import { INTELLIGENCE_TYPES } from "@/lib/connectors/connection/intelligence";
import { jsonError, jsonOk } from "@/lib/api";
import { enforceRateLimit } from "@/lib/security/enforce-rate-limit";

const connectorTypeSchema = z
  .string()
  .refine((t) => listConnectorTypes().includes(t as ConnectorType), "Invalid connector type");

function oneOf(types: readonly string[]) {
  return z.string().refine((t) => types.includes(t), "Connector not valid for this category");
}

const agentDefaultsSchema = z
  .object({
    // null clears a preference back to "auto".
    discovery: oneOf(discoveryConnectorTypes()).nullable().optional(),
    intelligence: z
      .union([z.literal("rules_only"), oneOf(INTELLIGENCE_TYPES)])
      .nullable()
      .optional(),
    email: oneOf(emailConnectorTypes()).nullable().optional(),
    breachIntel: oneOf(breachIntelConnectorTypes()).nullable().optional(),
    webhookDispatch: z.boolean().optional(),
    emailAutoSend: z.boolean().optional(),
    ruthlessMode: z.boolean().optional(),
    weeklyDigest: z.boolean().optional(),
    weeklyDigestEmail: z.union([z.email().max(254), z.literal("")]).nullable().optional(),
    llmLocalOnly: z.boolean().optional(),
  })
  .strict();

const stringRecord = z.record(z.string().max(100), z.string().max(4096));

const postSchema = z.object({
  action: z.enum(["save", "test"]),
  type: connectorTypeSchema,
  credentials: stringRecord.optional(),
  metadata: stringRecord.optional(),
  skipTest: z.boolean().optional(),
});

async function requireManager() {
  const auth = await requireOrgAdminSession();
  if (auth.error) return { error: auth.error } as const;
  return { session: auth.session } as const;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function GET() {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const [connectors, health, agentDefaults] = await Promise.all([
    listOrgConnectors(session.organizationId),
    getConnectorHealth(session.organizationId),
    getAgentDefaults(session.organizationId),
  ]);

  const setupGuides = Object.fromEntries(
    connectors.map((c) => [c.type, getSetupGuide(c.type)]),
  );

  return jsonOk({
    connectors,
    health,
    // Surface the effective default: undefined ⇒ local-only ON.
    agentDefaults: { ...agentDefaults, llmLocalOnly: agentDefaults.llmLocalOnly !== false },
    setupGuides,
    canManage: await isOrgAdmin(session.userId, session.organizationId),
  });
}

export async function POST(request: Request) {
  ensureDatabase();
  const auth = await requireManager();
  if ("error" in auth) return auth.error;
  const { session } = auth;

  const limited = await enforceRateLimit(`connectors:${session.userId}`, 40);
  if (limited) return limited;

  const parsed = postSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
  }
  const { action, credentials, metadata, skipTest } = parsed.data;
  const type = parsed.data.type as ConnectorType;
  if (!getConnectorDefinition(type)) return jsonError("Invalid connector type");

  try {
    if (action === "save") {
      if (!credentials) return jsonError("credentials required");
      const result = await saveOrgConnector(
        session.organizationId,
        session.userId,
        type,
        credentials,
        metadata ?? {},
        { test: !skipTest },
      );
      return jsonOk(result);
    }

    const result = await testOrgConnector(
      session.organizationId,
      type,
      credentials,
      metadata,
    );
    return jsonOk(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg.startsWith("CONNECTOR_TEST_FAILED:")) {
      return jsonError(msg.replace("CONNECTOR_TEST_FAILED:", ""), 400);
    }
    if (msg === "CONNECTOR_NOT_FOUND") return jsonError("Connector is not configured", 404);
    return jsonError("Connector request failed", 500);
  }
}

export async function PATCH(request: Request) {
  ensureDatabase();
  const auth = await requireManager();
  if ("error" in auth) return auth.error;
  const { session } = auth;

  const body = (await readJson(request)) as { agentDefaults?: unknown } | null;
  if (!body?.agentDefaults) return jsonError("agentDefaults required");

  const parsed = agentDefaultsSchema.safeParse(body.agentDefaults);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(
      `Invalid agentDefaults${issue?.path.length ? `.${issue.path.join(".")}` : ""}: ${issue?.message ?? "invalid"}`,
      400,
    );
  }
  // Keys present with null / "" clear the stored value (undefined is dropped on save).
  const agentDefaults = Object.fromEntries(
    Object.entries(parsed.data).map(([key, value]) => [
      key,
      value === null || value === "" ? undefined : value,
    ]),
  ) as Parameters<typeof updateAgentDefaults>[2];

  try {
    const merged = await updateAgentDefaults(
      session.organizationId,
      session.userId,
      agentDefaults,
    );
    return jsonOk({ agentDefaults: { ...merged, llmLocalOnly: merged.llmLocalOnly !== false } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "";
    if (msg === "BILLING_UPGRADE_REQUIRED") return jsonError("This option requires the Pro plan", 402);
    return jsonError("Could not save agent defaults", 500);
  }
}

export async function DELETE(request: Request) {
  ensureDatabase();
  const auth = await requireManager();
  if ("error" in auth) return auth.error;
  const { session } = auth;

  const type = new URL(request.url).searchParams.get("type") as ConnectorType | null;
  if (!type || !getConnectorDefinition(type)) {
    return jsonError("Invalid connector type");
  }

  await removeOrgConnector(session.organizationId, session.userId, type);
  return jsonOk({ removed: true });
}
