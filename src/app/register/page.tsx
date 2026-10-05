"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthLayout } from "@/components/AuthLayout";
import { Button, ButtonLink, Input, Label } from "@/components/ui";
import { callApi } from "@/lib/ui/call-api";

const MIN_PASSWORD_LENGTH = 10;

type RegistrationStatus = { mode: string; open: boolean; message?: string };

const CLOSED_FALLBACK =
  "Registration is closed on this ClearTrace instance. Ask the person who runs it to give you access.";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Closed-state message; the form renders until the server says sign-up is closed.
  const [closedMessage, setClosedMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    callApi<RegistrationStatus>("/api/auth/registration-status", {
      signal: controller.signal,
    }).then((res) => {
      if (controller.signal.aborted || !res.ok) return;
      if (!res.data.open) setClosedMessage(res.data.message ?? CLOSED_FALLBACK);
    });
    return () => controller.abort();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await callApi("/api/auth/register", {
      method: "POST",
      body: { name, email, password, organizationName },
      errorMessage: "Registration failed",
    });

    if (!res.ok) {
      if (res.status === 403 && res.data?.error === "REGISTRATION_CLOSED") {
        setClosedMessage(
          typeof res.data.message === "string" ? res.data.message : CLOSED_FALLBACK,
        );
      } else {
        setError(res.error);
      }
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  const signInFooter = (
    <p className="text-center text-sm text-muted">
      Already have an account?{" "}
      <Link href="/login" className="font-medium text-teal-400 hover:text-teal-300">
        Sign in
      </Link>
    </p>
  );

  if (closedMessage) {
    return (
      <AuthLayout
        title="Registration closed"
        subtitle="This ClearTrace instance is not accepting new accounts."
      >
        <div data-testid="registration-closed" className="space-y-5">
          <p className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
            {closedMessage}
          </p>
          <ButtonLink href="/login" className="w-full" size="lg">
            Go to sign in
          </ButtonLink>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your workspace"
      subtitle="Set up a private environment for authorized privacy remediation."
      footer={signInFooter}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <Label htmlFor="name">Full name</Label>
          <Input
            id="name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={MIN_PASSWORD_LENGTH}
            aria-describedby="password-hint"
          />
          <p id="password-hint" className="mt-1.5 text-xs text-muted">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        <div>
          <Label htmlFor="org">Organization (optional)</Label>
          <Input
            id="org"
            autoComplete="organization"
            value={organizationName}
            onChange={(e) => setOrganizationName(e.target.value)}
            placeholder="Personal workspace"
          />
        </div>
        {error && (
          <p role="alert" className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" size="lg" disabled={loading}>
          {loading ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
