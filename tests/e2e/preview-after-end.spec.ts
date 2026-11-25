import { expect, test, type Locator, type Page } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { createLeadMagnet, getLeadMagnet, saveDraft, type ReturnAfterProgramMode } from "../../src/modules/lead-magnets";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";
import { openTab } from "./open-tab";

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

async function seedLead(name: string, returnAfterProgram: ReturnAfterProgramMode) {
  const lead = await createLeadMagnet(connection.db, { name: `${name} ${Date.now().toString(36)}` });
  await saveDraft(connection.db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage, returnAfterProgram }, "manual");
  return lead.id;
}

/** Тестовый разговор с нуля до конца: первое сообщение, ответ, согласие. */
async function talkToTheEnd(page: Page): Promise<{ preview: Locator; input: Locator }> {
  await openTab(page, "Разговор");
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.firstMessage })).toBeVisible({ timeout: 60_000 });
  const input = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await send(preview, input, "Я дизайнер");
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.consultantReply })).toBeVisible({ timeout: 30_000 });
  await send(preview, input, `Я ${E2E_SCRIPT.finishTrigger} к созвону`);
  await expect(preview.getByText("Диалог завершён")).toBeVisible({ timeout: 30_000 });
  return { preview, input };
}

async function send(preview: Locator, input: Locator, text: string) {
  // Ввод до того, как поле достроилось, пропадает: повторяем, пока «Отправить» не станет доступна
  await expect(async () => {
    await input.fill(text);
    await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await input.press("Enter");
}

test("«Напоминать» и «Ждать ответа» в «Настройках»; после конца «Проверка» отвечает вернувшемуся и через месяц", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await seedLead("Продолжение после конца", "continue");
  await page.goto(`/lead-magnets/${id}`);

  // Сроки молчания: по умолчанию напоминать 3 дня, ждать без срока
  const remind = page.getByLabel("Напоминать, дней");
  await openTab(page, "Настройки", remind);
  const wait = page.getByLabel("Ждать ответа, дней");
  await expect(remind).toHaveValue("3");
  await expect(wait).toHaveValue("");
  await remind.fill("5");
  await wait.fill("2");
  await expect(page.getByText("«Напоминать» не может быть дольше «Ждать ответа»")).toBeVisible();
  await wait.fill("30");
  await expect(page.getByText("«Напоминать» не может быть дольше «Ждать ответа»")).toBeHidden();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Сохранено" })).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await getLeadMagnet(connection.db, id))?.draft.flow.nudges)
    .toMatchObject({ stopAfter: { amount: 5, unit: "d" }, giveUpAfter: { amount: 30, unit: "d" } });

  // Конец разговора не закрывает поле: эксперт пишет как вернувшийся клиент
  const { preview, input } = await talkToTheEnd(page);
  await expect(preview.getByText("Напишите как вернувшийся клиент")).toBeVisible();
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await expect(preview.getByRole("button", { name: "Продолжить разговор" })).toHaveCount(0);

  // Через месяц человек вернулся — агент отвечает в тот же разговор
  await preview.getByRole("button", { name: /^(Промотать время|Время)$/ }).click();
  await page.getByRole("menu", { name: "Промотать время" }).getByRole("menuitem", { name: "+1 месяц" }).click();
  await expect(page.getByText("Что-то пошло не так")).toHaveCount(0);
  const replies = preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.consultantReply });
  await send(preview, input, "Снова я, есть вопрос");
  await expect(replies).toHaveCount(2, { timeout: 30_000 });
});

test("«Входящие» после конца: вместо поля плашка, «Продолжить разговор» открывает его снова", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await seedLead("Плашка конца", "inbox");
  await page.goto(`/lead-magnets/${id}`);
  const { preview, input } = await talkToTheEnd(page);

  // Написать после конца нельзя: вместо поля — плашка конца с подсказкой, ошибки нет
  await expect(input).toBeHidden();
  await expect(preview.getByText("Чтобы писать дальше, продолжите разговор")).toBeVisible();
  await expect(preview.getByText("Что-то пошло не так")).toHaveCount(0);

  // «Продолжить разговор» снимает конец: поле снова открыто, «Автоответ» сразу отправляет реплику клиента
  await page.getByRole("button", { name: "Продолжить разговор" }).click();
  await expect(preview.getByText("Диалог завершён")).toBeHidden({ timeout: 30_000 });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await preview.getByRole("button", { name: "Автоответ" }).click();
  await expect(preview.getByText(E2E_SCRIPT.clientAutoreply)).toBeVisible({ timeout: 30_000 });
  await expect(input).toHaveValue("");
});
