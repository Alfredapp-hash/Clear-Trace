"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
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
import { RUTHLESS_ATTESTATION } from "@/lib/ruthless/config";

/** Case ids are UUIDs; anything else in ?caseId= is ignored (a fresh case is started). */
const CASE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

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
  const [caseId, setCaseId] = useState<string | null>(resumeCaseId);

  const [title, setTitle] = useState("");
  const [caseType, setCaseType] = useState("personal_exposure");
  const [scanScopes, setScanScopes] = useState<string[]>(["people_search"]);
  const [authorityBasis, setAuthorityBasis] = useState("self");
  const [userAttestation, setUserAttestation] = useState(false);
  const [ruthlessMode, setRuthlessMode] = useState(false);
  const [ruthlessAttestation, setRuthlessAttestation] = useState(false);
  const [claims, setClaims] = useState([{ claimType: "full_name", value: "" }]);
  // Disambiguators: help tell the subject apart from same-name people.
  const [previousCityState, setPreviousCityState] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [relativeName, setRelativeName] = useState("");
  const [familyMembers, setFamilyMembers] = useState<
    { id: string; displayName: string; relationship: string }[]
  >([]);
  const [familyMemberId, setFamilyMemberId] = useState("");

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

  // Once the case exists, step-1 intake fields are persisted server-side and
  // cannot be edited from the wizard (there is no update endpoint), so lock them.
  const intakeLocked = caseId !== null;
  const linkedMember = familyMembers.find((m) => m.id === familyMemberId);
  const targetRelationship = linkedMember?.relationship ?? "self";

  function toggleScope(id: string) {
    setScanScopes((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
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
      errorMessage: "Failed to create case",
    });
    if (!res.ok || !res.data.caseId) {
      setError(res.ok ? "Failed to create case" : res.error);
      return null;
    }
    setCaseId(res.data.caseId);
    return res.data.caseId;
  }

  async function submitAuthorization(id: string) {
    const res = await callApi(`/api/cases/${id}/authorization`, {
      method: "POST",
      body: { authorityBasis, userAttestation },
      errorMessage: "Authorization failed",
    });
    if (!res.ok) setError(res.error);
    return res.ok;
  }

  async function submitClaims(id: string) {
    const extra = [
      { claimType: "previous_city_state", value: previousCityState },
      { claimType: "birth_year", value: birthYear.trim() },
      { claimType: "relative_name", value: relativeName },
    ];
    const validClaims = [...claims, ...extra]
      .filter((c) => c.value.trim())
      // birth_year / relative_name are stored with scanning off: never searched.
      .map((c) => ({ ...c, scanEnabled: defaultScanEnabled(c.claimType) }));
    const badYear = validClaims.find(
      (c) => c.claimType === "birth_year" && !BIRTH_YEAR_PATTERN.test(c.value.trim()),
    );
    if (badYear) {
      setError("Birth year must be a four-digit year only (for example 1991), not a full date.");
      return false;
    }
    if (!validClaims.length) return true;
    const res = await callApi(`/api/cases/${id}/identity-claims`, {
      method: "POST",
      body: { claims: validClaims },
      errorMessage: "Failed to store identity claims",
    });
    if (!res.ok) setError(res.error);
    return res.ok;
  }

  async function handleNext() {
    setError("");
    if (step === 1) {
      if (!intakeLocked && !title.trim()) {
        setError("Case title is required");
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      if (!userAttestation) {
        setError("You must attest to your authority before continuing");
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

  return (
    <div className="ct-ambient min-h-screen">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:py-14">
        <Link href="/cases" className="text-sm text-slate-500 hover:text-teal-400">
          ← Back to cases
        </Link>
        <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-400/90">
          Intake wizard
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
          {resumeCaseId ? "Finish setting up your case" : "New privacy case"}
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Step {step} of 3 — intake, authorization, and encrypted identity signals
        </p>
        <div className="mt-6 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-teal-500 to-teal-300 transition-all duration-300"
            style={{ width: `${(step / 3) * 100}%` }}
          />
        </div>

        <Card variant="elevated" className="mt-8 ct-animate-in">
          {step === 1 && (
            <fieldset disabled={intakeLocked} className="space-y-4 disabled:opacity-70">
              <legend className="sr-only">Case intake</legend>
              {intakeLocked && (
                <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-slate-400">
                  This case has already been created, so intake details are locked. You can
                  continue to the next step.
                </p>
              )}
              <div>
                <Label htmlFor="title">Case title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="People-search profile exposure"
                />
              </div>
              {familyMembers.length > 0 && (
                <div>
                  <Label htmlFor="familyMember">Household member (optional)</Label>
                  <select
                    id="familyMember"
                    value={familyMemberId}
                    onChange={(e) => setFamilyMemberId(e.target.value)}
                    className={selectClass}
                  >
                    <option value="">Self / not linked</option>
                    {familyMembers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName} ({m.relationship})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <Label htmlFor="caseType">Case type</Label>
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
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
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
                    <strong className="text-amber-100">Ruthless mode</strong> for this case —
                    expands all discovery scopes and enables maximum lawful removal coverage.
                  </span>
                </label>
                {ruthlessMode && (
                  <label
                    htmlFor="ruthless-attestation"
                    className="mt-3 flex cursor-pointer items-start gap-3 text-sm text-slate-400"
                  >
                    <input
                      id="ruthless-attestation"
                      type="checkbox"
                      checked={ruthlessAttestation}
                      onChange={(e) => setRuthlessAttestation(e.target.checked)}
                      className="mt-1"
                    />
                    <span>{RUTHLESS_ATTESTATION}</span>
                  </label>
                )}
              </div>
              <fieldset>
                <legend className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Discovery scopes
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
            </fieldset>
          )}

          {step === 2 && (
            <div className="space-y-4">
              {resumeCaseId && (
                <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-slate-400">
                  Your case already exists. Record your authorization to continue — no new case
                  is created.
                </p>
              )}
              <div>
                <Label htmlFor="authority">Authority basis</Label>
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
                  I attest that I have authority to act for the subject of this
                  case, that discovery will be limited to approved public
                  sources, and that I will not search for unrelated third parties.
                </span>
              </label>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <p className="text-sm text-slate-400">
                Identity signals are encrypted at rest. Only redacted previews
                appear in the UI and audit log.
              </p>
              {claims.map((claim, index) => (
                <div key={index} className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor={`claim-type-${index}`}>Claim type</Label>
                    <select
                      id={`claim-type-${index}`}
                      value={claim.claimType}
                      onChange={(e) => {
                        const next = [...claims];
                        next[index] = { ...claim, claimType: e.target.value };
                        setClaims(next);
                      }}
                      className={selectClass}
                    >
                      {CLAIM_TYPES.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor={`claim-value-${index}`}>Value</Label>
                    <Input
                      id={`claim-value-${index}`}
                      value={claim.value}
                      onChange={(e) => {
                        const next = [...claims];
                        next[index] = { ...claim, value: e.target.value };
                        setClaims(next);
                      }}
                      placeholder="Encrypted on save"
                      aria-describedby={
                        CLAIM_TYPE_HELP[claim.claimType] ? `claim-help-${index}` : undefined
                      }
                    />
                  </div>
                  {CLAIM_TYPE_HELP[claim.claimType] && (
                    <p id={`claim-help-${index}`} className="text-xs text-slate-500 sm:col-span-2">
                      {CLAIM_TYPE_HELP[claim.claimType]}
                    </p>
                  )}
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  setClaims([...claims, { claimType: "email", value: "" }])
                }
              >
                Add another claim
              </Button>
              <fieldset className="space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Tell you apart (optional)
                </legend>
                <p className="text-sm text-slate-400">
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
                  <p id="previous-city-state-help" className="mt-1 text-xs text-slate-500">
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
                    aria-describedby="birth-year-help"
                  />
                  <p id="birth-year-help" className="mt-1 text-xs text-slate-500">
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
                  <p id="relative-name-help" className="mt-1 text-xs text-slate-500">
                    {CLAIM_TYPE_HELP.relative_name}
                  </p>
                </div>
              </fieldset>
            </div>
          )}

          {error && (
            <p className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {error}
            </p>
          )}

          <div className="mt-6 flex justify-between">
            <Button
              variant="ghost"
              disabled={step === 1 || (resumeCaseId !== null && step === 2) || loading}
              onClick={() => setStep((s) => Math.max(1, s - 1))}
            >
              Back
            </Button>
            <Button onClick={handleNext} disabled={loading}>
              {loading
                ? "Saving…"
                : step === 3
                  ? "Complete intake"
                  : "Continue"}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}