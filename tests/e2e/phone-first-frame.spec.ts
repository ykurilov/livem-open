import { devices, expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { createLeadMagnet } from "../../src/modules/lead-magnets";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

// Телефон: userAgent и касания как у настоящего
test.use({ userAgent: devices["Pixel 7"].userAgent, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

let connection: DatabaseConnection;
test.beforeAll(() => { connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 1 }); });
test.afterAll(async () => { await connection.close(); });

test("на телефоне у нового лидмагнита конструктор открыт на весь экран с первого кадра, вкладка не переключается после загрузки", async ({ page, context }) => {
  const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
  const lead = await createLeadMagnet(connection.db, { name: "Телефон: первый кадр" });

  // Записываем каждую вкладку, которая хоть на кадр была выбрана, и было ли хоть на кадр скрыто окно конструктора
  await page.addInitScript(() => {
    const seen = new Set<string>();
    const state = { selectedTabs: seen, panelHidden: false };
    (window as unknown as { editorFrames: typeof state }).editorFrames = state;
    const note = () => {
      document.querySelectorAll('[role="tab"][aria-selected="true"]').forEach((tab) => seen.add(tab.textContent ?? ""));
      const panel = document.getElementById("constructor-panel");
      if (panel && getComputedStyle(panel).display === "none") state.panelHidden = true;
    };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true });
  });
  await page.goto(`/lead-magnets/${lead.id}`);
  const panel = page.getByRole("region", { name: "Конструктор", exact: true });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  // Окно конструктора закрывает экран целиком
  const box = (await panel.boundingBox())!;
  expect(box.width).toBe(390);
  // Страница ожила: кнопка закрытия работает, лишних переключений не было
  const close = panel.getByRole("button", { name: "Закрыть конструктор" });
  await expect.poll(() => close.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps$")))).toBe(true);
  const frames = await page.evaluate(() => {
    const state = (window as unknown as { editorFrames: { selectedTabs: Set<string>; panelHidden: boolean } }).editorFrames;
    return { tabs: [...state.selectedTabs], panelHidden: state.panelHidden };
  });
  expect(frames).toEqual({ tabs: ["Разговор"], panelHidden: false });
  await close.click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("tab", { name: "Разговор", exact: true })).toBeVisible();
});
