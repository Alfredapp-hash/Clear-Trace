import { randomUUID } from "crypto";
import { test, expect } from "./fixtures";

test("GET /api/health returns ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.status).toBe("ok");
});

test("register and complete case intake", async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `e2e-${suffix}@test.local`;

  await page.goto("/register");
  await page.getByLabel("Full name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("testpass1234");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL("/");

  await page.goto("/cases/new");
  await page.getByLabel("Case title").fill(`E2E Case ${suffix}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();
  // Intake requires the full name to search for (Sprint 5, B9).
  await page.getByLabel("Full name", { exact: true }).fill("Jordan Testcase");
  await page.getByRole("button", { name: "Complete intake" }).click();

  await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+/);
});