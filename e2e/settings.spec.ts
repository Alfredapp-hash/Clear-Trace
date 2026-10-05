import { randomUUID } from "crypto";
import { test, expect } from "@playwright/test";

test("settings loads its data on the server: no /api requests after hydration", async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Settings User");
  await page.getByLabel("Email").fill(`settings-${suffix}@test.local`);
  await page.getByLabel("Password").fill("testpass1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");

  const apiCalls: string[] = [];
  page.on("request", (req) => {
    const type = req.resourceType();
    if ((type === "xhr" || type === "fetch") && new URL(req.url()).pathname.startsWith("/api/")) {
      apiCalls.push(`${req.method()} ${req.url()}`);
    }
  });
  await page.goto("/settings");
  await expect(page.locator("#household-heading")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(apiCalls).toEqual([]);
});
