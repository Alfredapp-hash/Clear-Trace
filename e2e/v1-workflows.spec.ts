import { randomUUID } from "crypto";
import { test, expect } from "./fixtures";

test("v1.0 workflow sections appear on case page", async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `v1-${suffix}@test.local`;

  await page.goto("/register");
  await page.getByLabel("Full name").fill("V1 Test User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("testpass1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");

  await page.goto("/cases/new");
  await page.getByLabel("Case title").fill(`V1 Case ${suffix}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Complete intake" }).click();
  await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+/);

  await expect(page.getByRole("button", { name: /Data broker opt-outs/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Search engine cleanup/ })).toBeVisible();
  // Broker opt-outs are an optional phase: collapsed until opened.
  await page.getByRole("button", { name: /Data broker opt-outs/ }).click();
  await expect(page.getByRole("button", { name: "Prepare opt-outs from broker check" })).toBeVisible();
});

test("GET /api/health and manifest are served", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBeTruthy();

  const manifest = await request.get("/manifest.json");
  expect(manifest.ok()).toBeTruthy();
  const body = await manifest.json();
  expect(body.name).toBe("ClearTrace");
  expect(body.icons?.length).toBeGreaterThan(0);
});