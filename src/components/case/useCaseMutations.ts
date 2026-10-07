"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState, useTransition } from "react";
import { callApi, type ApiResult } from "@/lib/ui/call-api";
import { formatDate } from "@/lib/ux/plain-status";
import type { InlineResultView, ToastTone, ToastView } from "../ui";

export type Json = Record<string, unknown>;

/** An error shown in the workflow card. `billing` adds an inline link to /billing. */
export interface WorkflowError {
  text: string;
  billing?: boolean;
}

const FOLLOW_UP_REASONS: Record<string, string> = {
  no_prior_request: "no original request has been recorded as sent",
  waiting_period: "the waiting period has not passed yet",
  max_follow_ups: "the follow-up limit for this page has been reached",
  max_follow_ups_reached: "the follow-up limit for this page has been reached",
  removed: "the page has already been removed",
  do_not_contact: "this contact is marked do-not-contact",
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Turn a failed API result into friendly copy. Handles the workflow codes other
 * lanes return: 402 (billing), 409 CASE_BLOCKED, 409 FOLLOW_UP_BLOCKED and
 * 403 NOT_CONSENTED. Pure, so it is unit-tested without a DOM.
 */
export function friendlyApiError(
  res: Pick<Extract<ApiResult<Json>, { ok: false }>, "status" | "error" | "code" | "data">,
): WorkflowError {
  const code = res.code ?? (typeof res.data?.code === "string" ? res.data.code : undefined);
  const error = res.error ?? "";

  if (res.status === 402) {
    return { text: error || "This feature needs a paid plan.", billing: true };
  }

  if (res.status === 409 && (code === "CASE_BLOCKED" || /paused or archived/i.test(error))) {
    return {
      text: "This case is paused or archived. Press Resume at the top of the page to continue.",
    };
  }

  if (
    res.status === 409 &&
    (code === "FOLLOW_UP_BLOCKED" || /FOLLOW_UP_BLOCKED|follow-up/i.test(error))
  ) {
    const data = res.data ?? {};
    const reasons = [
      ...stringList(data.stopConditions),
      ...stringList(data.reasons),
      ...stringList(data.reasonCodes),
    ];
    const nextDate =
      typeof data.nextEligibleDate === "string" ? formatDate(data.nextEligibleDate) : "";
    const why = reasons.map((r) => FOLLOW_UP_REASONS[r]).filter(Boolean);
    let text = "A follow-up isn't available yet";
    if (why.length) text += `: ${[...new Set(why)].join("; ")}`;
    text += ".";
    if (nextDate) text += ` You can send one on ${nextDate}.`;
    return { text };
  }

  if (res.status === 400 && code === "BROKER_DOMAIN_MISMATCH") {
    return {
      text:
        error && !/^BROKER_DOMAIN_MISMATCH/.test(error)
          ? error
          : "That link is not on this broker's website. Paste the address of your profile page on the broker's own site.",
    };
  }

  if (res.status === 403 && (code === "NOT_CONSENTED" || /consent/i.test(error))) {
    return { text: "Record your consent for this case before ClearTrace searches or fetches pages." };
  }

  return { text: error || "Something went wrong" };
}

export interface MutateOptions {
  errorMessage: string;
  method?: "POST" | "PATCH";
  onSuccess?: (data: Json) => void;
  /** Map a failure to custom copy; return undefined to use friendlyApiError. */
  onError?: (res: Extract<ApiResult<Json>, { ok: false }>) => WorkflowError | undefined;
  /** Skip router.refresh() (e.g. a download that changes nothing). */
  skipRefresh?: boolean;
  /** Record the row result but raise no toast (batch items report one summary instead). */
  silent?: boolean;
}

/* ----------------------------- per-row results ----------------------------- */

/** Last result per mutation key ("opt-<id>", "review-<id>", "match-<id>", …). */
export type RowResults = Record<string, InlineResultView>;

export type RowResultAction =
  | { type: "start"; key: string }
  | { type: "saved"; key: string; at: number }
  | { type: "failed"; key: string; text: string; at: number }
  | { type: "clear"; key: string };

/** Pure reducer for per-row results; exported for tests. */
export function rowResultsReducer(state: RowResults, action: RowResultAction): RowResults {
  switch (action.type) {
    case "start":
    case "clear": {
      if (!(action.key in state)) return state;
      const next = { ...state };
      delete next[action.key];
      return next;
    }
    case "saved":
      return { ...state, [action.key]: { kind: "saved", at: action.at } };
    case "failed":
      return { ...state, [action.key]: { kind: "error", text: action.text, at: action.at } };
  }
}

/** The most recent result among several keys of one row (e.g. a draft's send / mark-sent). */
export function latestResult(
  results: RowResults,
  keys: ReadonlyArray<string>,
): { key: string; result: InlineResultView } | undefined {
  let best: { key: string; result: InlineResultView } | undefined;
  for (const key of keys) {
    const result = results[key];
    if (result && (!best || result.at >= best.result.at)) best = { key, result };
  }
  return best;
}

/* --------------------------------- toasts ---------------------------------- */

export type ToastInput = Omit<ToastView, "id"> & {
  /** Auto-dismiss after this many ms. Errors default to staying until dismissed. */
  ttl?: number;
};

export type ToastAction =
  | { type: "push"; toast: ToastView }
  | { type: "dismiss"; id: number };

/** Most toasts kept at once; the oldest goes first. */
export const MAX_TOASTS = 3;
/** How long a success toast (and its Undo) stays up. */
export const TOAST_TTL_MS = 6000;
export const UNDO_TTL_MS = 10000;

export function toastsReducer(state: ToastView[], action: ToastAction): ToastView[] {
  if (action.type === "dismiss") return state.filter((t) => t.id !== action.id);
  // Same text and tone replaces the older copy instead of stacking duplicates.
  const rest = state.filter((t) => !(t.text === action.toast.text && t.tone === action.toast.tone));
  return [...rest, action.toast].slice(-MAX_TOASTS);
}

/**
 * Auto-dismiss timers that can be paused (pointer or focus on a toast) and resumed with the
 * time that was left, so an Undo never expires while someone is reaching for it. Plain
 * object, no React: exported for tests.
 */
export function createToastTimers(onExpire: (id: number) => void) {
  const entries = new Map<
    number,
    { timer: ReturnType<typeof setTimeout> | null; deadline: number; remaining: number }
  >();
  const arm = (id: number, ms: number) => {
    const timer = setTimeout(() => {
      entries.delete(id);
      onExpire(id);
    }, ms);
    entries.set(id, { timer, deadline: Date.now() + ms, remaining: ms });
  };
  return {
    start(id: number, ms: number) {
      if (ms > 0) arm(id, ms);
    },
    pause(id: number) {
      const e = entries.get(id);
      if (!e || e.timer === null) return;
      clearTimeout(e.timer);
      entries.set(id, { timer: null, deadline: 0, remaining: Math.max(0, e.deadline - Date.now()) });
    },
    resume(id: number) {
      const e = entries.get(id);
      if (!e || e.timer !== null) return;
      // Leave a moment to read the toast again after the pointer or focus moves away.
      arm(id, Math.max(e.remaining, TOAST_RESUME_MIN_MS));
    },
    clear(id: number) {
      const e = entries.get(id);
      if (e?.timer) clearTimeout(e.timer);
      entries.delete(id);
    },
    clearAll() {
      for (const e of entries.values()) if (e.timer) clearTimeout(e.timer);
      entries.clear();
    },
    isPaused(id: number) {
      return entries.get(id)?.timer === null;
    },
  };
}

/** Least time a resumed toast stays up. */
export const TOAST_RESUME_MIN_MS = 2000;

/**
 * Toast queue with timers. Errors stay until dismissed or pushed out by newer toasts; timed
 * toasts pause while hovered or focused (holdToast / releaseToast from the ToastRegion).
 */
export function useToasts() {
  const [toasts, dispatch] = useReducer(toastsReducer, []);
  const nextId = useRef(1);
  const timers = useRef<ReturnType<typeof createToastTimers> | null>(null);
  if (timers.current === null) {
    timers.current = createToastTimers((id) => dispatch({ type: "dismiss", id }));
  }

  useEffect(() => {
    const pending = timers.current;
    return () => pending?.clearAll();
  }, []);

  const dismissToast = useCallback((id: number) => {
    timers.current?.clear(id);
    dispatch({ type: "dismiss", id });
  }, []);

  const pushToast = useCallback((input: ToastInput): number => {
    const { ttl, ...view } = input;
    const id = nextId.current++;
    dispatch({ type: "push", toast: { ...view, id } });
    const life = ttl ?? (view.tone === "error" ? 0 : view.action ? UNDO_TTL_MS : TOAST_TTL_MS);
    timers.current?.start(id, life);
    return id;
  }, []);

  const holdToast = useCallback((id: number) => timers.current?.pause(id), []);
  const releaseToast = useCallback((id: number) => timers.current?.resume(id), []);

  return { toasts, pushToast, dismissToast, holdToast, releaseToast };
}

/* ------------------------------ batch helpers ------------------------------ */

/**
 * Run `worker` over `items` with at most `concurrency` in flight; results keep input
 * order. A worker that throws counts as `false`. Pure apart from the worker; exported
 * for tests.
 */
export async function runPool<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<R | false>> {
  const results: Array<R | false> = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i]);
      } catch {
        results[i] = false;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
  return results;
}

