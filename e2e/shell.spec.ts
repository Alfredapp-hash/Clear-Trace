import { randomUUID } from "crypto";
import { test, expect } from "./fixtures";

test("intake runs inside the app shell, requires a name, and delete needs typed confirmation", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Shell User");
  await page.getByLabel("Email").fill(`shell-${suffix}@test.local`);
  await page.getByLabel("Password").fill("testpass1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("dashboard-onboarding")).toBeVisible();

  await page.goto("/cases/new");
  // The intake is now inside the shell: primary navigation is on screen.
  await expect(page.getByRole("navigation", { name: "Primary" }).first()).toBeVisible();

  // Errors are announced.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#intake-error")).toHaveAttribute("role", "alert");
  await expect(page.locator("#intake-error")).toContainText("Give the case a name");

  const title = `Shell Case ${suffix}`;
  await page.getByLabel("Case title").fill(title);
  await page.getByRole("button", { name: "Continue" }).click();
  // Focus moves to the new step's heading.
  await expect(page.getByTestId("intake-step-heading")).toBeFocused();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();

  // A full name is required before intake can complete.
  await page.getByRole("button", { name: "Complete intake" }).click();
  await expect(page.locator("#intake-error")).toContainText("Enter the full name");
  await expect(page.getByLabel("Full name", { exact: true })).toBeFocused();

  // Extra details can be added and removed.
  await page.getByRole("button", { name: "Add another detail" }).click();
  await expect(page.getByRole("button", { name: /Remove detail 1/ })).toBeVisible();
  await page.getByRole("button", { name: /Remove detail 1/ }).click();
  await expect(page.getByRole("button", { name: /Remove detail 1/ })).toHaveCount(0);

  await page.getByLabel("Full name", { exact: true }).fill("Jordan Testcase");
  await page.getByRole("button", { name: "Complete intake" }).click();
  await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+$/);

  // Delete uses an in-page dialog with consequences and type-to-confirm.
  await page.getByRole("button", { name: "Delete case" }).click();
  const dialog = page.getByRole("dialog", { name: "Permanently delete this case?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("cannot be undone");
  await expect(dialog).toContainText("audit trail");
  // The confirm button stays disabled until the case title is typed exactly.
  await expect(dialog.getByRole("button", { name: "Delete case permanently" })).toBeDisabled();
  await dialog.getByRole("textbox").fill("not the title");
  await expect(dialog.getByRole("button", { name: "Delete case permanently" })).toBeDisabled();
  await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+$/);

  await dialog.getByRole("textbox").fill(title);
  await dialog.getByRole("button", { name: "Delete case permanently" }).click();
  await expect(page).toHaveURL(/\/cases$/);
  await expect(page.getByText(title)).toHaveCount(0);
});

test("a revoked session cookie lands on /login instead of a redirect loop", async ({ page, context }) => {
  const suffix = randomUUID().slice(0, 8);
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Stale User");
  await page.getByLabel("Email").fill(`stale-${suffix}@test.local`);
  await page.getByLabel("Password").fill("testpass1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");

  const stale = (await context.cookies()).find((c) => c.name === "cleartrace_session");
  expect(stale).toBeTruthy();
  // Sign out everywhere (revokes the JWT), then put the old, still correctly signed cookie back.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await context.addCookies([stale!]);

  for (const path of ["/cases/new", "/cases", "/settings", "/"]) {
    const res = await page.goto(path);
    expect(res?.ok()).toBe(true);
    await expect(page).toHaveURL(/\/login/);
  }
});
