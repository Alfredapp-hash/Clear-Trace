import { randomUUID } from "crypto";
import { test, expect, type Page } from "@playwright/test";

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

  await page.getByRole("button", { name: "Run demo discovery" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).first().click();
  // The guide panel's step selector is a tab, so the workflow action is the only such button.
  await expect(page.getByRole("tab", { name: "Resolve controller" })).toBeVisible();
  await page.getByRole("button", { name: "Resolve controller" }).click();
  await page.getByRole("button", { name: "Use this template" }).click();
  await expect(page.getByRole("button", { name: "Record as sent" })).toBeVisible();

  // Demo hosts don't resolve: a live check must be inconclusive, never "removed".
  await page.getByRole("button", { name: "Live verify (SSRF-safe)" }).click();
  await expect(page.getByText(/inconclusive/i).first()).toBeVisible();

  // Simulation is demo-only and must not change the real case status.
  await page.getByRole("button", { name: "Demo: simulate removed" }).click();
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
