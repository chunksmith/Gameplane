import { test, expect, type Page } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage";

// Backups page flows: list rendering, sub-tab switching, and the
// run-snapshot mutation. Restore + schedule modal flows are exercised
// by component-level tests; this spec proves the wiring (list + button
// + mutation) survives a real browser render.

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

test.describe("backups page", () => {
  test.skip(
    process.env.GAMEPLANE_E2E_TARGET === "live",
    "live mode requires a real server and restic-server; mock mode is the deterministic path",
  );

  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("renders the Backups tab with rows from MSW", async ({ page }) => {
    await page.goto("/backups");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.getByRole("heading", { name: /^backups$/i })).toBeVisible();
    // The MSW fixture seeds two backups (one Succeeded, one Failed) on
    // the server "alpha". The table renders one row per backup.
    await expect(page.getByText("alpha-2026-05-07")).toBeVisible();
    await expect(page.getByText("alpha-2026-05-06")).toBeVisible();
  });

  test("switches to Schedules and Restores tabs", async ({ page }) => {
    await page.goto("/backups");

    // HeroUI Tabs: the top-level tab strip is role="tab", not a native button
    // (T137, specs/done_014-heroui-web-rebuild — was a native <button> strip
    // pre-rebuild).
    await page.getByRole("tab", { name: "Server schedules", exact: true }).click();
    await expect(page.getByRole("grid", { name: "Schedules", exact: true }).getByText("alpha-daily")).toBeVisible();

    await page.getByRole("tab", { name: /^restores$/i }).click();
    // Empty restores list shows a placeholder row.
    await expect(page.getByText(/no restores have been run/i)).toBeVisible();
  });

  test("run snapshot triggers a POST to /backups", async ({ page }) => {
    await page.goto("/backups");
    await page.waitForLoadState("domcontentloaded");

    // "Back up now" is a header button that opens the snapshot dialog;
    // the server picker (and the sometimes-hidden destination picker)
    // live inside it. Scope to the dialog so the BackupFilters selects
    // on the page behind never match.
    await page.getByRole("button", { name: /^back up now$/i }).click();
    const dialog = page.getByRole("dialog");

    // HeroUI Select: a compound trigger/popover/listbox, not a native
    // <select> (T137, specs/done_014-heroui-web-rebuild). The trigger's
    // accessible/visible text is its placeholder until a value is chosen;
    // opening it reveals role="option" items.
    await dialog.getByRole("button", { name: /select a server/i }).click();
    await page.getByRole("option", { name: "alpha · local / gameplane-games", exact: true }).click();

    // The button only enables once both the server (we just set) AND
    // the backup destination (auto-set by useEffect once destinations
    // resolve from /backup-destinations) are populated. Wait for that
    // state rather than racing the effect.
    const runBtn = dialog.getByRole("button", { name: /run snapshot/i });
    await expect(runBtn).toBeEnabled({ timeout: 10_000 });

    const created = page.waitForRequest(
      (req) => new URL(req.url()).pathname === "/backups" && req.method() === "POST",
    );
    await runBtn.click();
    const req = await created;
    const requestURL = new URL(req.url());
    expect(requestURL.searchParams.get("cluster") ?? "local").toBe("local");
    expect(requestURL.searchParams.get("namespace")).toBe("gameplane-games");
    const body = req.postDataJSON() as {
      kind?: string;
      spec?: { serverRef?: { name?: string } };
    };
    expect(body.kind).toBe("Backup");
    expect(body.spec?.serverRef?.name).toBe("alpha");
  });
});
