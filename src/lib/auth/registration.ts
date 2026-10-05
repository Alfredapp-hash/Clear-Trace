import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { hashValue } from "@/lib/crypto/encryption";

/**
 * Self-service registration policy (REGISTRATION_MODE).
 *
 * - `first_user` (default): sign-up is open only while the users table is empty, so a fresh
 *   install can create its owner account and then closes itself.
 * - `invite`: sign-up is closed. There is no invite flow yet, so accounts cannot be added
 *   through the UI in this mode; it exists so operators can lock registration explicitly.
 * - `open`: anyone who can reach the app may register (the pre-1.3 behaviour; used by e2e).
 */
export type RegistrationMode = "first_user" | "invite" | "open";

export const REGISTRATION_MODES: readonly RegistrationMode[] = ["first_user", "invite", "open"];

export const REGISTRATION_CLOSED = "REGISTRATION_CLOSED";

export function getRegistrationMode(env: Record<string, string | undefined> = process.env): RegistrationMode {
  const raw = env.REGISTRATION_MODE?.trim().toLowerCase();
  return REGISTRATION_MODES.includes(raw as RegistrationMode)
    ? (raw as RegistrationMode)
    : "first_user";
}

export interface RegistrationStatus {
  mode: RegistrationMode;
  /** Whether a self-service registration would be accepted right now. */
  open: boolean;
  /** Human-readable explanation shown by the register page when closed. */
  message?: string;
}

export const REGISTRATION_CLOSED_MESSAGE =
  "Registration is closed on this ClearTrace instance. Ask the person who runs it to give you access.";
export const REGISTRATION_INVITE_MESSAGE =
  "This ClearTrace instance is invite-only. Invitations are not available yet; ask the person who runs it to create your access.";

/** Pure policy: may a new account be created given the mode and current user count? */
export function registrationAllowed(mode: RegistrationMode, userCount: number): boolean {
  if (mode === "open") return true;
  if (mode === "invite") return false;
  return userCount === 0;
}

export function countUsers(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(users).get();
  return Number(row?.n ?? 0);
}

export function getRegistrationStatus(env: Record<string, string | undefined> = process.env): RegistrationStatus {
  const mode = getRegistrationMode(env);
  // Avoid the count query when the answer does not depend on it.
  const open = mode === "first_user" ? registrationAllowed(mode, countUsers()) : mode === "open";
  if (open) return { mode, open };
  return {
    mode,
    open,
    message: mode === "invite" ? REGISTRATION_INVITE_MESSAGE : REGISTRATION_CLOSED_MESSAGE,
  };
}

/**
 * Rate-limit bucket keyed on a keyed hash of the normalized email, so `rate_limit_events.key`
 * never stores an address. `scope` is optional extra bucketing (e.g. the client IP when
 * TRUST_PROXY=1) and is hashed together with the email.
 */
export function emailRateLimitKey(prefix: string, emailKey: string, scope?: string): string {
  const material = scope === undefined ? emailKey : `${emailKey}\u0000${scope}`;
  return `${prefix}:${hashValue(material)}`;
}
