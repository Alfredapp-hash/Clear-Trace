import type { ConnectorType } from "../types";

export interface ConnectorSetupStep {
  order: number;
  title: string;
  body: string;
  copyable?: string;
  link?: string;
}

export const CONNECTOR_SETUP_GUIDES: Record<ConnectorType, ConnectorSetupStep[]> = {
  serpapi: [
    {
      order: 1,
      title: "Create a SerpAPI account",
      body: "Sign up at serpapi.com and open the API key dashboard.",
      link: "https://serpapi.com/manage-api-key",
    },
    {
      order: 2,
      title: "Copy your API key",
      body: "Paste the key below. ClearTrace stores it encrypted — only a redacted preview is shown.",
    },
    {
      order: 3,
      title: "Save & test",
      body: "Click Save & test. A live account check confirms the key before discovery runs.",
    },
  ],
  google_cse: [
    {
      order: 1,
      title: "Enable Custom Search API",
      body: "In Google Cloud Console, enable Custom Search API and create an API key.",
      link: "https://console.cloud.google.com/apis/library/customsearch.googleapis.com",
    },
    {
      order: 2,
      title: "Create a Programmable Search Engine",
      body: "Get your Search engine ID (cx) from programmablesearchengine.google.com.",
      link: "https://programmablesearchengine.google.com/controlpanel/all",
    },
    {
      order: 3,
      title: "Enter API key + cx",
      body: "Both fields are required. Test runs a single-result search query.",
    },
  ],
  hibp: [
    {
      order: 1,
      title: "Purchase an HIBP API key",
      body: "Sign up at haveibeenpwned.com and purchase an API key for breach lookups.",
      link: "https://haveibeenpwned.com/API/Key",
    },
    {
      order: 2,
      title: "Paste your API key",
      body: "ClearTrace uses the key only for email breach scans on cases with breach_intel scope enabled.",
    },
    {
      order: 3,
      title: "Save & test",
      body: "Test verifies the key against the HIBP API. Without a key, breach scans run in demo mode with synthetic data.",
    },
  ],
  openai: [
    {
      order: 1,
      title: "Create an OpenAI API key",
      body: "Keys start with sk-. Store billing limits in your OpenAI dashboard.",
      link: "https://platform.openai.com/api-keys",
    },
    {
      order: 2,
      title: "Set default model (optional)",
      body: "gpt-4o-mini is recommended for draft polish. Leave blank to use the default.",
      copyable: "gpt-4o-mini",
    },
  ],
  anthropic: [
    {
      order: 1,
      title: "Create an Anthropic API key",
      body: "Keys start with sk-ant-. Used for optional classification and draft assist.",
      link: "https://console.anthropic.com/settings/keys",
    },
  ],
  openrouter: [
    {
      order: 1,
      title: "Create an OpenRouter key",
      body: "One key routes to multiple models. Set your preferred model in metadata.",
      link: "https://openrouter.ai/keys",
      copyable: "openai/gpt-4o-mini",
    },
  ],
  ollama: [
    {
      order: 1,
      title: "Install Ollama and pull a model",
      body: "Install Ollama on this machine, then pull the default model. Drafts are polished locally — personal details never leave this machine.",
      copyable: "ollama pull qwen3:8b",
      link: "https://ollama.com/download",
    },
    {
      order: 2,
      title: "Point ClearTrace at it",
      body: "Leave Server URL blank for http://localhost:11434. In Docker use http://host.docker.internal:11434. Other local origins must be added to OLLAMA_ALLOWED_ORIGINS.",
    },
    {
      order: 3,
      title: "Test, then pick a model",
      body: "Save & test lists installed models. Choose one, then select Ollama as the Intelligence default.",
    },
    {
      order: 4,
      title: "Optional: Ollama Cloud (Pro)",
      body: "Set Server URL to https://ollama.com and paste an API key. Cloud mode sends draft text — including personal details — to ollama.com, and requires turning off Local-only AI.",
      link: "https://ollama.com/settings/keys",
    },
  ],
  gmail: [
    {
      order: 1,
      title: "Google Cloud OAuth app",
      body: "Create OAuth 2.0 credentials (Desktop or Web) with Gmail API enabled.",
      link: "https://console.cloud.google.com/apis/credentials",
    },
    {
      order: 2,
      title: "OAuth consent + scopes",
      body: "Add scope https://www.googleapis.com/auth/gmail.compose and complete consent screen.",
      copyable: "https://www.googleapis.com/auth/gmail.compose",
    },
    {
      order: 3,
      title: "Obtain refresh token",
      body: "Run Google OAuth flow offline and paste the refresh token. Save & test verifies token refresh.",
    },
  ],
  smtp: [
    {
      order: 1,
      title: "SMTP relay credentials",
      body: "Use an app password or provider SMTP credentials (Gmail, Mailgun, etc.).",
    },
    {
      order: 2,
      title: "From address",
      body: "Set the From address in metadata. Test checks host reachability on the port.",
    },
  ],
  resend: [
    {
      order: 1,
      title: "Resend API key",
      body: "Create a key at resend.com. Verify your sending domain in Resend first.",
      link: "https://resend.com/api-keys",
    },
  ],
  sendgrid: [
    {
      order: 1,
      title: "SendGrid API key",
      body: "Create a restricted key with Mail Send permission.",
      link: "https://app.sendgrid.com/settings/api_keys",
    },
  ],
  postmark: [
    {
      order: 1,
      title: "Postmark server token",
      body: "Copy the server token from your Postmark server settings.",
      link: "https://account.postmarkapp.com/servers",
    },
  ],
  generic_webhook: [
    {
      order: 1,
      title: "Webhook endpoint",
      body: "HTTPS URL that accepts POST JSON. Optional Authorization header for your automation.",
    },
    {
      order: 2,
      title: "Test delivery",
      body: "Save & test sends a small ping payload. Your endpoint should return 2xx.",
    },
  ],
};

export function getSetupGuide(type: ConnectorType): ConnectorSetupStep[] {
  return CONNECTOR_SETUP_GUIDES[type] ?? [];
}