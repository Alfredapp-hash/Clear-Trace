/**
 * Dev-server warm-up. `next dev` compiles each route the first time it is requested, and a
 * compile that lands while a test's page is open can trigger a Fast Refresh full reload,
 * which wipes a half-filled form (the intermittent "stuck on /register" failures). Visiting
 * every main route once, in a real browser, before the first test removes that race.
 *
 * Skipped for the production build (E2E_SERVER=prod) and external servers: nothing compiles.
 */
import { randomUUID } from "crypto";
import { chromium, type FullConfig } from "@playwright/test";

export default async function globalSetup(config: FullConfig) {
  if (process.env.E2E_SERVER === "prod" || process.env.PLAYWRIGHT_BASE_URL) return;
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    const origin = { Origin: new URL(baseURL).origin };

    // Public pages first, then a throwaway account so protected pages render (not redirect).
    for (const path of ["/login", "/register"]) await visit(page, path);
    const suffix = randomUUID().slice(0, 8);
    const registered = await page.request.post("/api/auth/register", {
      headers: origin,
      data: { name: "Warm Up", email: `warmup-${suffix}@test.local`, password: "warmup-pass-123456" },
    });
    if (!registered.ok()) throw new Error(`warm-up registration failed: ${registered.status()}`);
    const created = await page.request.post("/api/cases", {
      headers: origin,
      data: { title: "Warm-up case", caseType: "personal_exposure", targetRelationship: "self" },
    });
    const { caseId } = (await created.json()) as { caseId?: string };

    const paths = ["/", "/cases", "/cases/new", "/settings", "/billing"];
    if (caseId) paths.push(`/cases/${caseId}`);
    for (const path of paths) await visit(page, path);
    await context.close();
  } finally {
    await browser.close();
  }
}

async function visit(page: import("@playwright/test").Page, path: string) {
  await page.goto(path, { waitUntil: "load", timeout: 120_000 });
  // Let client chunks and any follow-up compiles finish before the next route.
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
}
