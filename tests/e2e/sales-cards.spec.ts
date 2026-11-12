import { expect, test, type Locator, type Page } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { createLeadMagnet, getLeadMagnet } from "../../src/modules/lead-magnets";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

let connection: DatabaseConnection;
test.beforeAll(() => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
});
test.afterAll(async () => {
  await connection.close();
});
test.beforeEach(async ({ context }) => {
  const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
});

async function openBoard(page: Page, id: string): Promise<Locator> {
  await expect(async () => {
    await page.goto(`/lead-magnets/${id}`);
  }).toPass({ timeout: 60_000 });
  const tab = page.getByRole("tab", { name: "Сценарий" });
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  const board = page.getByRole("tabpanel", { name: "Сценарий" });
  await expect(board.getByRole("application")).toBeVisible({ timeout: 60_000 });
  await expect(board.getByText("Только просмотр")).toBeHidden({ timeout: 60_000 });
  return board;
}

/** Заполнить окно заготовки и сохранить: окно закрывается, когда сервер записал заготовку. */
async function fillCard(page: Page, card: { title: string; when: string; text: string; verbatim: boolean }) {
  const dialog = page.getByRole("dialog", { name: "Новая заготовка" });
  await dialog.getByLabel("Название").fill(card.title);
  await dialog.getByLabel("Когда уместна").fill(card.when);
  await dialog.getByRole("textbox", { name: /^Текст/ }).fill(card.text);
  await dialog.getByRole("radio", { name: card.verbatim ? /^Дословно/ : /^Своими словами/ }).check();
  return dialog;
}

test("эксперт добавляет заготовку этапа и шпаргалки на доске — они сохранены в черновике", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const lead = (await getLeadMagnet(connection.db, (await createLeadMagnet(connection.db, { name: "Заготовки на доске" })).id))!;
  const stage = lead.draft.flow.states.find((state) => state.exits.length > 0)!;
  const board = await openBoard(page, lead.id);

  // Заготовка этапа — в панели этапа
  await board.locator(`.react-flow__node[data-id="${stage.id}"]`).click();
  const section = board.getByRole("region", { name: "Заготовки этапа", exact: true });
  await section.scrollIntoViewIfNeeded();
  await section.getByRole("button", { name: "Добавить заготовку" }).click();
  const dialog = await fillCard(page, { title: "Цена", when: "Человек спрашивает, сколько стоит", text: "Курс стоит 9 900 ₽.", verbatim: true });
  await page.screenshot({ path: test.info().outputPath("cards-dialog.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(section.getByRole("button", { name: /Цена/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("cards-stage.png") });

  // Общая шпаргалка — в обзоре сценария
  await board.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
  await board.getByRole("button", { name: "Показать панель «Сценарий»", exact: true }).click();
  const common = board.getByRole("region", { name: "Шпаргалка возражений", exact: true });
  await common.scrollIntoViewIfNeeded();
  await common.getByRole("button", { name: "Добавить заготовку" }).click();
  const commonDialog = await fillCard(page, { title: "Дорого", when: "Человек сомневается из-за цены", text: "Есть рассрочка на 3 месяца.", verbatim: false });
  await commonDialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(commonDialog).toBeHidden({ timeout: 30_000 });
  await expect(common.getByRole("button", { name: /Дорого/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("cards-common.png") });

  await expect
    .poll(async () => (await getLeadMagnet(connection.db, lead.id))!.draft.salesCards, { timeout: 30_000 })
    .toEqual([
      expect.objectContaining({ stateId: stage.id, title: "Цена", when: "Человек спрашивает, сколько стоит", text: "Курс стоит 9 900 ₽.", verbatim: true }),
      expect.objectContaining({ stateId: null, title: "Дорого", text: "Есть рассрочка на 3 месяца.", verbatim: false }),
    ]);
});
