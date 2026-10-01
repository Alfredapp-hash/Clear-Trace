import { ConnectorConnectionError } from "./errors";
import {
  resolveIntelligenceConnection,
  type IntelligenceFeature,
  type ResolvedConnection,
} from "./intelligence";
import {
  createGmailDraftMessage,
  polishWithAnthropic,
  polishWithOllama,
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

export type { ResolvedConnection };

export interface ConnectionHelperDeps {
  getOrgConnector: (
    type: ConnectorType,
  ) => Promise<{ credentials: ConnectorCredentials; metadata: Record<string, string> } | null>;
  resolveDiscoveryType: () => Promise<ConnectorType | null>;
  resolveEmailType: () => Promise<ConnectorType | null>;
  getAgentDefaults: () => Promise<AgentDefaults>;
  /** @deprecated unused — intelligence resolution lives in ./intelligence */
  intelligenceTypes?: ConnectorType[];
  isFeatureEnabled?: (feature: IntelligenceFeature) => Promise<boolean>;
}

export class ConnectionHelper {
  constructor(
    private readonly organizationId: string,
    private readonly deps: ConnectionHelperDeps,
  ) {}

  getSetupGuide(type: ConnectorType) {
    return getSetupGuide(type);
  }

  async test(
    type: ConnectorType,
    credentials: ConnectorCredentials,
    metadata: Record<string, string> = {},
  ): Promise<ConnectorTestResult> {
    return testConnectorConnection(type, credentials, metadata);
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
    return resolveIntelligenceConnection({
      getAgentDefaults: this.deps.getAgentDefaults,
      getOrgConnector: this.deps.getOrgConnector,
      isFeatureEnabled: this.deps.isFeatureEnabled,
    });
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
        "No discovery connector configured. Add SerpAPI or Google CSE in Settings.",
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

  /**
   * Polish a draft with the resolved LLM. Never throws and never tries a second
   * provider: any failure returns the original (rules-based) draft.
   */
  async polishDraft(
    subject: string,
    body: string,
    tone: string,
  ): Promise<{ subject: string; body: string; polished: boolean; provider?: ConnectorType }> {
    let connection: ResolvedConnection | null = null;
    try {
      connection = await this.resolveIntelligence();
    } catch {
      connection = null;
    }
    if (!connection) return { subject, body, polished: false };

    const { type, credentials, metadata } = connection;
    let result: { subject: string; body: string } | null = null;
    try {
      switch (type) {
        case "ollama":
          result = await polishWithOllama(credentials, metadata.model, subject, body, tone);
          break;
        case "openai":
          result = await polishWithOpenAI(
            credentials.apiKey,
            metadata.model ?? "gpt-4o-mini",
            subject,
            body,
            tone,
          );
          break;
        case "anthropic":
          result = await polishWithAnthropic(
            credentials.apiKey,
            metadata.model ?? "claude-haiku-4-5",
            subject,
            body,
            tone,
          );
          break;
        case "openrouter":
          result = await polishWithOpenRouter(
            credentials.apiKey,
            metadata.model ?? "openai/gpt-4o-mini",
            subject,
            body,
            tone,
          );
          break;
        default:
          result = null;
      }
    } catch {
      result = null;
    }

    if (result) return { ...result, polished: true, provider: type };
    return { subject, body, polished: false, provider: type };
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