import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL } from "./e2e-env";

test.beforeEach(async ({ context }) => {
  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
});

test("эксперт создаёт лидмагнит, правит его через конструктор и проходит тестовый разговор", async ({ page }) => {
  // Первая сборка страниц в `next dev` долгая
  test.setTimeout(180_000);

  await page.goto("/");
  await page.getByLabel("Название").fill("Сквозной лидмагнит");
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page).toHaveURL(/\/lead-magnets\/[0-9a-f-]{36}$/, { timeout: 60_000 });

  const constructor = page.getByRole("region", { name: "Конструктор" });
  const constructorInput = constructor.getByRole("textbox");
  await page.getByRole("tab", { name: "Настройки" }).click();
  const firstMessageField = page.getByLabel("Чем агент начинает разговор (обязательно)");

  // Пока конструктор правит черновик, форма закрыта; после хода — с новыми значениями
  await constructorInput.fill(`${E2E_SCRIPT.slowTrigger}: сделай первое сообщение и этап знакомства`);
  await expect(page.getByRole("region", { name: "Конструктор", exact: true }).getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  await constructorInput.press("Enter");
  const busyBanner = page.getByText("Конструктор правит черновик…");
  await expect(busyBanner).toBeVisible();
  await expect(firstMessageField).toBeDisabled();
  await expect(constructor.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.constructorDone })).toBeVisible({ timeout: 30_000 });
  await expect(busyBanner).toBeHidden();
  await expect(firstMessageField).toBeEnabled();
  await expect(firstMessageField).toHaveValue(E2E_SCRIPT.firstMessage);

  // Несохранённая правка в настройках закрывает отправку конструктору; «Отменить» её сбрасывает
  await firstMessageField.fill("Черновик правки");
  const hint = constructor.getByText("Сначала сохраните или отмените правку в Настройках");
  await expect(hint).toBeVisible();
  await expect(constructorInput).toBeDisabled();
  await page.getByRole("button", { name: "Отменить" }).click();
  await expect(firstMessageField).toHaveValue(E2E_SCRIPT.firstMessage);
  await expect(hint).toBeHidden();
  await expect(constructorInput).toBeEnabled();

  // Новый разговор начинается с нового первого сообщения
  await page.getByRole("tab", { name: "Разговор" }).click();
  await page.getByRole("button", { name: "Начать проверку заново" }).click();
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  // Первый тест прогона ловит холодную сборку страниц: перезапуск проверки идёт дольше 5 с
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.firstMessage })).toBeVisible({ timeout: 30_000 });
  // Подпись ноды над чатом — из места чата в сценарии
  await expect(preview.getByText(`Этап: ${E2E_SCRIPT.stageName}`)).toBeVisible();

  const previewInput = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await previewInput.fill("Я коуч");
  await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  await previewInput.press("Enter");
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.consultantReply })).toBeVisible({ timeout: 30_000 });

  await previewInput.fill("Я готов к созвону");
  // Ответ виден раньше, чем лента закрыла ход: Enter до этого ничего не отправляет
  await expect(preview.getByRole("button", { name: "Отправить" })).toBeEnabled();
  await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  await previewInput.press("Enter");
  await expect(preview.getByText("Диалог завершён")).toBeVisible({ timeout: 30_000 });
  // Прощание — в ленте, в конце последнего ответа, как в мессенджере; под полем ввода его нет
  const lastAnswer = preview.locator("[data-feed-item]").filter({ hasText: E2E_SCRIPT.finalReply });
  await expect(lastAnswer).toContainText(E2E_SCRIPT.farewell);
  await expect(preview.getByText(E2E_SCRIPT.farewell)).toHaveCount(1);
  // Написать после конца нельзя: поле закрыто, причина только для экранного чтеца, ошибки нет
  await expect(previewInput).toBeDisabled();
  await expect(previewInput).toHaveAccessibleDescription(/Начать проверку заново/);
  await expect(preview.getByText("Что-то пошло не так")).toHaveCount(0);
});