/** Batch actions from the client never run more than this many requests at once. */
export const BATCH_CONCURRENCY = 3;

/**
 * Shared mutation runner for the case page.
 *
 * Server data arrives as props from cases/[id]/page.tsx; after a successful
 * mutation we only call router.refresh() (inside a transition) and the new
 * props re-render the phases. No client-side re-fetching.
 *
 * Feedback: every mutation records a per-row result under its key ("Saved" or the
 * error with Retry) and messages/errors go to the fixed toast region, so a failure at
 * the bottom of a long case is visible and announced without scrolling.
 */
export function useCaseMutations() {
  const router = useRouter();
  const [requestKey, setRequestKey] = useState("");
  const [refreshKey, setRefreshKey] = useState("");
  const [isRefreshing, startTransition] = useTransition();
  const [results, dispatchResult] = useReducer(rowResultsReducer, {});
  /** What to re-run for Retry, per row key. */
  const retries = useRef(new Map<string, { url: string; body: unknown; opts: MutateOptions }>());
  const { toasts, pushToast, dismissToast, holdToast, releaseToast } = useToasts();

  const loading = requestKey || (isRefreshing ? refreshKey : "");
  const busy = loading !== "";

  const toast = useCallback(
    (tone: ToastTone, text: string, extra: Partial<ToastInput> = {}) => pushToast({ tone, text, ...extra }),
    [pushToast],
  );
  const setMessage = useCallback((text: string) => {
    if (text) toast("success", text);
  }, [toast]);
  const setError = useCallback(
    (value: WorkflowError | string | null) => {
      if (!value) return;
      const err = typeof value === "string" ? { text: value } : value;
      toast("error", err.text, { billing: err.billing });
    },
    [toast],
  );

  const refresh = useCallback(
    (key: string) => {
      setRefreshKey(key);
      startTransition(() => {
        router.refresh();
      });
    },
    [router],
  );

  /** One API call with row-result bookkeeping; does not touch the loading key. */
  const request = useCallback(
    async (key: string, url: string, body: unknown, opts: MutateOptions): Promise<boolean> => {
      dispatchResult({ type: "start", key });
      const res = await callApi<Json>(url, {
        method: opts.method ?? "POST",
        body,
        errorMessage: opts.errorMessage,
      });
      if (!res.ok) {
        const err = opts.onError?.(res) ?? friendlyApiError(res);
        dispatchResult({ type: "failed", key, text: err.text, at: Date.now() });
        if (!opts.silent) toast("error", err.text, { billing: err.billing });
        return false;
      }
      dispatchResult({ type: "saved", key, at: Date.now() });
      opts.onSuccess?.(res.data);
      return true;
    },
    [toast],
  );

  const mutate = useCallback(
    async (key: string, url: string, body: unknown, opts: MutateOptions): Promise<boolean> => {
      retries.current.set(key, { url, body, opts });
      setRequestKey(key);
      try {
        const ok = await request(key, url, body, opts);
        if (ok && !opts.skipRefresh) refresh(key);
        return ok;
      } finally {
        setRequestKey("");
      }
    },
    [refresh, request],
  );

  /**
   * Run one request per item at BATCH_CONCURRENCY, under a single loading key, then
   * refresh once. Each item keeps its own row result (and Retry).
   */
  const batch = useCallback(
    async <T,>(
      batchKey: string,
      items: ReadonlyArray<T>,
      each: (item: T) => { key: string; url: string; body: unknown; opts: MutateOptions },
    ): Promise<{ ok: T[]; failed: T[] }> => {
      setRequestKey(batchKey);
      try {
        const outcomes = await runPool(items, BATCH_CONCURRENCY, (item) => {
          const r = each(item);
          const opts = { ...r.opts, silent: true, skipRefresh: true };
          retries.current.set(r.key, { url: r.url, body: r.body, opts: r.opts });
          return request(r.key, r.url, r.body, opts);
        });
        const ok = items.filter((_, i) => outcomes[i] === true);
        const failed = items.filter((_, i) => outcomes[i] !== true);
        if (ok.length) refresh(batchKey);
        return { ok, failed };
      } finally {
        setRequestKey("");
      }
    },
    [refresh, request],
  );

  const retry = useCallback(
    (key: string) => {
      const r = retries.current.get(key);
      if (r) void mutate(key, r.url, r.body, { ...r.opts, silent: false });
    },
    [mutate],
  );

  /** Run a GET (no refresh). Used for downloads such as the certificate. */
  const fetchJson = useCallback(
    async (
      key: string,
      url: string,
      opts: Pick<MutateOptions, "errorMessage" | "onError">,
    ): Promise<Json | null> => {
      setRequestKey(key);
      try {
        const res = await callApi<Json>(url, { errorMessage: opts.errorMessage });
        if (!res.ok) {
          setError(opts.onError?.(res) ?? friendlyApiError(res));
          return null;
        }
        return res.data;
      } finally {
        setRequestKey("");
      }
    },
    [setError],
  );

  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setMessage("Copied to clipboard");
      } catch {
        setError("Clipboard unavailable — select and copy the text manually");
      }
    },
    [setError, setMessage],
  );

  return {
    mutate,
    batch,
    fetchJson,
    refresh,
    copyText,
    retry,
    results,
    toasts,
    pushToast,
    dismissToast,
    holdToast,
    releaseToast,
    loading,
    busy,
    setError,
    setMessage,
  };
}

