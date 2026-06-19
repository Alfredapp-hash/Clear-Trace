import { jsonOk } from "@/lib/api";

export async function GET() {
  return jsonOk({ status: "ok", ts: new Date().toISOString() });
}
