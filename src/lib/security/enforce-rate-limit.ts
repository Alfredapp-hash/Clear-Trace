import { jsonError } from "@/lib/api";
import { checkRateLimit } from "./rate-limiter";

export async function enforceRateLimit(
  key: string,
  limitPerHour: number,
): Promise<ReturnType<typeof jsonError> | null> {
  const result = await checkRateLimit(key, limitPerHour);
  if (!result.allowed) {
    return jsonError("Too many requests", 429);
  }
  return null;
}