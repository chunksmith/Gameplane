import { test, expect, type Page } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage";

// Schedule-create flow. Schedules tab → "New schedule for" select →
// ScheduleForm fields → POST /schedules with cron + retention.

async function loginIfNeeded(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  if (new URL(page.url()).pathname.startsWith("/login")) {
    const login = new LoginPage(page);
    const username =
      process.env.ADMIN_USERNAME ?? process.env.GAMEPLANE_E2E_ADMIN_USERNAME ?? "e2e-admin";
    const password =
      process.env.ADMIN_PASSWORD ?? process.env.GAMEPLANE_E2E_ADMIN_PASSWORD ?? "any-non-empty";
    await login.login(username, password);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10_000 });
  }
}

test.describe("schedule create", () => {
  test.skip(
    process.env.GAMEPLANE_E2E_TARGET === "live",
    "schedule creation in live mode persists across runs; mock mode is the safe path",
  );

  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("creates a schedule with cron + keepLast", async ({ page }) => {
    await page.goto("/backups");
    await page.waitForLoadState("domcontentloaded");

    // Switch to the Schedules sub-tab.
    await page.getByRole("tab", { name: "Server schedules", exact: true }).click();

    // The Schedules panel renders a "New schedule for" HeroUI Select. Pick
    // alpha and the ScheduleForm appears below.
    // Select with Trigger/Popover/ListBox (Backups.tsx lines 350-371).
    const newScheduleCard = page
      .getByText("New schedule for", { exact: true })
      .locator("..");
    await newScheduleCard.getByRole("button").first().click();
    await page.getByRole("option", { name: "alpha · local / gameplane-games", exact: true }).click();

    // ScheduleForm renders. The cron Input is the first input on the form.
    await expect(page.getByText(/new backup schedule/i)).toBeVisible();
    const cronInput = page.locator('input[placeholder="0 */6 * * *"]');
    await cronInput.fill("*/15 * * * *");

    // keepLast input — RetentionFields renders six number inputs, so target
    // the "Keep last" bucket by its accessible label rather than input[type].
    await page.getByLabel("Keep last").fill("5");

    const created = page.waitForRequest(
      (req) => new URL(req.url()).pathname === "/schedules" && req.method() === "POST",
    );
    await page.getByRole("button", { name: /create schedule/i }).click();
    const req = await created;
    const requestURL = new URL(req.url());
    expect(requestURL.searchParams.get("cluster") ?? "local").toBe("local");
    expect(requestURL.searchParams.get("namespace")).toBe("gameplane-games");
    const body = req.postDataJSON() as {
      spec?: {
        schedule?: string;
        serverRef?: { name?: string };
        retention?: { keepLast?: number };
      };
    };
    expect(body.spec?.schedule).toBe("*/15 * * * *");
    expect(body.spec?.serverRef?.name).toBe("alpha");
    expect(body.spec?.retention?.keepLast).toBe(5);
  });

  test("Create button stays disabled when cron is empty", async ({ page }) => {
    await page.goto("/backups");
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("tab", { name: "Server schedules", exact: true }).click();

    const newScheduleCard = page
      .getByText("New schedule for", { exact: true })
      .locator("..");
    await newScheduleCard.getByRole("button").first().click();
    await page.getByRole("option", { name: "alpha · local / gameplane-games", exact: true }).click();
    await expect(page.getByText(/new backup schedule/i)).toBeVisible();

    // Wipe the cron input — submit must be disabled.
    const cronInput = page.locator('input[placeholder="0 */6 * * *"]');
    await cronInput.fill("");
    await expect(
      page.getByRole("button", { name: /create schedule/i }),
    ).toBeDisabled();
  });
});
