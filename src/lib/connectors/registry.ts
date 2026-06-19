import type { ConnectorDefinition, ConnectorType } from "./types";

export const CONNECTOR_REGISTRY: ConnectorDefinition[] = [
  {
    type: "serpapi",
    name: "SerpAPI",
    category: "discovery",
    description: "Public web search for exposure discovery (bring your own SerpAPI key).",
    docsUrl: "https://serpapi.com/manage-api-key",
    fields: [
      { key: "apiKey", label: "API key", type: "password", required: true },
    ],
  },
  {
    type: "bing_search",
    name: "Bing Web Search",
    category: "discovery",
    description: "Microsoft Bing Search API for discovery queries.",
    docsUrl: "https://www.microsoft.com/en-us/bing/apis/bing-web-search-api",
    fields: [
      { key: "apiKey", label: "API key", type: "password", required: true },
    ],
  },
  {
    type: "hibp",
    name: "Have I Been Pwned",
    category: "breach_intel",
    description:
      "Check email addresses against known public breach corpora (BYOK HIBP API key). Used by Ruthless breach scans.",
    docsUrl: "https://haveibeenpwned.com/API/Key",
    fields: [{ key: "apiKey", label: "HIBP API key", type: "password", required: true }],
  },
  {
    type: "google_cse",
    name: "Google Custom Search",
    category: "discovery",
    description: "Google Programmable Search Engine for approved queries.",
    docsUrl: "https://developers.google.com/custom-search/v1/overview",
    fields: [
      { key: "apiKey", label: "API key", type: "password", required: true },
      { key: "searchEngineId", label: "Search engine ID (cx)", type: "text", required: true },
    ],
  },
  {
    type: "openai",
    name: "OpenAI",
    category: "intelligence",
    description: "Optional LLM for classification and draft assistance.",
    docsUrl: "https://platform.openai.com/api-keys",
    fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],
    metadataFields: [
      {
        key: "model",
        label: "Default model",
        type: "text",
        placeholder: "gpt-4o-mini",
      },
    ],
  },
  {
    type: "anthropic",
    name: "Anthropic",
    category: "intelligence",
    description: "Optional Claude models for agent reasoning steps.",
    docsUrl: "https://console.anthropic.com/settings/keys",
    fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],
    metadataFields: [
      {
        key: "model",
        label: "Default model",
        type: "text",
        placeholder: "claude-sonnet-4-20250514",
      },
    ],
  },
  {
    type: "openrouter",
    name: "OpenRouter",
    category: "intelligence",
    description: "Route to multiple LLM providers with one API key.",
    docsUrl: "https://openrouter.ai/keys",
    fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],
    metadataFields: [
      {
        key: "model",
        label: "Default model",
        type: "text",
        placeholder: "openai/gpt-4o-mini",
      },
    ],
  },
  {
    type: "gmail",
    name: "Gmail",
    category: "email",
    description: "Google OAuth app credentials for draft/send via the user's Gmail account.",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    fields: [
      { key: "clientId", label: "OAuth client ID", type: "text", required: true },
      { key: "clientSecret", label: "OAuth client secret", type: "password", required: true },
      {
        key: "refreshToken",
        label: "Refresh token (after OAuth)",
        type: "password",
        helpText: "Complete Google OAuth and paste the refresh token.",
      },
    ],
    metadataFields: [
      { key: "fromEmail", label: "Send-as email", type: "email", placeholder: "you@gmail.com" },
    ],
  },
  {
    type: "smtp",
    name: "SMTP",
    category: "email",
    description: "SMTP relay (BYOK). Test on save; optional auto-send when enabled in Agent defaults.",
    fields: [
      { key: "host", label: "Host", type: "text", required: true, placeholder: "smtp.gmail.com" },
      { key: "port", label: "Port", type: "number", required: true, placeholder: "587" },
      { key: "user", label: "Username", type: "text", required: true },
      { key: "password", label: "Password / app password", type: "password", required: true },
    ],
    metadataFields: [
      { key: "fromEmail", label: "From address", type: "email", required: true },
    ],
  },
  {
    type: "resend",
    name: "Resend",
    category: "email",
    description: "Resend API (BYOK). Test on save; optional auto-send when enabled in Agent defaults.",
    docsUrl: "https://resend.com/api-keys",
    fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],
    metadataFields: [
      { key: "fromEmail", label: "From address", type: "email", required: true },
    ],
  },
  {
    type: "sendgrid",
    name: "SendGrid",
    category: "email",
    description: "SendGrid API (BYOK). Test on save; optional auto-send when enabled in Agent defaults.",
    docsUrl: "https://app.sendgrid.com/settings/api_keys",
    fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],
    metadataFields: [
      { key: "fromEmail", label: "From address", type: "email", required: true },
    ],
  },
  {
    type: "postmark",
    name: "Postmark",
    category: "email",
    description: "Postmark server token (BYOK). Test on save; optional auto-send when enabled in Agent defaults.",
    docsUrl: "https://account.postmarkapp.com/servers",
    fields: [{ key: "apiKey", label: "Server token", type: "password", required: true }],
    metadataFields: [
      { key: "fromEmail", label: "From address", type: "email", required: true },
    ],
  },
  {
    type: "generic_webhook",
    name: "Webhook",
    category: "webhook",
    description: "Webhook URL (BYOK). Test on save; optional event dispatch when enabled in Agent defaults.",
    fields: [
      { key: "url", label: "Webhook URL", type: "text", required: true },
      { key: "authHeader", label: "Authorization header", type: "password" },
    ],
  },
];

export function getConnectorDefinition(type: string): ConnectorDefinition | undefined {
  return CONNECTOR_REGISTRY.find((c) => c.type === type);
}

export function listConnectorTypes(): ConnectorType[] {
  return CONNECTOR_REGISTRY.map((c) => c.type);
}

export function connectorsByCategory() {
  const groups: Record<string, ConnectorDefinition[]> = {
    discovery: [],
    intelligence: [],
    email: [],
    webhook: [],
    breach_intel: [],
  };
  for (const def of CONNECTOR_REGISTRY) {
    groups[def.category].push(def);
  }
  return groups;
}