test("в проверке лента едет за длинным ответом, даже если сообщение набрано с клавиатуры", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/");
  await page.getByLabel("Название").fill("Лидмагнит с длинными ответами");
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page).toHaveURL(/\/lead-magnets\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const constructorInput = page.getByRole("region", { name: "Конструктор" }).getByRole("textbox");
  await constructorInput.fill("сделай");
  await expect(page.getByRole("region", { name: "Конструктор", exact: true }).getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  await constructorInput.press("Enter");
  await page.getByRole("button", { name: "Начать проверку заново" }).click({ timeout: 30_000 });

  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  const previewInput = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.firstMessage })).toBeVisible();

  // История выше ленты: до отправки лента уже прокручена вниз
  const replies = preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.consultantReply });
  for (let turn = 1; turn <= 4; turn++) {
    await previewInput.fill(`Сообщение ${turn}`);
    await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
    await previewInput.press("Enter");
    await expect(replies).toHaveCount(turn, { timeout: 30_000 });
    // Ход закончен (у ответа появилась «Переделать ответ»), а не только напечатан: Enter посреди хода чат не отправляет
    await expect(preview.getByRole("button", { name: "Переделать ответ" })).toBeVisible();
  }

  // Пробел, набранный в поле ввода, — не прокрутка ленты
  await previewInput.click();
  await previewInput.pressSequentially(`Расскажи ${E2E_SCRIPT.longTrigger}`, { delay: 40 });
  await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  await previewInput.press("Enter");

  const lastMessageAboveInput = async () => {
    const last = await preview.locator("[data-feed-item]").last().boundingBox();
    const input = await previewInput.boundingBox();
    return Boolean(last && input && last.y + last.height <= input.y + 1);
  };
  await expect.poll(lastMessageAboveInput, { timeout: 2_000 }).toBe(true);
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.longReplyEnd })).toBeVisible({ timeout: 30_000 });
  await expect.poll(lastMessageAboveInput, { timeout: 2_000 }).toBe(true);
});

test("после хода конструктора: кнопка перезапуска на всех вкладках, в «Логе» видны вызовы, откат — через подтверждение", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/");
  await page.getByLabel("Название").fill("Лидмагнит с журналом");
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page).toHaveURL(/\/lead-magnets\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const constructor = page.getByRole("region", { name: "Конструктор" });
  const constructorInput = constructor.getByRole("textbox");
  await constructorInput.fill("сделай первое сообщение");
  await expect(page.getByRole("region", { name: "Конструктор", exact: true }).getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  await constructorInput.press("Enter");
  await expect(constructor.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.constructorDone })).toBeVisible({ timeout: 30_000 });

  const restart = page.getByRole("button", { name: "Начать проверку заново" });
  for (const tab of ["Настройки", "История", "Лог"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(restart).toBeVisible();
  }

  // Лог: ход конструктора — вызов модели с вызовом инструмента и сам вызов инструмента
  const log = page.getByRole("tabpanel", { name: "Лог" });
  const turn = log.getByRole("list", { name: "Ходы агентов" }).getByRole("listitem").filter({ hasText: "Конструктор" }).first();
  await expect(turn.getByText("вызывает edit_lead_magnet")).toBeVisible({ timeout: 10_000 });
  const toolCall = turn.locator("summary").filter({ hasText: "Инструмент · edit_lead_magnet" });
  await expect(toolCall).toBeVisible();
  await toolCall.click();
  await expect(turn.getByText("Аргументы")).toBeVisible();

  // Откат спрашивает подтверждение; «Отмена» ничего не меняет
  await page.getByRole("tab", { name: "История" }).click();
  const versions = page.getByRole("list", { name: "Версии" }).getByRole("listitem");
  await expect(versions).toHaveCount(2);
  await page.getByRole("button", { name: "Откатить" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Вернуть черновик к версии от .+\?/)).toBeVisible();
  await expect(dialog.getByText("Текущий черновик останется в Истории.")).toBeVisible();
  await dialog.getByRole("button", { name: "Отмена" }).click();
  await expect(dialog).toBeHidden();
  await expect(versions).toHaveCount(2);

  await page.getByRole("button", { name: "Откатить" }).click();
  await dialog.getByRole("button", { name: "Вернуть" }).click();
  await expect(dialog).toBeHidden();
  await expect(versions).toHaveCount(3);
  await expect(versions.first().getByText("Откат")).toBeVisible();
});