export type CaseMutations = ReturnType<typeof useCaseMutations>;

/** Discovery runs live only when a search connector is connected; otherwise sample (demo) mode. */
export function discoveryRequestBody(discoveryReady: boolean): { mode: "live" | "demo" } {
  return { mode: discoveryReady ? "live" : "demo" };
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Row keys shared by the actions below and the rows that show their results. */
export const optOutKey = (dispatchId: string) => `opt-${dispatchId}`;
export const matchKey = (matchId: string) => `match-${matchId}`;
export const foundKey = (brokerId: string) => `found-${brokerId}`;
export const RESIDENCE_KEY = "residence-state";
export const DROP_FILING_KEY = "drop-filing";
export const PLACE_KEY = "add-place";

/** "Approved 10 of 12 opt-outs. 2 failed — use Retry on those rows." */
export function batchSummary(verb: string, ok: number, total: number, one: string, many = `${one}s`): string {
  if (ok === total) return `${verb} ${count(total, one, many)}.`;
  const failed = total - ok;
  return `${verb} ${ok} of ${count(total, one, many)}. ${failed} failed — use Retry on ${failed === 1 ? "that row" : "those rows"}.`;
}

/**
 * Result of "Prepare opt-outs". A zero result always says why: brokers that already have an
 * opt-out, CPPA-registry brokers (never queued automatically) and, for the default
 * seen-only queue, that nothing is marked found yet, with the proactive alternative.
 */
export function queueResultMessage(
  d: { created?: unknown; skippedExisting?: unknown; skippedRegistry?: unknown },
  includeUnchecked = false,
): string {
  const created = num(d.created);
  const existing = num(d.skippedExisting);
  const registry = num(d.skippedRegistry);
  const notes = [
    existing ? `${count(existing, "broker")} already ${existing === 1 ? "has" : "have"} an opt-out` : "",
    registry ? `${count(registry, "registry-only broker")} skipped — California residents can use DROP for those` : "",
  ].filter(Boolean);
  const tail = notes.length ? ` (${notes.join("; ")}).` : ".";
  if (created > 0) return `Prepared ${count(created, "opt-out")}${tail}`;
  if (includeUnchecked) return `No new opt-outs to prepare${tail}`;
  if (notes.length) return `No new opt-outs to prepare${tail}`;
  return (
    "No new opt-outs: no broker is confirmed to list you yet. Mark the listings you find in the " +
    'checklist below, or use "Prepare opt-outs for all unchecked brokers" to opt out proactively.'
  );
}

/**
 * Every case-page action, named, built on useCaseMutations. Phase components
 * receive these as explicit callback props so they stay independent.
 */
export function useCaseActions(caseId: string) {
  const m = useCaseMutations();
  const base = `/api/cases/${caseId}`;
  const { mutate, setMessage } = m;

  const post = (
    key: string,
    path: string,
    body: unknown,
    errorMessage: string,
    onSuccess?: (d: Json) => void,
  ) => mutate(key, `${base}/${path}`, body, { errorMessage, onSuccess });
  const say = (text: string) => () => setMessage(text);

  return {
    ...m,
    search: (live: boolean) =>
      post("discovery", "discovery", discoveryRequestBody(live), "Search failed", (d) => {
        const found = typeof d.new === "number" ? d.new : num(d.candidateCount);
        const known = num(d.alreadyKnown);
        const rejected = num(d.previouslyRejected);
        const extra = [
          known ? `${known} already known` : "",
          rejected ? `${rejected} you already said ${rejected === 1 ? "is" : "are"} not you` : "",
        ].filter(Boolean);
        setMessage(
          `Found ${count(found, "new possible match", "new possible matches")}` +
            (extra.length ? ` (${extra.join(", ")}).` : "."),
        );
      }),
    breachScan: () =>
      post("breach", "breach-scan", undefined, "Breach check failed", (d) =>
        setMessage(
          `Breach check: ${count(num(d.findingCount), "breach", "breaches")} found for ${count(num(d.identifierCount), "email address", "email addresses")}.`,
        ),
      ),
    maximumSweep: () =>
      post("ruthless", "ruthless-sweep", undefined, "Maximum sweep failed", (d) => {
        const disc = (d.discovery ?? {}) as Json;
        const brokers = (d.brokerSweep ?? {}) as Json;
        const breach = (d.breachScan ?? {}) as Json;
        setMessage(
          `Maximum sweep: ${count(num(disc.candidateCount), "possible match", "possible matches")}, ${count(num(brokers.matchCount), "broker")} to check, ${count(num(breach.findingCount), "breach", "breaches")}.`,
        );
      }),
    review: (candidateId: string, decision: "confirm" | "reject") =>
      mutate(`review-${candidateId}`, `${base}/discovery`, { candidateId, decision }, {
        method: "PATCH",
        errorMessage: decision === "confirm" ? "Could not confirm this match" : "Could not reject this match",
      }),
    addPage: (url: string) =>
      post("live-url", "live-url", { url }, "Could not fetch that page", (d) => {
        if (d.outcome === "already_known") setMessage("That page is already in this case.");
        else if (d.outcome === "previously_rejected")
          setMessage("You marked that page as not you, and it hasn't changed since.");
        else setMessage("Page added — review it below.");
      }),
    brokerSweep: () =>
      post("broker-sweep", "broker-sweep", undefined, "Broker check failed", (d) =>
        setMessage(
          `Checked ${count(num(d.brokerCount), "broker")}: ${num(d.matchCount)} may list you. These are possible listings, not confirmed matches.`,
        ),
      ),
    /** Seen / found brokers only; `includeUnchecked` adds unchecked brokers (proactive). */
    queueOptOuts: (includeUnchecked = false) =>
      post(
        includeUnchecked ? "opt-out-queue-all" : "opt-out-queue",
        "opt-out-dispatch",
        includeUnchecked ? { action: "queue", includeUnchecked: true } : { action: "queue" },
        "Could not prepare opt-outs",
        (d) => setMessage(queueResultMessage(d, includeUnchecked)),
      ),
    optOutAction: (dispatchId: string, action: "approve" | "submit" | "complete") =>
      post(optOutKey(dispatchId), "opt-out-dispatch", { action, dispatchId }, "Could not update this opt-out"),
    /** Decline an opt-out that was not sent yet (pending_approval / approved). Terminal. */
    dismissOptOut: (dispatchId: string, reason?: string) =>
      post(
        optOutKey(dispatchId),
        "opt-out-dispatch",
        { action: "dismiss", dispatchId, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
        "Could not dismiss this opt-out",
        say("Opt-out dismissed. Nothing was sent to the broker."),
      ),
    /** State of residence: a state code, or null to detect it from the case details again. */
    setResidenceState: (jurisdictionState: string | null) =>
      mutate(RESIDENCE_KEY, `${base}/statutory`, { jurisdictionState }, {
        method: "PATCH",
        errorMessage: "Could not save the state of residence",
        onSuccess: say("State of residence saved"),
      }),
    /** California DROP: the date the user filed their own request (YYYY-MM-DD). */
    recordDropFiling: (filedAt: string) =>
      post(DROP_FILING_KEY, "statutory", { filedAt }, "Could not save the filing date",
        say("Filing date saved. ClearTrace will track the 45- and 90-day windows.")),
    /** Approve several opt-outs (the per-dispatch API, BATCH_CONCURRENCY at a time). */
    approveAll: async (dispatchIds: string[]) => {
      if (dispatchIds.length === 0) return;
      const { ok, failed } = await m.batch("approve-all", dispatchIds, (dispatchId) => ({
        key: optOutKey(dispatchId),
        url: `${base}/opt-out-dispatch`,
        body: { action: "approve", dispatchId },
        opts: { errorMessage: "Could not approve this opt-out" },
      }));
      const text = batchSummary("Approved", ok.length, dispatchIds.length, "opt-out");
      if (failed.length) m.setError(text);
      else setMessage(text);
    },
    /**
     * Confirm several possible matches, then offer Undo for the toast's lifetime. Undo puts
     * the same matches back into review (decision "reset"); it never marks them "Not me".
     */
    confirmMany: async (candidateIds: string[]) => {
      if (candidateIds.length === 0) return;
      const review = (decision: "confirm" | "reset") => (candidateId: string) => ({
        key: `review-${candidateId}`,
        url: `${base}/discovery`,
        body: { candidateId, decision },
        opts: {
          method: "PATCH" as const,
          errorMessage: decision === "confirm" ? "Could not confirm this match" : "Could not undo this match",
        },
      });
      const { ok, failed } = await m.batch("confirm-many", candidateIds, review("confirm"));
      const text = batchSummary("Confirmed", ok.length, candidateIds.length, "match", "matches");
      if (ok.length === 0) {
        m.setError(text);
        return;
      }
      let toastId = 0;
      toastId = m.pushToast({
        tone: failed.length ? "error" : "success",
        text,
        ttl: UNDO_TTL_MS,
        action: {
          label: "Undo",
          onClick: () => {
            m.dismissToast(toastId);
            void m.batch("confirm-undo", ok, review("reset")).then((r) =>
              r.failed.length
                ? m.setError(batchSummary("Undid", r.ok.length, ok.length, "match", "matches"))
                : setMessage(`Undone: ${count(r.ok.length, "match", "matches")} back to review.`),
            );
          },
        },
      });
    },
    /** Checklist: "Not listed" for one broker (survives reloads; audited on the server). */
    markNotListed: (matchId: string) =>
      mutate(matchKey(matchId), `${base}/broker-sweep/matches/${encodeURIComponent(matchId)}`, { outcome: "not_found" }, {
        method: "PATCH",
        errorMessage: "Could not save that this broker does not list you",
      }),
    /** Checklist: undo "Not listed" (back to "To check"). */
    clearCheck: (matchId: string) =>
      mutate(matchKey(matchId), `${base}/broker-sweep/matches/${encodeURIComponent(matchId)}`, { outcome: "to_check" }, {
        method: "PATCH",
        errorMessage: "Could not undo that check",
      }),
    /** Checklist: "I found my listing" — adds the pasted profile page tied to that broker. */
    /** Add the person's city and state (a searchable claim) so checklist searches prefill. */
    addPlace: (cityState: string) =>
      post(PLACE_KEY, "identity-claims", { claims: [{ claimType: "city_state", value: cityState }] },
        "Could not save your city and state",
        say("City and state saved. Searches that need them are now prefilled.")),
    foundListing: (brokerId: string, url: string) =>
      post(foundKey(brokerId), "live-url", { url, brokerId }, "Could not add that page", (d) => {
        if (d.outcome === "already_known") setMessage("That page is already in this case.");
        else if (d.captureMethod === "user_reported")
          setMessage("Listing saved. The broker blocked an automatic copy, so review it from your own browser.");
        else setMessage("Listing added — review it in step 1.");
      }),
    findContact: (exposureId: string) =>
      post(`resolve-${exposureId}`, "remediation", { action: "resolve_controller", exposureId }, "Could not find who to contact"),
    /** Look up contacts for several pages, then refresh once. Stops at the first failure. */
    findAllContacts: async (exposureIds: string[]) => {
      for (const exposureId of exposureIds) {
        const ok = await mutate("resolve-all", `${base}/remediation`, { action: "resolve_controller", exposureId }, {
          errorMessage: "Could not find who to contact",
          skipRefresh: true,
        });
        if (!ok) break;
      }
      m.refresh("resolve-all");
    },
    createDraft: (remediationCaseId: string, templateId?: string) =>
      post("draft", "remediation", { action: "create_draft", remediationCaseId, templateId }, "Could not write the request"),
    generateAll: (remediationCaseId: string) =>
      post("all-drafts", "remediation", { action: "create_all_variants", remediationCaseId }, "Could not write the request versions"),
    saveDraft: (d: { id: string; subject: string; body: string; recipient?: string }) =>
      post(
        "save-draft",
        "remediation",
        {
          action: "update_draft",
          draftId: d.id,
          subject: d.subject,
          body: d.body,
          // Only sent when the user entered one; an empty field keeps the stored recipient.
          ...(d.recipient?.trim() ? { recipient: d.recipient.trim() } : {}),
        },
        "Could not save — your edits are still here",
      ),
    recordSent: (draftId: string) =>
      post(`sent-${draftId}`, "remediation", { action: "record_sent", draftId, sentVia: "manual_copy" }, "Could not mark the request as sent"),
    sendViaConnector: (draftId: string) =>
      post(`send-${draftId}`, "remediation", { action: "send_email", draftId }, "Email send failed — check Settings", say("Email sent from your connected account")),
    pushGmail: (draftId: string) =>
      post(`gmail-${draftId}`, "remediation", { action: "gmail_draft", draftId }, "Gmail draft failed — connect Gmail in Settings", say("Saved as a draft in your Gmail")),
    followUp: (remediationCaseId: string) =>
      post(`follow-up-${remediationCaseId}`, "remediation", { action: "create_follow_up_draft", remediationCaseId }, "Could not write the follow-up"),
    createDeindex: (onRemaining: (n: number | undefined) => void) =>
      post("deindex", "deindex", { engines: ["google", "bing"] }, "Could not prepare search engine requests", (d) => {
        onRemaining(typeof d.remaining === "number" ? d.remaining : undefined);
        setMessage(`Prepared ${count(num(d.created), "search engine request")}.`);
      }),
    updateDeindex: (requestId: string, action: "submit" | "resolve" | "reject") =>
      post(`deindex-${action}-${requestId}`, "deindex", { action, requestId }, "Could not update this request"),
    schedule: (exposureId: string) =>
      post(`schedule-${exposureId}`, "verification", { action: "schedule", exposureId, schedule: "weekly" }, "Could not schedule weekly checks", say("Weekly check scheduled")),
    check: (exposureId: string, describe: (status: string) => string) =>
      post(`live-verify-${exposureId}`, "verification", { action: "verify", exposureId, mode: "live" }, "The check failed", (d) => {
        const result = typeof d.status === "string" ? d.status : typeof d.result === "string" ? d.result : "";
        if (result) setMessage(`Check result: ${describe(result)}`);
      }),
    simulate: (exposureId: string, removed: boolean, onDenied: () => void) =>
      mutate(`simulate-${exposureId}`, `${base}/verification`, { action: "verify", exposureId, simulateRemoved: removed, mode: "simulate" }, {
        errorMessage: "Simulation failed",
        onSuccess: say("Demo simulation recorded — this is not a real removal check."),
        onError: (res) => {
          if (res.status !== 403) return undefined;
          onDenied();
          return { text: "Simulation only works on demo cases. Use “Check if it's gone” instead." };
        },
      }),
    autopilot: (onRun: (d: Json) => void) =>
      post("next-step", "run-next-step", undefined, "Autopilot could not run the next step", onRun),
    /** Fetch the certificate JSON and save it. 409 NO_VERIFIED_REMOVALS gets a hint. */
    downloadCertificate: async () => {
      const data = await m.fetchJson("certificate", `${base}/certificate`, {
        errorMessage: "Could not create the removal certificate",
        onError: (res) =>
          res.status === 409 && res.code === "NO_VERIFIED_REMOVALS"
            ? { text: "No checked removals yet — run “Check if it's gone” on each page first." }
            : undefined,
      });
      if (!data) return;
      const certId = typeof data.certificateId === "string" ? data.certificateId : `case-${caseId}`;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), {
        href,
        download: `removal-certificate-${certId}.json`,
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      setMessage("Removal certificate downloaded");
    },
  };
}

export type CaseActions = ReturnType<typeof useCaseActions>;
