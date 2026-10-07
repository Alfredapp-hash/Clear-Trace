/**
 * Shared Playwright fixtures. Import { test, expect } from "./fixtures" instead of
 * "@playwright/test" to make a spec fail on any browser console.error, uncaught page error or
 * Content-Security-Policy violation.
 *
 * Allow a known, harmless message per file or per describe block:
 *   test.use({ consoleAllowlist: [/status of 401/] });
 */
import { test as base, expect, type Page } from "@playwright/test";

export type ConsoleAllowlist = ReadonlyArray<string | RegExp>;

const CSP_PREFIX = "[securitypolicyviolation]";

function allowed(text: string, allowlist: ConsoleAllowlist): boolean {
  return allowlist.some((rule) => (typeof rule === "string" ? text.includes(rule) : rule.test(text)));
}

/** Attaches the listeners and returns the problems collected so far (live array). */
export async function watchPageProblems(page: Page, allowlist: ConsoleAllowlist = []): Promise<string[]> {
  const problems: string[] = [];
  const record = (text: string) => {
    if (!allowed(text, allowlist)) problems.push(text);
  };
  page.on("console", (msg) => {
    if (msg.type() === "error") record(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => record(`pageerror: ${err.message}`));
  // CSP violations: Chromium also logs "Refused to ..." as console errors, but the event is the
  // reliable signal (it fires for report-only policies and in every browser).
  await page.exposeFunction("__cleartraceCspViolation", (detail: string) => record(`${CSP_PREFIX} ${detail}`));
  await page.addInitScript((prefix: string) => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const fn = (window as unknown as { __cleartraceCspViolation?: (d: string) => void }).__cleartraceCspViolation;
      fn?.(`${e.effectiveDirective || e.violatedDirective} blocked ${e.blockedURI || "inline"} (${prefix})`);
    });
  }, CSP_PREFIX);
  return problems;
}

export const test = base.extend<{ consoleAllowlist: ConsoleAllowlist }>({
  consoleAllowlist: [[], { option: true }],
  // (Playwright's fixture callback is named `provide` here, not `use`, so the React hooks lint
  // rule does not mistake it for React's use().)
  page: async ({ page, consoleAllowlist }, provide, testInfo) => {
    const problems = await watchPageProblems(page, consoleAllowlist);
    await provide(page);
    if (problems.length > 0) {
      await testInfo.attach("browser-problems", { body: problems.join("\n"), contentType: "text/plain" });
    }
    expect(problems, "browser console errors / CSP violations").toEqual([]);
  },
});

export { expect };

/**
 * Same-origin GET from inside the page, so the browser's own cookie rules apply. Use this for
 * authenticated API checks: Playwright's APIRequestContext does not send the production
 * `Secure` session cookie over plain http://127.0.0.1, while real browsers do.
 */
export async function browserGet(page: Page, path: string): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (p) => {
    const res = await fetch(p, { credentials: "same-origin" });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }, path);
}
