import { ensureDatabase } from "@/lib/db/init";
import { runBackgroundJobs } from "@/lib/worker/processor";
import { jsonError, jsonOk } from "@/lib/api";
import { isJobRequestAuthorized } from "@/lib/config/production-guards";

// Schedulers (Vercel-style cron, systemd timers, docker cron) typically issue GET;
// manual triggers and the in-app worker use POST. Both require the job secret.
async function handle(request: Request) {
  if (!isJobRequestAuthorized(request)) {
    return jsonError("Unauthorized", 401);
  }

  ensureDatabase();
  const result = await runBackgroundJobs();
  return jsonOk(result);
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
