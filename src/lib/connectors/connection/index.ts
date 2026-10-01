export { ConnectionHelper, type ResolvedConnection, type ConnectionHelperDeps } from "./helper";
export {
  ConnectorConnectionError,
  friendlyProviderMessage,
  type ConnectorErrorCode,
} from "./errors";
export { connectorFetch, type ConnectorHttpResponse } from "./http";
export {
  testConnectorConnection,
  searchWithProvider,
  refreshGmailAccessToken,
  createGmailDraftMessage,
  polishWithOpenAI,
  polishWithOllama,
  buildGmailRawMessage,
  type SerpResult,
} from "./providers";
export {
  resolveIntelligenceConnection,
  isLlmLocalOnly,
  INTELLIGENCE_TYPES,
  type IntelligenceResolverDeps,
} from "./intelligence";
export {
  classifyOllamaBaseUrl,
  getAllowedOllamaOrigins,
  OLLAMA_CLOUD_ORIGIN,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  type OllamaMode,
} from "./ollama-origin";
export { getSetupGuide, CONNECTOR_SETUP_GUIDES, type ConnectorSetupStep } from "./setup-guides";