const DEV_SESSION_SECRET = "cleartrace-dev-session-secret";
const DEV_ENCRYPTION_KEY = "cleartrace-dev-key-change-in-production";

export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;

  const errors: string[] = [];

  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === DEV_SESSION_SECRET) {
    errors.push("SESSION_SECRET must be set to a strong random value in production");
  }

  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY) {
    errors.push("ENCRYPTION_KEY must be set to a strong random value in production");
  }

  if (!process.env.WORKER_SECRET?.trim()) {
    errors.push("WORKER_SECRET must be set in production to protect /api/worker/run");
  }

  if (errors.length > 0) {
    throw new Error(`Production configuration invalid:\n- ${errors.join("\n- ")}`);
  }
}

export function isWorkerAuthorized(request: Request): boolean {
  const secret = process.env.WORKER_SECRET?.trim();
  if (process.env.NODE_ENV === "production") {
    if (!secret) return false;
    return request.headers.get("authorization") === `Bearer ${secret}`;
  }
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}