"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { callApi, type ApiResult } from "@/lib/ui/call-api";
import { formatDate } from "@/lib/ux/plain-status";

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
}

/**
 * Shared mutation runner for the case page.
 *
 * Server data arrives as props from cases/[id]/page.tsx; after a successful
 * mutation we only call router.refresh() (inside a transition) and the new
 * props re-render the phases. No client-side re-fetching.
 */
export function useCaseMutations() {
  const router = useRouter();
  const [requestKey, setRequestKey] = useState("");
  const [refreshKey, setRefreshKey] = useState("");
  const [isRefreshing, startTransition] = useTransition();
  const [error, setErrorState] = useState<WorkflowError | null>(null);
  const [message, setMessage] = useState("");

  const loading = requestKey || (isRefreshing ? refreshKey : "");
  const busy = loading !== "";

  const setError = useCallback((value: WorkflowError | string | null) => {
    setErrorState(typeof value === "string" ? (value ? { text: value } : null) : value);
  }, []);

  const refresh = useCallback(
    (key: string) => {
      setRefreshKey(key);
      startTransition(() => {
        router.refresh();
      });
    },
    [router],
  );

  const mutate = useCallback(
    async (key: string, url: string, body: unknown, opts: MutateOptions): Promise<boolean> => {
      setRequestKey(key);
      setErrorState(null);
      try {
        const res = await callApi<Json>(url, {
          method: opts.method ?? "POST",
          body,
          errorMessage: opts.errorMessage,
        });
        if (!res.ok) {
          setErrorState(opts.onError?.(res) ?? friendlyApiError(res));
          return false;
        }
        opts.onSuccess?.(res.data);
        if (!opts.skipRefresh) refresh(key);
        return true;
      } finally {
        setRequestKey("");
      }
    },
    [refresh],
  );

  /** Run a GET (no refresh). Used for downloads such as the certificate. */
  const fetchJson = useCallback(
    async (
      key: string,
      url: string,
      opts: Pick<MutateOptions, "errorMessage" | "onError">,
    ): Promise<Json | null> => {
      setRequestKey(key);
      setErrorState(null);
      try {
        const res = await callApi<Json>(url, { errorMessage: opts.errorMessage });
        if (!res.ok) {
          setErrorState(opts.onError?.(res) ?? friendlyApiError(res));
          return null;
        }
        return res.data;
      } finally {
        setRequestKey("");
      }
    },
    [],
  );

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Copied to clipboard");
    } catch {
      setErrorState({ text: "Clipboard unavailable — select and copy the text manually" });
    }
  }, []);

  return {
    mutate,
    fetchJson,
    refresh,
    copyText,
    loading,
    busy,
    error,
    setError,
    message,
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
    queueOptOuts: () =>
      post("opt-out-queue", "opt-out-dispatch", { action: "queue" }, "Could not prepare opt-outs", (d) =>
        setMessage(`Prepared ${count(num(d.created), "opt-out")}.`),
      ),
    optOutAction: (dispatchId: string, action: "approve" | "submit" | "complete") =>
      post(`opt-${action}-${dispatchId}`, "opt-out-dispatch", { action, dispatchId }, "Could not update this opt-out"),
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
    saveDraft: (d: { id: string; subject: string; body: string }) =>
      post("save-draft", "remediation", { action: "update_draft", draftId: d.id, subject: d.subject, body: d.body }, "Could not save — your edits are still here"),
    recordSent: (draftId: string) =>
      post(`sent-${draftId}`, "remediation", { action: "record_sent", draftId, sentVia: "manual_copy" }, "Could not mark the request as sent"),
    sendViaConnector: (draftId: string) =>
      post(`send-${draftId}`, "remediation", { action: "send_email", draftId, recordAfterSend: true }, "Email send failed — check Settings", say("Email sent from your connected account")),
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
