/**
 * Optional local-model assist for borderline identity matches.
 *
 * Owner decision: LOCAL ONLY. The model is a connected local Ollama or the on-device Apple
 * bridge (resolveLocalIntelligenceConnection) — never a cloud provider, whatever the org's
 * intelligence settings say. When no local model is available, or it times out or returns
 * anything but the strict JSON shape, the rule-based result stands.
 *
 * Bounds:
 * - only candidates whose rule score is in [0.4, 0.7) are sent;
 * - at most 8 model calls per discovery run, 5s each, inside the run's time budget;
 * - the score moves by at most ±0.1, and the assist never confirms a match (a confirmed
 *   match is only ever a human decision; the score maps to probable/possible/unreviewed).
 *
 * Every result carries a provenance factor: 'matcher:local_ai' or 'matcher:rules'.
 */
import { connectorFetch } from "@/lib/connectors/connection/http";
import { resolveOllamaTarget, type OllamaRequestTarget } from "@/lib/connectors/connection/ollama";
import { DEFAULT_OLLAMA_MODEL } from "@/lib/connectors/connection/ollama-origin";
import {
  APPLE_BRIDGE_MODEL,
  resolveAppleBridgeTarget,
} from "@/lib/connectors/connection/apple-bridge";
import {
  resolveLocalIntelligenceConnection,
  type IntelligenceResolverDeps,
  type ResolvedConnection,
} from "@/lib/connectors/connection/intelligence";
import {
  POSSIBLE_MATCH_THRESHOLD,
  PROBABLE_MATCH_THRESHOLD,
  type IdentityMatchResult,
  type MatchClaim,
} from "./identity-match";

export const AI_ASSIST_MAX_CALLS = 8;
export const AI_ASSIST_TIMEOUT_MS = 5_000;
export const AI_ASSIST_MAX_DELTA = 0.1;
/** Below this much remaining budget no model call is started. */
const MIN_CALL_BUDGET_MS = 1_000;
/** Page text sent to the local model is capped to keep prompts small. */
const MAX_PAGE_CHARS = 4_000;

export const MATCHER_RULES = "matcher:rules";
export const MATCHER_LOCAL_AI = "matcher:local_ai";

export type AiVerdict = "same" | "different" | "unsure";

export interface AiAssistResponse {
  verdict: AiVerdict;
  factors: string[];
}

const SYSTEM_PROMPT =
  "You decide whether a web page describes the same person as a subject profile. " +
  "Compare names, ages, places, phone numbers, emails and relatives. Many people share a name; " +
  "answer 'same' only when details agree, 'different' when details clearly conflict, otherwise 'unsure'. " +
  'Return JSON only: {"verdict":"same"|"different"|"unsure","factors":[claim types that decided it]}.';

const FORMAT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["same", "different", "unsure"] },
    factors: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "factors"],
} as const;

/** Sends one prompt to the local model and returns its raw text, or null on any failure. */
export type LocalModelCall = (
  connection: ResolvedConnection,
  messages: Array<{ role: "system" | "user"; content: string }>,
  timeoutMs: number,
) => Promise<string | null>;

function localTarget(connection: ResolvedConnection): { target: OllamaRequestTarget; model: string } | null {
  if (connection.type === "apple_intelligence") {
    return { target: resolveAppleBridgeTarget(connection.credentials), model: APPLE_BRIDGE_MODEL };
  }
  if (connection.type === "ollama") {
    const target = resolveOllamaTarget(connection.credentials);
    // Defence in depth: the resolver only returns local origins, but never send to a cloud one.
    if (target.endpoint.mode !== "local") return null;
    return { target, model: connection.metadata.model?.trim() || DEFAULT_OLLAMA_MODEL };
  }
  return null;
}

/** Default model call: Ollama-shaped /api/chat with structured output, no retries. */
export const callLocalModel: LocalModelCall = async (connection, messages, timeoutMs) => {
  try {
    const resolved = localTarget(connection);
    if (!resolved) return null;
    const { target, model } = resolved;
    const res = await connectorFetch<{ message?: { content?: string } }>({
      provider: connection.type,
      url: `${target.endpoint.origin}/api/chat`,
      method: "POST",
      headers: { ...target.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        think: false,
        format: FORMAT_SCHEMA,
        options: { temperature: 0 },
      }),
      timeoutMs,
      retries: 0,
      pinned: true,
      allowPrivateNetwork: true,
    });
    const content = typeof res.data === "object" && res.data ? res.data.message?.content : undefined;
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
};

