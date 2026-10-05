"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import { AuthLayout } from "@/components/AuthLayout";
import { Button, Input, Label } from "@/components/ui";
import { safeRedirectPath } from "@/lib/auth/safe-redirect";
import { callApi } from "@/lib/ui/call-api";

type RegistrationStatus = { mode: string; open: boolean; message?: string };

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // null until known: the register link stays hidden unless sign-up is actually open.
  const [registration, setRegistration] = useState<RegistrationStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    callApi<RegistrationStatus>("/api/auth/registration-status", {
      signal: controller.signal,
    }).then((res) => {
      if (!controller.signal.aborted && res.ok) setRegistration(res.data);
    });
    return () => controller.abort();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Login failed");
      setLoading(false);
      return;
    }

    const from = safeRedirectPath(searchParams.get("from"));
    router.push(from);
    router.refresh();
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your private remediation workspace."
      footer={
        registration?.open ? (
          <p className="text-center text-sm text-muted">
            No account?{" "}
            <Link href="/register" className="font-medium text-teal-400 hover:text-teal-300">
              Create one
            </Link>
          </p>
        ) : registration ? (
          <p data-testid="registration-closed" className="text-center text-sm text-muted">
            New accounts are closed on this instance. Ask the person who runs it for access.
          </p>
        ) : null
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        {error && (
          <p role="alert" className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" size="lg" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}