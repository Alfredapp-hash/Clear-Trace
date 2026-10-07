"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";
import { Button, Card, Input, Label } from "@/components/ui";
import { callApi } from "@/lib/ui/call-api";
import {
  AUTHORITY_BASES,
  BIRTH_YEAR_PATTERN,
  CASE_TYPES,
  CLAIM_TYPES,
  CLAIM_TYPE_HELP,
  SCAN_SCOPES,
  defaultScanEnabled,
} from "@/lib/constants";

/** Case ids are UUIDs; anything else in ?caseId= is ignored (a fresh case is started). */
const CASE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

const STEP_TITLES = ["About this case", "Your permission to act", "Details to search for"] as const;

/** Extra details the user can add on step 3 (full name has its own required field). */
const EXTRA_CLAIM_TYPES = CLAIM_TYPES.filter(
  (t) =>
    t.id !== "full_name" &&
    // These three have their own fields in "Tell you apart" below.
    t.id !== "previous_city_state" &&
    t.id !== "birth_year" &&
    t.id !== "relative_name",
);

/**
 * Broader search: describes only what it changes about where ClearTrace looks. It does not
 * promise that anything will be found or removed.
 */
const BROADER_SEARCH_ATTESTATION =
  "I understand broader search only widens where ClearTrace looks for this case. It does not " +
  "crawl the dark web, search for Social Security numbers, get around site protections, or " +
  "send anything without my approval.";

interface ExtraClaim {
  key: number;
  claimType: string;
  value: string;
}

