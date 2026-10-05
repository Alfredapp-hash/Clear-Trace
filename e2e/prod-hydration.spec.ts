/**
 * Proves the production bundle hydrates: the checks below only pass when React has attached
 * on the client (effects ran, client-side navigation works) and nothing logged console.error
 * or tripped the Content-Security-Policy. Runs against `npm run dev` locally and against the
 * Docker image in CI (PLAYWRIGHT_BASE_URL).
 */
import { test, expect } from "./fixtures";

test("login page hydrates: client effect renders the registration footer", async ({ page }) => {
  await page.goto("/login");
  // The footer is null in the server HTML; only the client effect (registration-status fetch)
  // fills it in, so seeing either variant proves hydration.
  const open = page.getByRole("link", { name: "Create one" });
  const closed = page.getByTestId("registration-closed");
  await expect(open.or(closed)).toBeVisible();
});

test("client-side navigation keeps the page alive (no full reload)", async ({ page }) => {
  await page.goto("/login");
  const open = page.getByRole("link", { name: "Create one" });
  const closed = page.getByTestId("registration-closed");
  await expect(open.or(closed)).toBeVisible();
  test.skip(await closed.isVisible(), "registration is closed on this instance");

  // A marker on window survives only a client-side (router) navigation.
  await page.evaluate(() => {
    (window as unknown as { __hydrationMarker?: number }).__hydrationMarker = 42;
  });
  await open.click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  const marker = await page.evaluate(
    () => (window as unknown as { __hydrationMarker?: number }).__hydrationMarker,
  );
  expect(marker).toBe(42);
});
