import { randomUUID } from "crypto";
import type { Page } from "@playwright/test";
import { test, expect, browserGet } from "./fixtures";

async function registerAndCreateCase(page: Page, label: string) {
  const suffix = randomUUID().slice(0, 8);
  await page.goto("/register");
  await page.getByLabel("Full name").fill(`${label} User`);
  await page.getByLabel("Email").fill(`${label.toLowerCase()}-${suffix}@test.local`);
  await page.getByLabel("Password").fill("testpass1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");

  await page.goto("/cases/new");
  await page.getByLabel("Case title").fill(`${label} ${suffix}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Full name", { exact: true }).fill("Jordan Testcase");
  await page.getByRole("button", { name: "Complete intake" }).click();
  await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+$/);
  return page.url();
}

test("consent_verified case: one primary next action and only the current phase open", async ({ page }) => {
  await registerAndCreateCase(page, "NextStep");

  const workflow = page.getByTestId("case-workflow");
  await expect(workflow).toBeVisible();

  // The first interactive element in the workflow card is the single primary button.
  const first = await workflow.evaluate((root) => {
    const el = root.querySelector<HTMLElement>(
      "button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex='-1'])",
    );
    return el ? { tag: el.tagName, text: el.textContent?.trim() ?? "" } : null;
  });
  expect(first).toEqual({ tag: "BUTTON", text: "Search for my information" });

  // Only the current phase is expanded; there are five numbered phases.
  const toggles = page.locator('[id^="phase-"][id$="-toggle"]');
  await expect(toggles).toHaveCount(5);
  await expect(page.locator('[id^="phase-"][id$="-toggle"][aria-expanded="true"]')).toHaveCount(1);
  await expect(page.locator("#phase-discovery-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#phase-remediation-toggle")).toBeDisabled();
  await expect(page.getByText("Unlocks after you confirm a match").first()).toBeVisible();

  // No old runner name or jargon in the visible page (built from parts so greps stay clean).
  const text = await page.locator("body").innerText();
  for (const word of ["Her" + "mes", "SS" + "RF", "controller_resolution", "consent_verified"]) {
    expect(text).not.toContain(word);
  }
});

test("keyboard users can toggle a phase and aria-expanded updates", async ({ page }) => {
  await registerAndCreateCase(page, "Keys");

  const broker = page.locator("#phase-broker-toggle");
  await expect(broker).toHaveAttribute("aria-expanded", "false");
  await broker.focus();
  await page.keyboard.press("Enter");
  await expect(broker).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Prepare opt-outs from broker check" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(broker).toHaveAttribute("aria-expanded", "false");
});

test("case page makes no workflow requests after hydration and searches in sample mode without a key", async ({ page }) => {
  const caseUrl = await registerAndCreateCase(page, "Xhr");

  const apiCalls: string[] = [];
  page.on("request", (req) => {
    const type = req.resourceType();
    if ((type === "xhr" || type === "fetch") && req.url().includes("/api/cases/")) {
      apiCalls.push(`${req.method()} ${req.url()}`);
    }
  });
  await page.goto(caseUrl);
  await page.waitForLoadState("networkidle");
  expect(apiCalls).toEqual([]);

  // Without a search connector the banner explains sample results and the POST uses demo mode.
  await expect(
    page.getByText("These are sample results. Add a search key in Settings to search the real web."),
  ).toBeVisible();
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.method() === "POST" && /\/api\/cases\/[^/]+\/discovery$/.test(r.url())),
    page.getByTestId("next-step").getByRole("button", { name: "Search for my information" }).click(),
  ]);
  expect(req.postDataJSON()).toEqual({ mode: "demo" });
  await expect(page.getByText("Sample", { exact: true }).first()).toBeVisible();
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("next-step card comes first, guide is collapsed and there is no horizontal scroll", async ({ page }) => {
    await registerAndCreateCase(page, "Mobile");

    const hero = page.getByTestId("next-step");
    await expect(hero).toBeVisible();
    const heroBox = await hero.boundingBox();
    const guideToggle = page.getByRole("button", { name: "Show guide" });
    await expect(guideToggle).toHaveAttribute("aria-expanded", "false");
    const guideBox = await guideToggle.boundingBox();
    expect(heroBox && guideBox && heroBox.y < guideBox.y).toBeTruthy();

    // Agent handoff copy blocks stay hidden until the guide and the details are opened.
    await expect(page.getByText("Use an external AI agent (advanced)")).toBeHidden();
    await guideToggle.click();
    await expect(page.getByText("Use an external AI agent (advanced)")).toBeVisible();
    // The handoff (pack text + its copy button) stays inside the closed <details>.
    await expect(page.getByText("Full markdown pack", { exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Copy full markdown pack" })).toBeHidden();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("'Finish setup' on a draft case resumes that case instead of creating a second one", async ({ page }) => {
  await registerAndCreateCase(page, "Resume");
  // A case whose intake stopped after creation (no authorization recorded): status draft.
  // Created from the page (same-origin fetch), like the wizard's first step does.
  const { status, caseId } = await page.evaluate(async () => {
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Abandoned intake",
        caseType: "personal_exposure",
        targetRelationship: "self",
        scanScopes: ["people_search"],
      }),
    });
    return { status: res.status, caseId: ((await res.json()) as { caseId: string }).caseId };
  });
  expect(status).toBe(201);
  const countCases = async () => {
    const { body } = await browserGet(page, "/api/cases");
    return ((body as { cases: unknown[] }).cases).length;
  };
  const before = await countCases();

  await page.goto(`/cases/${caseId}`);
  const finish = page.getByTestId("next-step").getByRole("link", { name: "Finish setup" });
  await expect(finish).toHaveAttribute("href", `/cases/new?caseId=${caseId}`);
  await finish.click();
  await expect(page).toHaveURL(new RegExp(`/cases/new\\?caseId=${caseId}$`));
  await expect(page.getByRole("heading", { name: "Finish setting up your case" })).toBeVisible();

  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Full name", { exact: true }).fill("Jordan Testcase");
  await page.getByRole("button", { name: "Complete intake" }).click();
  await expect(page).toHaveURL(new RegExp(`/cases/${caseId}$`));
  expect(await countCases()).toBe(before);
  await expect(
    page.getByTestId("next-step").getByRole("button", { name: "Search for my information" }),
  ).toBeVisible();
});
