export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertProductionConfig } = await import("@/lib/config/production-guards");
    assertProductionConfig();
    const { ensureDatabase } = await import("@/lib/db/init");
    ensureDatabase();
    // Upgrade legacy ciphertext / value hashes in place. Idempotent, logs counts only, never throws.
    const { runStartupCryptoBackfill } = await import("@/lib/crypto/backfill");
    await runStartupCryptoBackfill();
  }
}
