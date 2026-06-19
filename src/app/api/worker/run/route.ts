import { ensureDatabase } from "@/lib/db/init";
import { runBackgroundJobs } from "@/lib/worker/processor";
import { jsonError, jsonOk } from "@/lib/api";
import { isWorkerAuthorized } from "@/lib/config/production-guards";

export async function POST(request: Request) {
  if (!isWorkerAuthorized(request)) {
    return jsonError("Unauthorized", 401);
  }

  ensureDatabase();
  const result = await runBackgroundJobs();
  return jsonOk(result);
}