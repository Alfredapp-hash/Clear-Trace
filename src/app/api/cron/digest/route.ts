import { ensureDatabase } from "@/lib/db/init";
import { runWeeklyDigests } from "@/lib/reports/digest";
import { jsonError, jsonOk } from "@/lib/api";
import { isWorkerAuthorized } from "@/lib/config/production-guards";

export async function POST(request: Request) {
  if (!isWorkerAuthorized(request)) {
    return jsonError("Unauthorized", 401);
  }

  ensureDatabase();
  const result = await runWeeklyDigests();
  return jsonOk(result);
}