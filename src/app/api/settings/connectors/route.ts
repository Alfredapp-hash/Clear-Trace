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
import type { AgentDefaults, ConnectorCredentials, ConnectorType } from "@/lib/connectors/types";
import { getConnectorDefinition } from "@/lib/connectors/registry";
import { jsonError, jsonOk } from "@/lib/api";
import { enforceRateLimit } from "@/lib/security/enforce-rate-limit";

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

  return jsonOk({ connectors, health, agentDefaults, setupGuides });
}

export async function POST(request: Request) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const limited = await enforceRateLimit(`connectors:${session.userId}`, 40);
  if (limited) return limited;

  const body = await request.json();
  const { action, type, credentials, metadata, skipTest } = body as {
    action?: string;
    type?: ConnectorType;
    credentials?: ConnectorCredentials;
    metadata?: Record<string, string>;
    skipTest?: boolean;
  };

  if (!type || !getConnectorDefinition(type)) {
    return jsonError("Invalid connector type");
  }

  try {
    if (action === "save" && credentials) {
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

    if (action === "test") {
      const result = await testOrgConnector(
        session.organizationId,
        type,
        credentials,
      );
      return jsonOk(result);
    }

    return jsonError("Invalid action");
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg.startsWith("CONNECTOR_TEST_FAILED:")) {
      return jsonError(msg.replace("CONNECTOR_TEST_FAILED:", ""), 400);
    }
    return jsonError(msg, 500);
  }
}

export async function PATCH(request: Request) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const body = await request.json();
  const { agentDefaults } = body as { agentDefaults?: AgentDefaults };
  if (!agentDefaults) return jsonError("agentDefaults required");

  const merged = await updateAgentDefaults(
    session.organizationId,
    session.userId,
    agentDefaults,
  );
  return jsonOk({ agentDefaults: merged });
}

export async function DELETE(request: Request) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const type = new URL(request.url).searchParams.get("type") as ConnectorType | null;
  if (!type || !getConnectorDefinition(type)) {
    return jsonError("Invalid connector type");
  }

  await removeOrgConnector(session.organizationId, session.userId, type);
  return jsonOk({ removed: true });
}