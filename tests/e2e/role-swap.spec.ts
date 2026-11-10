import { expect, test, type Page } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { listCorrections } from "../../src/modules/corrections";
import { createLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";
import { openTab } from "./open-tab";

let connection: DatabaseConnection;

// Значок разработки Next в углу появляется не в каждом прогоне: на снимках его нет
const hideDevIndicator = (page: Page) => page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

test.beforeAll(() => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
});

test.afterAll(async () => {
  await connection.close();
});

test.beforeEach(async ({ context }) => {
  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
});

async function leadWithDraft(name: string) {
  const lead = await createLeadMagnet(connection.db, { name });
  await saveDraft(connection.db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: "Здравствуйте! Чем занимаетесь?" }, "manual");
  return lead;
}

async function openConversation(page: Page) {
  await openTab(page, "Разговор");
  return page.getByRole("tabpanel", { name: "Разговор" });
}

// Роль выбирается кнопкой в нижней строке поля ввода; на ней написана текущая роль (на телефоне — короче)
const roleButton = (page: Page) => page.getByRole("tabpanel", { name: "Разговор" }).getByRole("button", { name: /^(Я пишу |Я отвечаю )?за (клиента|консультанта)$/i });
async function chooseRole(page: Page, role: "Я пишу за клиента" | "Я отвечаю за консультанта") {
  await roleButton(page).click();
  await page.getByRole("menuitem", { name: role }).click();
  // Полная подпись или короткая телефонная — обе кончаются «за клиента» / «за консультанта»
  await expect(roleButton(page)).toHaveAccessibleName(new RegExp(`${role.split(" ").slice(-2).join(" ")}$`, "i"));
}
const consultantMode = (page: Page) => chooseRole(page, "Я отвечаю за консультанта");
const clientMode = (page: Page) => chooseRole(page, "Я пишу за клиента");

