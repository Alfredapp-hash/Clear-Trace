import { randomUUID } from "crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Broker checklist without any search connector: the sweep lists brokers to check, each with
 * a link the user opens in their own browser. ClearTrace never fetches broker search pages.
 */

// A pasted link on the wrong domain is answered with a 400 the page reports in a toast.
test.use({ consoleAllowlist: [/status of 400/] });

async function registerAndCreateCase(page: Page, options: { previousCityState?: string } = {}) {
  const suffix = randomUUID().slice(0, 8);
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Checklist User");
  await page.getByLabel("Email").fill(`checklist-${suffix}@test.local`);
  await page.getByLabel("Password").fill("testpass1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");

  await page.goto("/cases/new");
  await page.getByLabel("Case title").fill(`Checklist ${suffix}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Full name", { exact: true }).fill("Jordan Testcase");
  if (options.previousCityState) await page.getByLabel("Previous city / state").fill(options.previousCityState);
  await page.getByRole("button", { name: "Complete intake" }).click();
  await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+$/);
  return page.url();
}

async function openBrokerPhase(page: Page) {
  const toggle = page.locator("#phase-broker-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("no-connector broker checklist: prefilled links, Not listed survives reload, wrong domain rejected", async ({ page }) => {
  const caseUrl = await registerAndCreateCase(page);

  // The browser itself never contacts a broker while the checklist is used.
  const external: string[] = [];
  page.on("request", (req) => {
    const host = new URL(req.url()).hostname;
    if (host !== "localhost" && host !== "127.0.0.1") external.push(req.url());
  });

  await openBrokerPhase(page);
  await page.getByRole("button", { name: "Find brokers that may list me" }).click();

  const checklist = page.locator('section[aria-labelledby="broker-checklist-heading"]');
  await expect(checklist.getByRole("heading", { name: "Broker checklist" })).toBeVisible();
  const showAll = checklist.getByRole("button", { name: /^Show all \d+$/ });
  if (await showAll.count()) await showAll.first().click();

  const links = checklist.getByRole("link", { name: /^Search on / });
  expect(await links.count()).toBeGreaterThanOrEqual(20);
  for (const link of (await links.all()).slice(0, 20)) {
    const href = (await link.getAttribute("href")) ?? "";
    expect(new URL(href).protocol).toBe("https:");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  }
  // At least one broker search is prefilled with the (URL-encoded) name from the intake.
  const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
  expect(hrefs.some((h) => /Jordan/.test(h) && !/Jordan Testcase/.test(h))).toBe(true);
  // A name-only intake cannot fill a city / state search: those rows ask for a place instead
  // of linking a half-filled search.
  const placeHints = checklist.locator('[data-prefill-hint="add_place"]');
  expect(await placeHints.count()).toBeGreaterThanOrEqual(1);
  await expect(placeHints.first()).toContainText("This search needs a city and state");
  expect(hrefs.some((h) => /=(&|$)/.test(h))).toBe(false);

  // "Not listed" on the first row moves it to the Not listed group.
  const firstNotListed = checklist.getByRole("button", { name: /^Not listed on / }).first();
  const label = (await firstNotListed.getAttribute("aria-label")) ?? "";
  const brokerName = label.replace(/^Not listed on /, "");
  await firstNotListed.click();
  await expect(checklist.getByText("Not listed: 1")).toBeVisible();
  await expect(page.locator('[data-inline-result="saved"]').first()).toBeVisible();

  // A link on another site is refused before anything is fetched, with a visible error.
  const found = checklist.getByRole("button", { name: /^I found my listing on / }).first();
  const foundName = ((await found.getAttribute("aria-label")) ?? "").replace(/^I found my listing on /, "");
  await found.click();
  await checklist.getByLabel(`Address of your profile page on ${foundName}`).fill("https://unrelated.example.org/profile/1");
  await checklist.getByRole("button", { name: "Save listing" }).click();
  const alert = page.getByTestId("toast-region").getByRole("alert");
  await expect(alert).toContainText(/isn't on this broker's website|not on this broker's website/);
  // The toast is fixed to the viewport: visible without scrolling.
  await expect(alert.locator("[data-toast-tone=error]").first()).toBeInViewport();

  // The answer survives a reload, appears in the case timeline, and the reload makes no /api calls.
  const apiCalls: string[] = [];
  page.on("request", (req) => {
    const type = req.resourceType();
    if ((type === "xhr" || type === "fetch") && new URL(req.url()).pathname.startsWith("/api/")) {
      apiCalls.push(`${req.method()} ${req.url()}`);
    }
  });
  await page.goto(caseUrl);
  await page.waitForLoadState("networkidle");
  expect(apiCalls).toEqual([]);
  await openBrokerPhase(page);
  await expect(page.getByText("Not listed: 1")).toBeVisible();
  await expect(page.getByText(`Checked ${brokerName} by hand: not listed`)).toBeVisible();

  expect(external).toEqual([]);
});

test("a previous city / state from the intake prefills city / state broker searches", async ({ page }) => {
  await registerAndCreateCase(page, { previousCityState: "Dayton, OH" });
  await openBrokerPhase(page);
  await page.getByRole("button", { name: "Find brokers that may list me" }).click();

  const checklist = page.locator('section[aria-labelledby="broker-checklist-heading"]');
  await expect(checklist.getByRole("heading", { name: "Broker checklist" })).toBeVisible();
  const showAll = checklist.getByRole("button", { name: /^Show all \d+$/ });
  if (await showAll.count()) await showAll.first().click();

  const hrefs = await checklist
    .getByRole("link", { name: /^Search on / })
    .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
  expect(hrefs.some((h) => decodeURIComponent(h).includes("Dayton, OH"))).toBe(true);
  await expect(checklist.locator('[data-prefill-hint="add_place"]')).toHaveCount(0);
});

test("adding a city and state from the checklist prefills the searches that need one", async ({ page }) => {
  await registerAndCreateCase(page);
  await openBrokerPhase(page);
  await page.getByRole("button", { name: "Find brokers that may list me" }).click();

  const checklist = page.locator('section[aria-labelledby="broker-checklist-heading"]');
  await expect(checklist.getByRole("heading", { name: "Broker checklist" })).toBeVisible();
  await checklist.getByLabel("City and state").fill("Dayton, OH");
  await checklist.getByRole("button", { name: "Save city and state" }).click();

  await expect(checklist.locator('[data-prefill-hint="add_place"]')).toHaveCount(0);
  await expect(checklist.getByLabel("City and state")).toHaveCount(0);
  const showAll = checklist.getByRole("button", { name: /^Show all \d+$/ });
  if (await showAll.count()) await showAll.first().click();
  const hrefs = await checklist
    .getByRole("link", { name: /^Search on / })
    .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
  expect(hrefs.some((h) => decodeURIComponent(h).includes("Dayton, OH"))).toBe(true);
});
