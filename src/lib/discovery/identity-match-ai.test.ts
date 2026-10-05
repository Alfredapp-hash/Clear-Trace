import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/connectors/connection/http", () => ({
  connectorFetch: vi.fn(async () => ({ ok: true, status: 200, data: {}, latencyMs: 1 })),
}));

import { connectorFetch } from "@/lib/connectors/connection/http";
import type { AgentDefaults, ConnectorCredentials, ConnectorType } from "@/lib/connectors/types";
import {
  MATCHER_LOCAL_AI,
  MATCHER_RULES,
  callLocalModel,
  createIdentityAiAssist,
  parseAiResponse,
  type LocalModelCall,
} from "./identity-match-ai";
import type { IdentityMatchResult } from "./identity-match";

type Store = Partial<Record<ConnectorType, ConnectorCredentials>>;

function deps(defaults: AgentDefaults, store: Store) {
  return {
    getAgentDefaults: async () => defaults,
    getOrgConnector: async (type: ConnectorType) =>
      store[type] ? { credentials: store[type]!, metadata: {} } : null,
  };
}

const LOCAL = { ollama: { baseUrl: "http://localhost:11434" } };
const CLAIMS = [
  { claimType: "full_name", value: "Jane Q Testperson" },
  { claimType: "birth_year", value: "1991" },
];
const BORDERLINE: IdentityMatchResult = { score: 0.55, corroborating: ["full_name", "city_state"], conflicting: [] };

describe("local AI identity assist", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(connectorFetch).mockClear();
  });

  it("a cloud Ollama configured → no model call, rule result with matcher:rules", async () => {
    const assist = createIdentityAiAssist({
      deps: deps(
        { intelligence: "ollama", llmLocalOnly: false },
        { ollama: { baseUrl: "https://ollama.com", apiKey: "k" }, openai: { apiKey: "sk" } },
      ),
    });
    const r = await assist.refine("Jane Q Testperson", CLAIMS, BORDERLINE);
    expect(connectorFetch).not.toHaveBeenCalled();
    expect(assist.calls).toBe(0);
    expect(r.score).toBe(0.55);
    expect(r.corroborating).toContain(MATCHER_RULES);
  });

  it("local 'same' → +0.1, matcher:local_ai, and never a confirmed status", async () => {
    const callModel: LocalModelCall = vi.fn(async () => '{"verdict":"same","factors":["birth_year","ssn_guess"]}');
    const assist = createIdentityAiAssist({ deps: deps({}, LOCAL), callModel });
    const r = await assist.refine("Jane Q Testperson, age 35", CLAIMS, BORDERLINE);
    expect(r.score).toBe(0.65);
    expect(r.corroborating).toEqual(["full_name", "city_state", "birth_year", MATCHER_LOCAL_AI]);
    expect(Object.keys(r)).not.toContain("matchStatus");
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("local 'different' → −0.1 and the model's factors go to conflicting", async () => {
    const callModel: LocalModelCall = async () => '{"verdict":"different","factors":["birth_year"]}';
    const assist = createIdentityAiAssist({ deps: deps({}, LOCAL), callModel });
    const r = await assist.refine("x", CLAIMS, BORDERLINE);
    expect(r.score).toBe(0.45);
    expect(r.conflicting).toEqual(["birth_year"]);
  });

  it("a local timeout → the rule score with matcher:rules", async () => {
    vi.useFakeTimers();
    const callModel: LocalModelCall = () => new Promise(() => {}); // never answers
    const assist = createIdentityAiAssist({ deps: deps({}, LOCAL), callModel });
    const pending = assist.refine("x", CLAIMS, BORDERLINE);
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await pending;
    expect(r).toEqual({ ...BORDERLINE, corroborating: [...BORDERLINE.corroborating, MATCHER_RULES] });
  });

  it.each(["not json", '{"verdict":"maybe","factors":[]}', '{"verdict":"same"}', '["same"]', ""])(
    "garbage output %j → the rule score with matcher:rules",
    async (raw) => {
      const assist = createIdentityAiAssist({ deps: deps({}, LOCAL), callModel: async () => raw });
      const r = await assist.refine("x", CLAIMS, BORDERLINE);
      expect(r.score).toBe(0.55);
      expect(r.corroborating.at(-1)).toBe(MATCHER_RULES);
    },
  );

  it("only borderline [0.4, 0.7) candidates are sent", async () => {
    const callModel = vi.fn<LocalModelCall>(async () => '{"verdict":"same","factors":[]}');
    const assist = createIdentityAiAssist({ deps: deps({}, LOCAL), callModel });
    await assist.refine("x", CLAIMS, { score: 0.7, corroborating: [], conflicting: [] });
    await assist.refine("x", CLAIMS, { score: 0.39, corroborating: [], conflicting: [] });
    expect(callModel).not.toHaveBeenCalled();
    await assist.refine("x", CLAIMS, { score: 0.4, corroborating: [], conflicting: [] });
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("makes at most 8 calls per run", async () => {
    const callModel = vi.fn<LocalModelCall>(async () => '{"verdict":"unsure","factors":[]}');
    const assist = createIdentityAiAssist({ deps: deps({}, LOCAL), callModel });
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await assist.refine("x", CLAIMS, BORDERLINE));
    expect(callModel).toHaveBeenCalledTimes(8);
    expect(results.filter((r) => r.corroborating.includes(MATCHER_LOCAL_AI))).toHaveLength(8);
    expect(results.filter((r) => r.corroborating.includes(MATCHER_RULES))).toHaveLength(4);
  });

  it("no call once the run budget is spent", async () => {
    const callModel = vi.fn<LocalModelCall>(async () => '{"verdict":"same","factors":[]}');
    const assist = createIdentityAiAssist({
      deps: deps({}, LOCAL),
      callModel,
      deadline: 1_000,
      now: () => 900,
    });
    const r = await assist.refine("x", CLAIMS, BORDERLINE);
    expect(callModel).not.toHaveBeenCalled();
    expect(r.corroborating.at(-1)).toBe(MATCHER_RULES);
  });

  it("rules_only → no call", async () => {
    const callModel = vi.fn<LocalModelCall>();
    const assist = createIdentityAiAssist({ deps: deps({ intelligence: "rules_only" }, LOCAL), callModel });
    await assist.refine("x", CLAIMS, BORDERLINE);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("the default call refuses a cloud Ollama connection outright", async () => {
    const raw = await callLocalModel(
      { type: "ollama", credentials: { baseUrl: "https://ollama.com", apiKey: "k" }, metadata: {} },
      [{ role: "user", content: "x" }],
      5_000,
    );
    expect(raw).toBeNull();
    expect(connectorFetch).not.toHaveBeenCalled();
  });

  it("the default call talks to the local /api/chat with the given timeout", async () => {
    vi.mocked(connectorFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { message: { content: '{"verdict":"unsure","factors":[]}' } },
      latencyMs: 3,
    });
    const raw = await callLocalModel(
      { type: "ollama", credentials: { baseUrl: "http://localhost:11434" }, metadata: {} },
      [{ role: "user", content: "x" }],
      4_000,
    );
    expect(raw).toBe('{"verdict":"unsure","factors":[]}');
    expect(vi.mocked(connectorFetch).mock.calls[0]![0]).toMatchObject({
      url: "http://localhost:11434/api/chat",
      timeoutMs: 4_000,
      retries: 0,
    });
  });

  it("parseAiResponse keeps only the case's claim types as factors", () => {
    expect(parseAiResponse('{"verdict":"same","factors":["phone","Jane"]}', new Set(["phone"]))).toEqual({
      verdict: "same",
      factors: ["phone"],
    });
  });
});
