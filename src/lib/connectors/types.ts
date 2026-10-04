export type ConnectorCategory = "discovery" | "intelligence" | "email" | "webhook" | "breach_intel";

export type ConnectorType =
  | "serpapi"
  | "google_cse"
  | "hibp"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "ollama"
  | "apple_intelligence"
  | "gmail"
  | "smtp"
  | "resend"
  | "sendgrid"
  | "postmark"
  | "generic_webhook";

export type ConnectorFieldType = "text" | "password" | "number" | "email";

export interface ConnectorFieldDef {
  key: string;
  label: string;
  type: ConnectorFieldType;
  required?: boolean;
  placeholder?: string;
  helpText?: string;
}

export interface ConnectorDefinition {
  type: ConnectorType;
  name: string;
  category: ConnectorCategory;
  description: string;
  fields: ConnectorFieldDef[];
  metadataFields?: ConnectorFieldDef[];
  docsUrl?: string;
}

export interface ConnectorPublicView {
  type: ConnectorType;
  name: string;
  category: ConnectorCategory;
  description: string;
  fields: ConnectorFieldDef[];
  metadataFields?: ConnectorFieldDef[];
  docsUrl?: string;
  configured: boolean;
  status: "not_configured" | "pending" | "connected" | "error" | "disabled";
  maskedPreview?: string | null;
  lastTestedAt?: string | null;
  lastError?: string | null;
  metadata?: Record<string, string>;
  enabled: boolean;
}

export type ConnectorErrorCode =
  | "missing_credentials"
  | "invalid_credentials"
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "provider_error"
  | "invalid_config"
  | "oauth_incomplete"
  | "unsupported";

export interface ConnectorTestResult {
  ok: boolean;
  message: string;
  detail?: Record<string, unknown>;
  latencyMs?: number;
  errorCode?: ConnectorErrorCode;
}

export interface ConnectorSetupStep {
  order: number;
  title: string;
  body: string;
  copyable?: string;
  link?: string;
}

export interface AgentDefaults {
  discovery?: ConnectorType;
  intelligence?: ConnectorType | "rules_only";
  email?: ConnectorType;
  /** Opt-in: POST case events to generic_webhook when configured */
  webhookDispatch?: boolean;
  /** Opt-in: send removal drafts via Resend/SendGrid/Postmark (not Gmail/SMTP) */
  emailAutoSend?: boolean;
  /** Maximize lawful discovery, broker coverage, and follow-through */
  ruthlessMode?: boolean;
  /** Preferred breach intelligence connector */
  breachIntel?: ConnectorType;
  /** Weekly progress digest email (requires email connector) */
  weeklyDigest?: boolean;
  weeklyDigestEmail?: string;
  /**
   * Keep all LLM work on this machine. When true (the default — `undefined` is
   * treated as true) only a *local* Ollama connector may be used and there is
   * no fallback to any cloud provider.
   */
  llmLocalOnly?: boolean;
}

export type ConnectorCredentials = Record<string, string>;