/**
 * Strict parse of the model output. Anything other than exactly
 * {verdict: same|different|unsure, factors: string[]} is rejected (null).
 * Factors are kept only when they are claim types of this case — never free text.
 */
export function parseAiResponse(raw: string | null, allowedFactors: ReadonlySet<string>): AiAssistResponse | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { verdict, factors } = parsed as { verdict?: unknown; factors?: unknown };
  if (verdict !== "same" && verdict !== "different" && verdict !== "unsure") return null;
  if (!Array.isArray(factors) || !factors.every((f) => typeof f === "string")) return null;
  const kept = [...new Set(factors as string[])].filter((f) => allowedFactors.has(f));
  return { verdict, factors: kept };
}

function withMatcher(result: IdentityMatchResult, tag: string): IdentityMatchResult {
  return {
    ...result,
    corroborating: [...result.corroborating.filter((f) => !f.startsWith("matcher:")), tag],
  };
}

export function isBorderline(score: number): boolean {
  return score >= POSSIBLE_MATCH_THRESHOLD && score < PROBABLE_MATCH_THRESHOLD;
}

export interface IdentityAiAssistOptions {
  deps: Pick<IntelligenceResolverDeps, "getAgentDefaults" | "getOrgConnector">;
  callModel?: LocalModelCall;
  /** Absolute epoch-ms after which no model call starts (the discovery run budget). */
  deadline?: number;
  maxCalls?: number;
  timeoutMs?: number;
  now?: () => number;
}

export interface IdentityAiAssist {
  /** Refines one candidate's rule result; never throws. */
  refine(pageText: string, claims: readonly MatchClaim[], rule: IdentityMatchResult): Promise<IdentityMatchResult>;
  /** Model calls made so far in this run. */
  readonly calls: number;
}

/** One assist per discovery run: it resolves the local model once and counts calls. */
export function createIdentityAiAssist(options: IdentityAiAssistOptions): IdentityAiAssist {
  const callModel = options.callModel ?? callLocalModel;
  const maxCalls = options.maxCalls ?? AI_ASSIST_MAX_CALLS;
  const timeoutMs = options.timeoutMs ?? AI_ASSIST_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let calls = 0;
  let connection: Promise<ResolvedConnection | null> | null = null;

  const getConnection = () =>
    (connection ??= resolveLocalIntelligenceConnection(options.deps).catch(() => null));

  return {
    get calls() {
      return calls;
    },
    async refine(pageText, claims, rule) {
      if (!isBorderline(rule.score) || calls >= maxCalls) return withMatcher(rule, MATCHER_RULES);
      const conn = await getConnection();
      if (!conn) return withMatcher(rule, MATCHER_RULES);
      const remaining = options.deadline === undefined ? timeoutMs : options.deadline - now();
      const budget = Math.min(timeoutMs, remaining);
      if (budget < Math.min(MIN_CALL_BUDGET_MS, timeoutMs)) return withMatcher(rule, MATCHER_RULES);

      calls++;
      const claimTypes = new Set(claims.map((c) => c.claimType));
      const subject = claims.map((c) => `- ${c.claimType}: ${c.value}`).join("\n");
      const messages = [
        { role: "system" as const, content: SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: `Subject profile:\n${subject}\n\nPage text:\n${pageText.slice(0, MAX_PAGE_CHARS)}`,
        },
      ];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const raw = await Promise.race([
        callModel(conn, messages, budget).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), budget);
        }),
      ]).finally(() => clearTimeout(timer));

      const answer = parseAiResponse(raw, claimTypes);
      if (!answer) return withMatcher(rule, MATCHER_RULES);

      const delta =
        answer.verdict === "same" ? AI_ASSIST_MAX_DELTA : answer.verdict === "different" ? -AI_ASSIST_MAX_DELTA : 0;
      const score = Math.round(Math.max(0, Math.min(1, rule.score + delta)) * 100) / 100;
      const corroborating = [...rule.corroborating];
      const conflicting = [...rule.conflicting];
      const target = answer.verdict === "different" ? conflicting : answer.verdict === "same" ? corroborating : null;
      if (target) for (const f of answer.factors) if (!target.includes(f)) target.push(f);
      return withMatcher({ score, corroborating, conflicting }, MATCHER_LOCAL_AI);
    },
  };
}
