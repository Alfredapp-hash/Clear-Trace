import type { ConnectorType } from "./types";

export const SKILL_CONNECTOR_REQUIREMENTS: Record<
  string,
  { required: ConnectorType[]; optional: ConnectorType[] }
> = {
  "discover-public-exposure": {
    required: [],
    optional: ["serpapi", "google_cse"],
  },
  "draft-removal-request": {
    required: [],
    optional: ["ollama", "openai", "anthropic", "openrouter"],
  },
  "follow-up-policy": {
    required: [],
    optional: ["gmail", "smtp", "resend", "sendgrid", "postmark"],
  },
  "compliance-verify-draft": {
    required: [],
    optional: ["ollama", "openai", "anthropic", "openrouter"],
  },
  "batch-remediation": {
    required: [],
    optional: ["ollama", "openai", "anthropic", "openrouter"],
  },
  "connector-readiness-check": {
    required: [],
    optional: ["serpapi", "google_cse", "ollama", "openai", "gmail"],
  },
};

export const CATEGORY_DEFAULT_CONNECTORS: Record<string, ConnectorType[]> = {
  discovery: ["serpapi", "google_cse"],
  intelligence: ["ollama", "openai", "anthropic", "openrouter"],
  email: ["gmail", "smtp", "resend", "sendgrid", "postmark"],
  breach_intel: ["hibp"],
};

export function discoveryConnectorTypes(): ConnectorType[] {
  return CATEGORY_DEFAULT_CONNECTORS.discovery;
}

export function emailConnectorTypes(): ConnectorType[] {
  return CATEGORY_DEFAULT_CONNECTORS.email;
}

export function breachIntelConnectorTypes(): ConnectorType[] {
  return CATEGORY_DEFAULT_CONNECTORS.breach_intel;
}