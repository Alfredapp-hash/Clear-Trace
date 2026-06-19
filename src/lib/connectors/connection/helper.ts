import { ConnectorConnectionError } from "./errors";
import {
  createGmailDraftMessage,
  polishWithAnthropic,
  polishWithOpenAI,
  polishWithOpenRouter,
  searchWithProvider,
  testConnectorConnection,
  type SerpResult,
} from "./providers";
import { getSetupGuide } from "./setup-guides";
import type {
  AgentDefaults,
  ConnectorCredentials,
  ConnectorTestResult,
  ConnectorType,
} from "../types";

export interface ResolvedConnection {
  type: ConnectorType;
  credentials: ConnectorCredentials;
  metadata: Record<string, string>;
}

export interface ConnectionHelperDeps {
  getOrgConnector: (
    type: ConnectorType,
  ) => Promise<{ credentials: ConnectorCredentials; metadata: Record<string, string> } | null>;
  resolveDiscoveryType: () => Promise<ConnectorType | null>;
  resolveEmailType: () => Promise<ConnectorType | null>;
  getAgentDefaults: () => Promise<AgentDefaults>;
  intelligenceTypes: ConnectorType[];
}

export class ConnectionHelper {
  constructor(
    private readonly organizationId: string,
    private readonly deps: ConnectionHelperDeps,
  ) {}

  getSetupGuide(type: ConnectorType) {
    return getSetupGuide(type);
  }

  async test(type: ConnectorType, credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
    return testConnectorConnection(type, credentials);
  }

  async require(type: ConnectorType): Promise<ResolvedConnection> {
    const connector = await this.deps.getOrgConnector(type);
    if (!connector) {
      throw new ConnectorConnectionError(
        type,
        "missing_credentials",
        `Connector "${type}" is not connected. Add it in Settings.`,
      );
    }
    return {
      type,
      credentials: connector.credentials,
      metadata: connector.metadata,
    };
  }

  async resolveDiscovery(): Promise<ResolvedConnection | null> {
    const type = await this.deps.resolveDiscoveryType();
    if (!type) return null;
    return this.require(type);
  }

  async resolveEmail(): Promise<ResolvedConnection | null> {
    const type = await this.deps.resolveEmailType();
    if (!type) return null;
    return this.require(type);
  }

  async resolveIntelligence(): Promise<ResolvedConnection | null> {
    const defaults = await this.deps.getAgentDefaults();
    const preferred = defaults.intelligence;
    if (!preferred || preferred === "rules_only") return null;

    const candidates = preferred
      ? [preferred, ...this.deps.intelligenceTypes.filter((t) => t !== preferred)]
      : this.deps.intelligenceTypes;

    for (const type of candidates) {
      try {
        return await this.require(type);
      } catch {
        continue;
      }
    }
    return null;
  }

  async runDiscoverySearch(queries: string[]): Promise<{
    results: SerpResult[];
    connectorType: ConnectorType;
  }> {
    const connection = await this.resolveDiscovery();
    if (!connection) {
      throw new ConnectorConnectionError(
        "serpapi",
        "missing_credentials",
        "No discovery connector configured. Add SerpAPI, Bing, or Google CSE in Settings.",
      );
    }

    const results: SerpResult[] = [];
    for (const query of queries.slice(0, 10)) {
      const batch = await searchWithProvider(
        connection.type,
        connection.credentials,
        query,
      );
      results.push(...batch);
    }

    const seen = new Set<string>();
    const deduped = results.filter((r) => {
      if (!r.link || seen.has(r.link)) return false;
      seen.add(r.link);
      return true;
    });

    return { results: deduped, connectorType: connection.type };
  }

  async polishDraft(
    subject: string,
    body: string,
    tone: string,
  ): Promise<{ subject: string; body: string; polished: boolean; provider?: ConnectorType }> {
    const connection = await this.resolveIntelligence();
    if (!connection) return { subject, body, polished: false };

    if (connection.type === "openai") {
      const result = await polishWithOpenAI(
        connection.credentials.apiKey,
        connection.metadata.model ?? "gpt-4o-mini",
        subject,
        body,
        tone,
      );
      if (result) return { ...result, polished: true, provider: "openai" };
    }

    if (connection.type === "anthropic") {
      const result = await polishWithAnthropic(
        connection.credentials.apiKey,
        connection.metadata.model ?? "claude-haiku-4-5-20251001",
        subject,
        body,
        tone,
      );
      if (result) return { ...result, polished: true, provider: "anthropic" };
    }

    if (connection.type === "openrouter") {
      const result = await polishWithOpenRouter(
        connection.credentials.apiKey,
        connection.metadata.model ?? "openai/gpt-4o-mini",
        subject,
        body,
        tone,
      );
      if (result) return { ...result, polished: true, provider: "openrouter" };
    }

    return { subject, body, polished: false, provider: connection.type };
  }

  async pushGmailDraft(message: {
    subject: string;
    body: string;
    to: string;
    from?: string;
  }): Promise<{ draftId: string; message: string }> {
    const connection = await this.require("gmail");
    const { draftId } = await createGmailDraftMessage(
      connection.credentials,
      connection.metadata,
      message,
    );
    return { draftId, message: "Draft created in your Gmail account" };
  }
}