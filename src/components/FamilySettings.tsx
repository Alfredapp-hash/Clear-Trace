"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card, Input, Label, SectionTitle } from "./ui";
import { callApi, type ApiResult } from "@/lib/ui/call-api";

interface FamilyMember {
  id: string;
  displayName: string;
  relationship: string;
  notes: string | null;
}

type FamilyResponse = { members?: FamilyMember[]; seatLimit?: number };

const RELATIONSHIPS = [
  { id: "spouse", label: "Spouse / partner" },
  { id: "child", label: "Child" },
  { id: "parent", label: "Parent" },
  { id: "sibling", label: "Sibling" },
  { id: "other", label: "Other household member" },
];

export function FamilySettings() {
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [seatLimit, setSeatLimit] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [relationship, setRelationship] = useState("spouse");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  function applyLoaded(res: ApiResult<FamilyResponse>) {
    if (res.ok) {
      setMembers(res.data.members ?? []);
      setSeatLimit(res.data.seatLimit ?? 0);
    } else {
      setError(res.error);
    }
  }

  async function refresh() {
    applyLoaded(
      await callApi<FamilyResponse>("/api/settings/family-members", {
        errorMessage: "Could not load household members",
      }),
    );
  }

  useEffect(() => {
    const controller = new AbortController();
    callApi<FamilyResponse>("/api/settings/family-members", {
      signal: controller.signal,
      errorMessage: "Could not load household members",
    }).then((res) => {
      if (controller.signal.aborted) return;
      if (res.ok) {
        setMembers(res.data.members ?? []);
        setSeatLimit(res.data.seatLimit ?? 0);
      } else {
        setError(res.error);
      }
    });
    return () => controller.abort();
  }, []);

  async function addMember() {
    setLoading("add");
    setError("");
    setMessage("");
    try {
      const res = await callApi("/api/settings/family-members", {
        method: "POST",
        body: { displayName, relationship, notes },
        errorMessage: "Failed to add member",
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDisplayName("");
      setNotes("");
      setMessage("Family member added");
      await refresh();
    } finally {
      setLoading("");
    }
  }

  async function removeMember(id: string) {
    if (!confirm("Remove this household member?")) return;
    setLoading(`remove-${id}`);
    setError("");
    setMessage("");
    try {
      const res = await callApi(`/api/settings/family-members?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        errorMessage: "Failed to remove member",
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await refresh();
    } finally {
      setLoading("");
    }
  }

  return (
    <Card variant="elevated" className="mt-8">
      <SectionTitle subtitle="Manage household members on Pro (up to 5 seats)">
        Family & household
      </SectionTitle>
      <p className="mt-2 text-sm text-slate-400">
        Link cases to a household member — similar to Incogni/Optery family plans. Each member
        gets their own case with separate identity claims.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Badge tone={seatLimit > 0 ? "info" : "warning"}>
          {seatLimit > 0 ? `${members.length}/${seatLimit} seats` : "Pro required"}
        </Badge>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-rose-400">
          {error}
        </p>
      )}
      {message && <p className="mt-3 text-sm text-teal-400">{message}</p>}

      {members.length > 0 && (
        <ul className="mt-4 space-y-2">
          {members.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] px-4 py-3"
            >
              <div>
                <p className="font-medium text-slate-200">{m.displayName}</p>
                <p className="text-xs text-slate-500">{m.relationship.replaceAll("_", " ")}</p>
              </div>
              <Button
                variant="ghost"
                className="!px-3 !py-1 text-xs"
                onClick={() => removeMember(m.id)}
                disabled={loading === `remove-${m.id}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {seatLimit > members.length && (
        <div className="mt-6 grid gap-4 border-t border-white/[0.06] pt-6 sm:grid-cols-2">
          <div>
            <Label htmlFor="family-name">Display name</Label>
            <Input
              id="family-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Alex Smith"
            />
          </div>
          <div>
            <Label htmlFor="family-rel">Relationship</Label>
            <select
              id="family-rel"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100"
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
            >
              {RELATIONSHIPS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="family-notes">Notes (optional)</Label>
            <Input
              id="family-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Past cities, aliases to track…"
            />
          </div>
          <Button onClick={addMember} disabled={loading === "add" || !displayName.trim()}>
            {loading === "add" ? "Adding…" : "Add household member"}
          </Button>
        </div>
      )}
    </Card>
  );
}