import fs from "fs";
import path from "path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 3456;
// E2E runs against its own SQLite file, recreated on every run.
const E2E_DB = path.resolve(__dirname, "data", "e2e.db");
const usingExternalServer = !!process.env.PLAYWRIGHT_BASE_URL;

if (!usingExternalServer) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${E2E_DB}${suffix}`, { force: true });
  }
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  webServer: usingExternalServer
    ? undefined
    : {
        command: `npm run dev -- -p ${PORT}`,
        url: `http://localhost:${PORT}/api/health`,
        // Never reuse a developer's server: it would point at their real DB.
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          DATABASE_URL: E2E_DB,
          SESSION_SECRET: "e2e-session-secret-not-for-production-0123456789",
          ENCRYPTION_KEY: "e2e-encryption-key-not-for-production-0123456789",
          WORKER_SECRET: "e2e-worker-secret",
          NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
        },
      },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
