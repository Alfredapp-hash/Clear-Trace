import { randomUUID } from "crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function register(page: Page, label: string) {
  const suffix = randomUUID().slice(0, 8);
  await page.goto("/register");
  await page.getByLabel("Full name").fill(`${label} User`);
  await page.getByLabel("Email").fill(`${label.toLowerCase()}-${suffix}@test.local`);
  await page.getByLabel("Password").fill("testpass1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");
  return suffix;
}

async function createCase(page: Page, title: string) {
  await page.goto("/cases/new");
  await page.getByLabel("Case title").fill(title);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("Encrypted on save").fill("Jordan Testcase");
  await page.getByRole("button", { name: "Complete intake" }).click();
  await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+$/);
  return page.url();
}

test("core workflow: discovery → draft → verification never reports a false removal", async ({ page }) => {
  const suffix = await register(page, "Core");
  await createCase(page, `Core ${suffix}`);

  // Identity claim is stored encrypted and only shown masked.
  await expect(page.getByText("Jordan Testcase")).toHaveCount(0);

  // One primary next action: on a fresh case the hero searches (sample mode without a key).
  await page.getByTestId("next-step").getByRole("button", { name: "Search for my information" }).click();
  await expect(page.getByRole("button", { name: /^This is me/ })).toHaveCount(6);
  await page.getByRole("button", { name: /^This is me/ }).first().click();

  // Confirming one match never hides the others: the hero keeps reviewing and the
  // discovery phase stays open until every possible match has a decision.
  const hero = page.getByTestId("next-step");
  await expect(hero.getByRole("button", { name: "Review 5 possible matches" })).toBeVisible();
  await expect(page.locator("#phase-discovery-toggle")).toHaveAttribute("aria-expanded", "true");
  const notMe = page.getByRole("button", { name: /^Not me/ });
  await expect(notMe).toHaveCount(5);
  for (let left = 5; left > 0; left--) {
    await notMe.first().click();
    await expect(notMe).toHaveCount(left - 1);
  }

  // Every match decided: the case moves on to "find who to contact" for the confirmed page.
  await expect(hero.getByRole("heading", { name: "Find who to contact" })).toBeVisible();
  await hero.getByRole("button", { name: "Find who to contact" }).click();
  await page.getByRole("button", { name: "Use this template" }).click();
  await expect(page.getByRole("button", { name: "Mark as sent" })).toBeVisible();
  await page.getByRole("button", { name: "Mark as sent" }).click();

  // After sending, removal checks are the current phase.
  const checks = page.locator("#phase-verification-body");
  await expect(page.locator("#phase-verification-toggle")).toHaveAttribute("aria-expanded", "true");
  // Demo hosts don't resolve: a live check must be inconclusive, never "removed".
  await checks.getByRole("button", { name: "Check if it's gone" }).first().click();
  await expect(page.getByText(/could not confirm either way/i).first()).toBeVisible();

  // Simulation is demo-only and must not change the real case status.
  await checks.getByRole("button", { name: "Demo: simulate removed" }).first().click();
  await expect(page.getByText(/simulated/i).first()).toBeVisible();
  const status = await page.request.get(page.url().replace("/cases/", "/api/cases/"));
  const body = await status.json();
  expect(body.case?.status ?? body.status).not.toBe("removed_confirmed");
});

test("logout revokes the session everywhere", async ({ page, browser }) => {
  await register(page, "Logout");
  const cookies = await page.context().cookies();

  // A second "device" with a copy of the same cookie.
  const other = await browser.newContext();
  await other.addCookies(cookies);
  expect((await other.request.get("/api/auth/me")).status()).toBe(200);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  expect((await other.request.get("/api/auth/me")).status()).toBe(401);
  await other.close();
});

test("another account cannot open someone else's case", async ({ page, browser }) => {
  const suffix = await register(page, "Owner");
  const caseUrl = await createCase(page, `Private ${suffix}`);

  const intruder = await browser.newContext();
  const p2 = await intruder.newPage();
  await register(p2, "Intruder");
  const res = await p2.goto(caseUrl);
  expect(res?.status()).toBe(404);
  const api = await p2.request.get(caseUrl.replace("/cases/", "/api/cases/") + "/discovery");
  expect(api.status()).toBe(404);
  await intruder.close();
});
