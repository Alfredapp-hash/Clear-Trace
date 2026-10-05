/**
 * Switch a connection to WAL, retrying while another process holds the database lock.
 *
 * `PRAGMA journal_mode = WAL` can answer SQLITE_BUSY at once, without waiting for
 * busy_timeout, when several processes open a fresh database together (for example the
 * parallel workers of `next build`, or the app and the worker starting on an empty volume).
 */
type PragmaConn = { pragma: (source: string) => unknown };

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function enableWalMode(
  conn: PragmaConn,
  { attempts = 50, sleep = sleepSync }: { attempts?: number; sleep?: (ms: number) => void } = {},
): void {
  for (let attempt = 1; ; attempt++) {
    try {
      conn.pragma("journal_mode = WAL");
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "SQLITE_BUSY" || attempt >= attempts) throw err;
      sleep(Math.min(20 * attempt, 200));
    }
  }
}
