import { sqlite } from "@/lib/db";
import { jsonOk } from "@/lib/api";
import { NextResponse } from "next/server";

export async function GET() {
  const ts = new Date().toISOString();
  try {
    const row = sqlite.prepare("select 1 as ok").get() as { ok?: number } | undefined;
    if (row?.ok !== 1) throw new Error("unexpected");
    return jsonOk({ status: "ok", db: "ok", ts });
  } catch {
    return NextResponse.json({ status: "error", db: "unreachable", ts }, { status: 503 });
  }
}
