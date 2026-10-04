import { describe, expect, it, vi } from "vitest";
import { resolveIntelligenceConnection, type IntelligenceResolverDeps } from "./intelligence";
import { ConnectionHelper } from "./helper";
import type { AgentDefaults, ConnectorCredentials, ConnectorType } from "../types";

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    polishWithOllama: vi.fn(),
    polishWithOpenAI: vi.fn(),
    polishWithAnthropic: vi.fn(),
    polishWithOpenRouter: vi.fn(),
  };
});

import {
  polishWithAnthropic,
  polishWithOllama,
  polishWithOpenAI,
  polishWithOpenRouter,
} from "./providers";

type Store = Partial<Record<ConnectorType, ConnectorCredentials>>;

const LOCAL_OLLAMA = { baseUrl: "http://localhost:11434" };
const CLOUD_OLLAMA = { baseUrl: "https://ollama.com", apiKey: "k" };
const ALL_CLOUD: Store = {
  openai: { apiKey: "sk-openai" },
  anthropic: { apiKey: "sk-ant-x" },
  openrouter: { apiKey: "sk-or" },
};

function deps(
  defaults: AgentDefaults,
  store: Store,
  entitled = true,
): IntelligenceResolverDeps & { getOrgConnector: ReturnType<typeof vi.fn> } {
  return {
    getAgentDefaults: async () => defaults,
    getOrgConnector: vi.fn(async (type: ConnectorType) =>
      store[type] ? { credentials: store[type]!, metadata: {} } : null,
    ),
    isFeatureEnabled: async () => entitled,
  };
}

describe("intelligence resolver — local-only (default)", () => {
  it.each(["openai", "anthropic", "openrouter"] as const)(
    "refuses %s even when connected (llmLocalOnly undefined ⇒ true)",
    async (type) => {
      const d = deps({ intelligence: type }, { ...ALL_CLOUD, ollama: LOCAL_OLLAMA });
      expect(await resolveIntelligenceConnection(d)).toBeNull();
    },
  );

  it("refuses Ollama Cloud", async () => {
    const d = deps({ intelligence: "ollama", llmLocalOnly: true }, { ollama: CLOUD_OLLAMA });
    expect(await resolveIntelligenceConnection(d)).toBeNull();
  });

  it("uses a local Ollama", async () => {
    const d = deps({ intelligence: "ollama" }, { ollama: LOCAL_OLLAMA, ...ALL_CLOUD });
    expect((await resolveIntelligenceConnection(d))?.type).toBe("ollama");
  });

  it("does not fall back to any cloud provider when local Ollama is missing", async () => {
    const d = deps({ intelligence: "ollama" }, ALL_CLOUD);
    expect(await resolveIntelligenceConnection(d)).toBeNull();
    const looked = d.getOrgConnector.mock.calls.map((c) => c[0]);
    expect(looked).toEqual(["ollama"]);
  });

  it("returns null for explicit rules_only", async () => {
    expect(
      await resolveIntelligenceConnection(
        deps({ intelligence: "rules_only" }, { ollama: LOCAL_OLLAMA }),
      ),
    ).toBeNull();
  });

  it("unset preference auto-uses a connected local Ollama (and nothing else)", async () => {
    const r = await resolveIntelligenceConnection(deps({}, { ollama: LOCAL_OLLAMA }));
    expect(r?.type).toBe("ollama");
    expect(await resolveIntelligenceConnection(deps({}, {}))).toBeNull();
  });
});

describe("intelligence resolver — local-only off", () => {
  it("uses the preferred connected cloud provider", async () => {
    const d = deps({ intelligence: "anthropic", llmLocalOnly: false }, ALL_CLOUD);
    expect((await resolveIntelligenceConnection(d))?.type).toBe("anthropic");
  });

  it("never hops to a different cloud provider when the preferred one is not connected", async () => {
    const d = deps(
      { intelligence: "openai", llmLocalOnly: false },
      { anthropic: ALL_CLOUD.anthropic, openrouter: ALL_CLOUD.openrouter },
    );
    expect(await resolveIntelligenceConnection(d)).toBeNull();
    const looked = d.getOrgConnector.mock.calls.map((c) => c[0]);
    expect(looked).not.toContain("anthropic");
    expect(looked).not.toContain("openrouter");
  });

  it("may fall back only to a connected local Ollama", async () => {
    const d = deps(
      { intelligence: "openai", llmLocalOnly: false },
      { anthropic: ALL_CLOUD.anthropic, ollama: LOCAL_OLLAMA },
    );
    expect((await resolveIntelligenceConnection(d))?.type).toBe("ollama");
  });

  it("allows Ollama Cloud only with the ollama_cloud entitlement", async () => {
    expect(
      (await resolveIntelligenceConnection(
        deps({ intelligence: "ollama", llmLocalOnly: false }, { ollama: CLOUD_OLLAMA }, true),
      ))?.type,
    ).toBe("ollama");
    expect(
      await resolveIntelligenceConnection(
        deps({ intelligence: "ollama", llmLocalOnly: false }, { ollama: CLOUD_OLLAMA }, false),
      ),
    ).toBeNull();
  });

  it("refuses an Ollama connector whose origin is not allow-listed", async () => {
    const d = deps(
      { intelligence: "ollama", llmLocalOnly: false },
      { ollama: { baseUrl: "http://10.9.9.9:11434" } },
    );
    expect(await resolveIntelligenceConnection(d)).toBeNull();
  });
});