export default function NewCasePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const router = useRouter();
  // ?caseId=… resumes setup for an existing case (from its "Finish setup" / "Record my
  // consent" button): the case is never created twice, and intake starts at authorization.
  const requested = use(searchParams).caseId;
  const resumeCaseId =
    typeof requested === "string" && CASE_ID_PATTERN.test(requested) ? requested : null;
  const [step, setStep] = useState(resumeCaseId ? 2 : 1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [invalidField, setInvalidField] = useState<"title" | "full-name" | "birth-year" | null>(
    null,
  );
  const [caseId, setCaseId] = useState<string | null>(resumeCaseId);

  const [title, setTitle] = useState("");
  const [caseType, setCaseType] = useState("personal_exposure");
  const [scanScopes, setScanScopes] = useState<string[]>(["people_search"]);
  const [authorityBasis, setAuthorityBasis] = useState("self");
  const [userAttestation, setUserAttestation] = useState(false);
  const [ruthlessMode, setRuthlessMode] = useState(false);
  const [ruthlessAttestation, setRuthlessAttestation] = useState(false);
  const [fullName, setFullName] = useState("");
  const [extraClaims, setExtraClaims] = useState<ExtraClaim[]>([]);
  const nextClaimKey = useRef(0);
  // Disambiguators: help tell the subject apart from same-name people.
  const [previousCityState, setPreviousCityState] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [relativeName, setRelativeName] = useState("");
  const [familyMembers, setFamilyMembers] = useState<
    { id: string; displayName: string; relationship: string }[]
  >([]);
  const [familyMemberId, setFamilyMemberId] = useState("");

  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    callApi<{ members?: { id: string; displayName: string; relationship: string }[] }>(
      "/api/settings/family-members",
      { signal: controller.signal },
    ).then((res) => {
      if (!controller.signal.aborted && res.ok) setFamilyMembers(res.data.members ?? []);
    });
    return () => controller.abort();
  }, []);

  // Move focus to the new step's heading so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepHeadingRef.current?.focus();
  }, [step]);

  // Once the case exists, step-1 intake fields are persisted server-side and
  // cannot be edited from the wizard (there is no update endpoint), so lock them.
  const intakeLocked = caseId !== null;
  const linkedMember = familyMembers.find((m) => m.id === familyMemberId);
  const targetRelationship = linkedMember?.relationship ?? "self";

  function fail(message: string, field: typeof invalidField = null) {
    setError(message);
    setInvalidField(field);
    if (field) document.getElementById(field)?.focus();
  }

  function toggleScope(id: string) {
    setScanScopes((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  }

  function addClaim() {
    nextClaimKey.current += 1;
    setExtraClaims((prev) => [...prev, { key: nextClaimKey.current, claimType: "email", value: "" }]);
  }

  function updateClaim(key: number, patch: Partial<ExtraClaim>) {
    setExtraClaims((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }

  function removeClaim(key: number) {
    setExtraClaims((prev) => prev.filter((c) => c.key !== key));
    // Focus stays on something meaningful after the row disappears.
    document.getElementById("add-claim")?.focus();
  }

  async function createCase(): Promise<string | null> {
    const res = await callApi<{ caseId?: string }>("/api/cases", {
      method: "POST",
      body: {
        title: title.trim(),
        caseType,
        targetRelationship,
        scanScopes,
        ruthlessMode: ruthlessMode && ruthlessAttestation,
        familyMemberId: familyMemberId || null,
      },
      errorMessage: "The case could not be created. Nothing was saved — please try again.",
    });
    if (!res.ok || !res.data.caseId) {
      fail(res.ok ? "The case could not be created. Please try again." : res.error);
      return null;
    }
    setCaseId(res.data.caseId);
    return res.data.caseId;
  }

  async function submitAuthorization(id: string) {
    const res = await callApi(`/api/cases/${id}/authorization`, {
      method: "POST",
      body: { authorityBasis, userAttestation },
      errorMessage: "Your permission could not be saved. Please try again.",
    });
    if (!res.ok) fail(res.error);
    return res.ok;
  }

  async function submitClaims(id: string) {
    const extra = [
      { claimType: "previous_city_state", value: previousCityState },
      { claimType: "birth_year", value: birthYear.trim() },
      { claimType: "relative_name", value: relativeName },
    ];
    const validClaims = [
      { claimType: "full_name", value: fullName },
      ...extraClaims.map(({ claimType, value }) => ({ claimType, value })),
      ...extra,
    ]
      .filter((c) => c.value.trim())
      // birth_year / relative_name are stored with scanning off: never searched.
      .map((c) => ({ ...c, scanEnabled: defaultScanEnabled(c.claimType) }));
    const res = await callApi(`/api/cases/${id}/identity-claims`, {
      method: "POST",
      body: { claims: validClaims },
      errorMessage: "Your details could not be saved. Please try again.",
    });
    if (!res.ok) fail(res.error);
    return res.ok;
  }

  async function handleNext() {
    setError("");
    setInvalidField(null);
    if (step === 1) {
      if (!intakeLocked && !title.trim()) {
        fail("Give the case a name so you can find it later.", "title");
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      if (!userAttestation) {
        fail("Check the box to confirm you have permission to act for this person.");
        return;
      }
      setLoading(true);
      try {
        const id = caseId ?? (await createCase());
        if (!id) return;
        const authOk = await submitAuthorization(id);
        if (!authOk) return;
        setStep(3);
      } finally {
        setLoading(false);
      }
      return;
    }
    if (step === 3 && caseId) {
      if (!fullName.trim()) {
        fail("Enter the full name to search for. ClearTrace can't look for listings without it.", "full-name");
        return;
      }
      if (birthYear.trim() && !BIRTH_YEAR_PATTERN.test(birthYear.trim())) {
        fail(
          "Birth year must be a four-digit year only (for example 1991), not a full date.",
          "birth-year",
        );
        return;
      }
      setLoading(true);
      let claimsOk = false;
      try {
        claimsOk = await submitClaims(caseId);
      } finally {
        setLoading(false);
      }
      if (!claimsOk) return;
      router.push(`/cases/${caseId}`);
      router.refresh();
    }
  }

  const selectClass =
    "w-full rounded-xl border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 focus:border-teal-500/50 focus:outline-none focus:ring-2 focus:ring-teal-500/20";
  const errorId = "intake-error";
  const describedByError = (field: typeof invalidField, help?: string) =>
    [invalidField === field ? errorId : null, help].filter(Boolean).join(" ") || undefined;

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/cases" className="text-sm text-[var(--muted)] hover:text-teal-400">
        ← Back to cases
      </Link>
      <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-400/90">
        New case
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
        {resumeCaseId ? "Finish setting up your case" : "New privacy case"}
      </h1>
      <p className="mt-2 text-sm text-slate-300">
        Three short steps: describe the case, confirm you&apos;re allowed to act, and enter the
        details to search for.
      </p>
      <div
        role="progressbar"
        aria-label="Case setup progress"
        aria-valuemin={1}
        aria-valuemax={3}
        aria-valuenow={step}
        aria-valuetext={`Step ${step} of 3: ${STEP_TITLES[step - 1]}`}
        className="mt-6 h-1 overflow-hidden rounded-full bg-white/[0.06]"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-teal-500 to-teal-300 transition-all duration-300"
          style={{ width: `${(step / 3) * 100}%` }}
        />
      </div>

      <Card variant="elevated" className="mt-8 ct-animate-in">
        <h2
          ref={stepHeadingRef}
          tabIndex={-1}
          data-testid="intake-step-heading"
          className="mb-5 text-lg font-semibold tracking-tight text-white focus:outline-none"
        >
          <span className="text-sm font-medium text-[var(--muted)]">Step {step} of 3 · </span>
          {STEP_TITLES[step - 1]}
        </h2>

        {step === 1 && (
          <fieldset disabled={intakeLocked} className="space-y-4 disabled:opacity-70">
            <legend className="sr-only">About this case</legend>
            {intakeLocked && (
              <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-slate-300">
                This case has already been created, so these details are locked. You can
                continue to the next step.
              </p>
            )}
            <div>
              <Label htmlFor="title">Case title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. My people-search listings"
                required
                aria-invalid={invalidField === "title" || undefined}
                aria-describedby={describedByError("title")}
              />
            </div>
            {familyMembers.length > 0 && (
              <div>
                <Label htmlFor="familyMember">Who is this case for?</Label>
                <select
                  id="familyMember"
                  value={familyMemberId}
                  onChange={(e) => setFamilyMemberId(e.target.value)}
                  className={selectClass}
                >
                  <option value="">Me</option>
                  {familyMembers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName} ({m.relationship})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <Label htmlFor="caseType">What kind of problem is it?</Label>
              <select
                id="caseType"
                value={caseType}
                onChange={(e) => setCaseType(e.target.value)}
                className={selectClass}
              >
                {CASE_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <fieldset>
              <legend className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">
                Where to look
              </legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {SCAN_SCOPES.map((scope) => (
                  <label
                    key={scope.id}
                    htmlFor={`scope-${scope.id}`}
                    className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-sm transition hover:border-white/15"
                  >
                    <input
                      id={`scope-${scope.id}`}
                      type="checkbox"
                      checked={scanScopes.includes(scope.id)}
                      onChange={() => toggleScope(scope.id)}
                    />
                    {scope.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
              <label
                htmlFor="ruthless-mode"
                className="flex cursor-pointer items-start gap-3 text-sm text-slate-300"
              >
                <input
                  id="ruthless-mode"
                  type="checkbox"
                  checked={ruthlessMode}
                  onChange={(e) => setRuthlessMode(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  <strong className="text-white">Broader search</strong> (sometimes called
                  Ruthless mode) — looks in every category above and runs more searches for
                  this case. A wider search can find more listings, but it can&apos;t guarantee
                  that anything is found or removed.
                </span>
              </label>
              {ruthlessMode && (
                <label
                  htmlFor="ruthless-attestation"
                  className="mt-3 flex cursor-pointer items-start gap-3 text-sm text-slate-300"
                >
                  <input
                    id="ruthless-attestation"
                    type="checkbox"
                    checked={ruthlessAttestation}
                    onChange={(e) => setRuthlessAttestation(e.target.checked)}
                    className="mt-1"
                  />
                  <span>{BROADER_SEARCH_ATTESTATION}</span>
                </label>
              )}
              {ruthlessMode && !ruthlessAttestation && (
                <p className="mt-2 text-xs text-[var(--muted)]">
                  Broader search stays off unless you also check the box above.
                </p>
              )}
            </div>
          </fieldset>
        )}

        {step === 2 && (
          <div className="space-y-4">
            {resumeCaseId && (
              <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-slate-300">
                Your case already exists. Confirm your permission to continue — no new case is
                created.
              </p>
            )}
            <div>
              <Label htmlFor="authority">Who are you to the person in this case?</Label>
              <select
                id="authority"
                value={authorityBasis}
                onChange={(e) => setAuthorityBasis(e.target.value)}
                className={selectClass}
              >
                {AUTHORITY_BASES.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <label
              htmlFor="user-attestation"
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-slate-300"
            >
              <input
                id="user-attestation"
                type="checkbox"
                checked={userAttestation}
                onChange={(e) => setUserAttestation(e.target.checked)}
                className="mt-1"
              />
              <span>
                I confirm that I have the right to act for the person in this case, that
                searches will be limited to approved public sources, and that I will not use
                this to look up anyone else.
              </span>
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-300">
              These details are encrypted when saved. Only shortened, partly hidden versions
              appear on screen and in the activity log.
            </p>
            <div>
              <Label htmlFor="full-name">Full name</Label>
              <Input
                id="full-name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Jordan Smith"
                autoComplete="off"
                required
                aria-invalid={invalidField === "full-name" || undefined}
                aria-describedby={describedByError("full-name", "full-name-help")}
              />
              <p id="full-name-help" className="mt-1 text-xs text-[var(--muted)]">
                Required. The name as it would appear on a listing.
              </p>
            </div>

            {extraClaims.length > 0 && (
              <ul className="space-y-3" aria-label="Other details to search for">
                {extraClaims.map((claim, index) => (
                  <li
                    key={claim.key}
                    className="grid gap-3 rounded-xl border border-white/[0.06] p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                  >
                    <div>
                      <Label htmlFor={`claim-type-${claim.key}`}>Kind of detail</Label>
                      <select
                        id={`claim-type-${claim.key}`}
                        value={claim.claimType}
                        onChange={(e) => updateClaim(claim.key, { claimType: e.target.value })}
                        className={selectClass}
                      >
                        {EXTRA_CLAIM_TYPES.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label htmlFor={`claim-value-${claim.key}`}>
                        {EXTRA_CLAIM_TYPES.find((t) => t.id === claim.claimType)?.label ?? "Detail"}
                      </Label>
                      <Input
                        id={`claim-value-${claim.key}`}
                        value={claim.value}
                        onChange={(e) => updateClaim(claim.key, { value: e.target.value })}
                        autoComplete="off"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => removeClaim(claim.key)}
                      aria-label={`Remove detail ${index + 1} (${(EXTRA_CLAIM_TYPES.find((t) => t.id === claim.claimType)?.label ?? "detail").toLowerCase()})`}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button id="add-claim" type="button" variant="secondary" onClick={addClaim}>
              Add another detail
            </Button>

            <fieldset className="space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
              <legend className="px-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">
                Tell you apart (optional)
              </legend>
              <p className="text-sm text-slate-300">
                Many people share a name. These details help ClearTrace tell your listings
                from someone else&apos;s. Birth year and relative&apos;s name are used only
                to tell people apart — they are never searched or sent to a search provider.
              </p>
              <div>
                <Label htmlFor="previous-city-state">Previous city / state</Label>
                <Input
                  id="previous-city-state"
                  value={previousCityState}
                  onChange={(e) => setPreviousCityState(e.target.value)}
                  placeholder="e.g. Austin, TX"
                  aria-describedby="previous-city-state-help"
                />
                <p id="previous-city-state-help" className="mt-1 text-xs text-[var(--muted)]">
                  {CLAIM_TYPE_HELP.previous_city_state}
                </p>
              </div>
              <div>
                <Label htmlFor="birth-year">Birth year</Label>
                <Input
                  id="birth-year"
                  value={birthYear}
                  onChange={(e) => setBirthYear(e.target.value)}
                  placeholder="e.g. 1991"
                  inputMode="numeric"
                  maxLength={4}
                  pattern="(19|20)[0-9]{2}"
                  autoComplete="off"
                  aria-invalid={invalidField === "birth-year" || undefined}
                  aria-describedby={describedByError("birth-year", "birth-year-help")}
                />
                <p id="birth-year-help" className="mt-1 text-xs text-amber-200">
                  {CLAIM_TYPE_HELP.birth_year} Never enter your full date of birth.
                </p>
              </div>
              <div>
                <Label htmlFor="relative-name">Relative&apos;s name</Label>
                <Input
                  id="relative-name"
                  value={relativeName}
                  onChange={(e) => setRelativeName(e.target.value)}
                  placeholder="e.g. a parent or sibling"
                  autoComplete="off"
                  aria-describedby="relative-name-help"
                />
                <p id="relative-name-help" className="mt-1 text-xs text-[var(--muted)]">
                  {CLAIM_TYPE_HELP.relative_name}
                </p>
              </div>
            </fieldset>
          </div>
        )}

        {error && (
          <p
            id={errorId}
            role="alert"
            className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-between">
          <Button
            variant="ghost"
            disabled={step === 1 || (resumeCaseId !== null && step === 2) || loading}
            onClick={() => {
              setError("");
              setInvalidField(null);
              setStep((s) => Math.max(1, s - 1));
            }}
          >
            Back
          </Button>
          <Button onClick={handleNext} disabled={loading}>
            {loading ? "Saving…" : step === 3 ? "Complete intake" : "Continue"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