test("«Поменяемся ролями»: клиент отвечает, эксперт поправляет реплику клиента, обычная «Проверка» не тронута", async ({ page }) => {
  test.setTimeout(180_000);
  const lead = await leadWithDraft("Лидмагнит для смены ролей");
  await page.goto(`/lead-magnets/${lead.id}`);
  const conversation = await openConversation(page);

  // Обычный разговор: эксперт пишет за клиента
  const previewInput = conversation.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(async () => {
    await previewInput.fill("Я коуч");
    await expect(conversation.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await previewInput.press("Enter");
  await expect(conversation.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.consultantReply })).toBeVisible({ timeout: 30_000 });
  await expect(roleButton(page)).toHaveAccessibleName("Я пишу за клиента");
  await expect(previewInput).toHaveAttribute("placeholder", "Напишите как клиент…");
  // Текст ответа виден раньше, чем ход закончен: снимаем после того, как пропала кнопка «Остановить»
  await expect(conversation.getByRole("button", { name: "Остановить", exact: true })).toBeHidden({ timeout: 30_000 });
  await previewInput.blur();
  await page.mouse.move(0, 0);
  // Панель доходит до угла окна (оболочка ds-react 0.6 без внешнего отступа): значок сборки Next.js попадал бы в снимок
  await hideDevIndicator(page);
  await expect(conversation).toHaveScreenshot("role-swap-client-light.png", { animations: "disabled", caret: "hide", mask: [conversation.locator("time")] });

  await consultantMode(page);
  await expect(conversation.getByText("Агент сыграет клиента лидмагнита")).toBeVisible();
  await hideDevIndicator(page);
  const start = conversation.locator("form").filter({ hasText: "Кто клиент" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(start).toHaveScreenshot(`role-swap-start-${colorScheme}.png`, { animations: "disabled", caret: "hide" });
  }
  await page.emulateMedia({ colorScheme: "light" });

  await conversation.getByRole("textbox", { name: "Кто клиент" }).fill("Начинающий мастер, сомневается в цене");
  await conversation.getByRole("button", { name: "Начать" }).click();

  // Первое сообщение лидмагнита — от эксперта, клиент отвечает
  const clientReplies = conversation.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.clientAutoreply });
  // Спрятанная обычная «Проверка» тоже начинается этим сообщением: поиск по ролям видит только показанную ленту
  const roleSwapFeed = conversation.getByRole("log");
  await expect(roleSwapFeed.getByText("Здравствуйте! Чем занимаетесь?", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(clientReplies).toHaveCount(1, { timeout: 30_000 });
  // У лидмагнита без этапов нода одна: подпись «Этап» повторяла бы название вкладки, над лентой только «Начать заново»
  await expect(conversation.getByRole("button", { name: "Начать заново" })).toBeVisible({ timeout: 30_000 });
  await expect(conversation.getByText(/^Этап:/)).toHaveCount(0);

  const input = conversation.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(input).toHaveAttribute("placeholder", "Ответьте как консультант…");
  await expect(async () => {
    await input.fill("Расскажите, что уже пробовали?");
    await expect(conversation.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await input.press("Enter");
  await expect(clientReplies).toHaveCount(2, { timeout: 30_000 });
  await expect(conversation.getByRole("button", { name: "Отправить", exact: true })).toBeVisible({ timeout: 30_000 });

  // Рамка фокуса и наведение на снимке зависят от того, где остались курсор и фокус
  await input.blur();
  await page.mouse.move(0, 0);
  // Стиль, спрятавший значок сборки Next.js, после начала разговора может пропасть: прячем ещё раз
  await hideDevIndicator(page);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(conversation).toHaveScreenshot(`role-swap-chat-${colorScheme}.png`, {
      animations: "disabled",
      caret: "hide",
      mask: [conversation.locator("time")],
    });
  }
  await page.emulateMedia({ colorScheme: "light" });

  const corrected = "Да так, ничего особо не пробовала.";
  await conversation.getByRole("button", { name: "Поправить" }).last().click();
  const editor = page.getByRole("dialog", { name: "Поправить" });
  await editor.getByRole("textbox", { name: "Поправить" }).fill(corrected);
  await editor.getByRole("textbox", { name: "Почему так лучше" }).fill("Живой человек отвечает короче");
  await editor.getByRole("button", { name: "Сохранить" }).click();
  await expect(editor).toBeHidden({ timeout: 30_000 });
  await expect(conversation.getByText("Исправлено", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Режим помнится, правка и разговор на месте
  await page.reload();
  await openConversation(page);
  await expect(roleButton(page)).toHaveAccessibleName("Я отвечаю за консультанта");
  await expect(conversation.getByRole("paragraph").filter({ hasText: corrected })).toBeVisible({ timeout: 30_000 });
  await expect(conversation.getByText("Исправлено", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Обычная «Проверка» и обратно: оба разговора на месте
  await clientMode(page);
  await expect(conversation.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.consultantReply })).toBeVisible();
  await expect(conversation.getByRole("paragraph").filter({ hasText: corrected })).toBeHidden();
  await consultantMode(page);
  await expect(conversation.getByRole("paragraph").filter({ hasText: corrected })).toBeVisible();

  // «Начать заново» снова спрашивает, кто клиент
  await conversation.getByRole("button", { name: "Начать заново" }).click();
  await expect(conversation.getByRole("textbox", { name: "Кто клиент" })).toBeVisible();
  await conversation.getByRole("button", { name: "Отмена" }).click();
  await expect(conversation.getByRole("paragraph").filter({ hasText: corrected })).toBeVisible();
});

test("«Закончить и разобрать»: разговор закрыт, ответ эксперта в очереди, конструктор получил просьбу", async ({ page }) => {
  test.setTimeout(180_000);
  const lead = await leadWithDraft("Лидмагнит для разбора смены ролей");
  await page.goto(`/lead-magnets/${lead.id}`);
  const conversation = await openConversation(page);
  await consultantMode(page);
  await conversation.getByRole("button", { name: "Начать" }).click();

  const clientReplies = conversation.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.clientAutoreply });
  await expect(clientReplies).toHaveCount(1, { timeout: 30_000 });
  const input = conversation.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(async () => {
    await input.fill("Сколько учеников сейчас?");
    await expect(conversation.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await input.press("Enter");
  await expect(clientReplies).toHaveCount(2, { timeout: 30_000 });

  const finish = conversation.getByRole("button", { name: "Закончить и разобрать" });
  await expect(finish).toBeEnabled({ timeout: 30_000 });
  await finish.click();

  const constructor = page.getByRole("region", { name: "Конструктор", exact: true });
  await expect(constructor).toBeVisible({ timeout: 60_000 });
  await expect(constructor.getByText("Разбери правки ответов консультанта.")).toBeVisible({ timeout: 30_000 });
  await expect(conversation.getByText("Разговор отдан на разбор")).toBeVisible({ timeout: 30_000 });
  await expect(finish).toHaveCount(0);
  await expect(conversation.getByRole("button", { name: "Начать заново" })).toBeVisible();

  const records = await listCorrections(connection.db, lead.id, { status: "all" });
  expect(records.map((record) => [record.source, record.agentRole, record.correctedText])).toEqual([["role_swap", "consultant", "Сколько учеников сейчас?"]]);
});

test("переключатель и экран старта на телефоне — в узкой вёрстке", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const lead = await leadWithDraft("Лидмагнит для смены ролей с телефона");
  await page.goto(`/lead-magnets/${lead.id}`);
  const conversation = await openConversation(page);
  await consultantMode(page);
  await expect(conversation.getByRole("textbox", { name: "Кто клиент" })).toBeVisible();
  await hideDevIndicator(page);
  await expect(page).toHaveScreenshot("role-swap-start-phone.png", { animations: "disabled", caret: "hide" });
});
