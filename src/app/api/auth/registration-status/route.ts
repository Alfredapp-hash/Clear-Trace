import { NextResponse } from "next/server";
import { ensureDatabase } from "@/lib/db/init";
import { getRegistrationStatus } from "@/lib/auth/registration";

/**
 * Public: whether self-service sign-up is currently accepted (REGISTRATION_MODE).
 * The login and register pages use it to hide the register link / show a closed state.
 * Reveals only the mode and a yes/no — never whether a particular account exists.
 */
export async function GET() {
  ensureDatabase();
  return NextResponse.json(getRegistrationStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