describe("ConnectionHelper.polishDraft", () => {
  function helper(defaults: AgentDefaults, store: Store) {
    const d = deps(defaults, store);
    return new ConnectionHelper("org-1", {
      getOrgConnector: d.getOrgConnector,
      getAgentDefaults: d.getAgentDefaults,
      isFeatureEnabled: d.isFeatureEnabled,
      resolveDiscoveryType: async () => null,
      resolveEmailType: async () => null,
    });
  }

  it("returns the unpolished draft when the provider throws — and tries no other provider", async () => {
    vi.mocked(polishWithOpenAI).mockRejectedValueOnce(new Error("503"));
    const h = helper({ intelligence: "openai", llmLocalOnly: false }, ALL_CLOUD);
    const out = await h.polishDraft("Subj", "Body", "factual");
    expect(out).toMatchObject({ subject: "Subj", body: "Body", polished: false });
    expect(polishWithAnthropic).not.toHaveBeenCalled();
    expect(polishWithOpenRouter).not.toHaveBeenCalled();
  });

  it("polishes with local Ollama in local-only mode", async () => {
    vi.mocked(polishWithOllama).mockResolvedValueOnce({ subject: "S2", body: "B2" });
    const h = helper({ intelligence: "ollama" }, { ollama: LOCAL_OLLAMA, ...ALL_CLOUD });
    const out = await h.polishDraft("S", "B", "firm");
    expect(out).toEqual({ subject: "S2", body: "B2", polished: true, provider: "ollama" });
  });

  it("stays unpolished when local Ollama is unavailable (no cloud fallback)", async () => {
    vi.mocked(polishWithOllama).mockResolvedValueOnce(null);
    vi.mocked(polishWithOpenAI).mockClear();
    const h = helper({ intelligence: "ollama" }, { ollama: LOCAL_OLLAMA, ...ALL_CLOUD });
    const out = await h.polishDraft("S", "B", "firm");
    expect(out.polished).toBe(false);
    expect(polishWithOpenAI).not.toHaveBeenCalled();
  });
});

describe("intelligence resolver — Apple Intelligence bridge", () => {
  const APPLE = { baseUrl: "http://127.0.0.1:11435" };
  const APPLE_BAD = { baseUrl: "http://10.0.0.5:11435" };

  it("is allowed under local-only when preferred", async () => {
    const r = await resolveIntelligenceConnection(
      deps({ intelligence: "apple_intelligence" }, { ...ALL_CLOUD, apple_intelligence: APPLE }),
    );
    expect(r?.type).toBe("apple_intelligence");
  });

  it("is refused when its URL is not on the bridge allow-list", async () => {
    expect(
      await resolveIntelligenceConnection(
        deps({ intelligence: "apple_intelligence" }, { apple_intelligence: APPLE_BAD }),
      ),
    ).toBeNull();
  });

  it("auto mode prefers local Ollama, then falls back to the Apple bridge", async () => {
    const both = await resolveIntelligenceConnection(
      deps({}, { ollama: LOCAL_OLLAMA, apple_intelligence: APPLE }),
    );
    expect(both?.type).toBe("ollama");
    const appleOnly = await resolveIntelligenceConnection(deps({}, { apple_intelligence: APPLE }));
    expect(appleOnly?.type).toBe("apple_intelligence");
  });

  it("a disconnected cloud preference falls back only to a local provider", async () => {
    const r = await resolveIntelligenceConnection(
      deps({ intelligence: "openai", llmLocalOnly: false }, { apple_intelligence: APPLE }),
    );
    expect(r?.type).toBe("apple_intelligence");
  });
});
