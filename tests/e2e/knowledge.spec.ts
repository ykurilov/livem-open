import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { openCreateForm, openTab } from "./open-tab";
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

/** Новый лидмагнит с главной: пока лидмагнитов нет, форма создания открыта сразу, иначе — по кнопке «Новый лидмагнит». */
async function createLeadMagnet(page: Page, name: string) {
  await page.goto("/");
  await openCreateForm(page);
  await page.getByLabel("Название").fill(name);
  await page.getByRole("button", { name: "Создать" }).click();
  await expect(page).toHaveURL(/\/lead-magnets\/[0-9a-f-]{36}$/, { timeout: 60_000 });
}

test("эксперт загружает текст, прикрепляет его к лидмагниту, и в проверке консультант отвечает по нему", async ({ page }) => {
  test.setTimeout(180_000);
  // Хвост — чтобы не спутать с базами соседних прогонов
  const tag = randomUUID().slice(0, 6);
  const title = `Частые вопросы ${tag}`;
  const fact = `Курс длится шесть недель, код ${tag}.`;

  // Старый адрес «Медиа» открывается, а вкладка «Тексты» ведёт в базу знаний
  await page.goto("/videos");
  // `next dev` бывает перезагружает открытые страницы, и нажатие теряется: жмём снова, пока не перейдёт
  await expect(async () => {
    await page.getByRole("tab", { name: "Тексты", exact: true }).click();
    await expect(page).toHaveURL(/\/knowledge$/, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Добавить текст" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Название").fill(title);
  await form.getByLabel("Файл базы знаний").setInputFiles({ name: "вопросы.docx", mimeType: "application/octet-stream", buffer: Buffer.from("текст") });
  await form.getByRole("button", { name: "Сохранить" }).click();
  await expect(form.getByRole("alert").filter({ hasText: ".txt, .md или .pdf" })).toBeVisible();
  await expect(form.getByLabel("Название")).toHaveValue(title);
  // Файл больше предела сервер не примет: ошибка у поля сразу, набранное название остаётся
  await form.getByLabel("Файл базы знаний").setInputFiles({ name: "огромный.md", mimeType: "text/markdown", buffer: Buffer.alloc(1024 * 1024 + 1, "а") });
  await expect(form.getByRole("alert").filter({ hasText: "больше 1 МБ" })).toBeVisible();
  await expect(form.getByText("Файл не выбран")).toBeVisible();
  await expect(form.getByLabel("Название")).toHaveValue(title);
  // После «Отмена» окно открывается чистым: без прошлого файла и прошлой ошибки
  await form.getByRole("button", { name: "Отмена" }).click();
  await expect(form).toBeHidden();
  await page.getByRole("button", { name: "Добавить текст" }).click();
  await expect(form.getByText("Файл не выбран")).toBeVisible();
  await expect(form.getByRole("alert").filter({ hasText: ".txt, .md или .pdf" })).toHaveCount(0);
  await form.getByLabel("Название").fill(title);
  await form.getByLabel("Файл базы знаний").setInputFiles({ name: "вопросы.md", mimeType: "text/markdown", buffer: Buffer.from(`${fact}\nВторая строка.`) });
  await form.getByRole("button", { name: "Сохранить" }).click();
  await expect(form).toBeHidden();
  const row = page.getByRole("row").filter({ hasText: title });
  await expect(row).toContainText("Ни к одному лидмагниту");

  await createLeadMagnet(page, `Лидмагнит с базой ${tag}`);
  const constructorInput = page.getByRole("region", { name: "Конструктор" }).getByRole("textbox");
  // Ввод до того, как поле достроилось, пропадает: повторяем, пока «Отправить» не станет доступна
  await expect(async () => {
    await constructorInput.fill("сделай");
    await expect(page.getByRole("region", { name: "Конструктор", exact: true }).getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await constructorInput.press("Enter");
  await expect(page.getByRole("button", { name: "Начать заново" })).toBeVisible({ timeout: 30_000 });

  await openTab(page, "Настройки");
  await page.getByRole("checkbox", { name: new RegExp(title) }).check();
  await expect(page.getByText(/Занято \d[\d ]* из 200 000 знаков/)).toBeVisible();
  const save = page.getByRole("button", { name: "Сохранить" });
  await save.click();
  await expect(save).toBeDisabled();

  await openTab(page, "Разговор");
  await page.getByRole("button", { name: "Начать заново" }).click();
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.firstMessage })).toBeVisible({ timeout: 30_000 });
  const previewInput = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(async () => {
    await previewInput.fill(`Расскажите ${E2E_SCRIPT.knowledgeTrigger}, сколько длится курс`);
    await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await previewInput.press("Enter");
  await expect(preview.getByRole("paragraph").filter({ hasText: `${E2E_SCRIPT.knowledgeReply} ${fact}` })).toBeVisible({ timeout: 30_000 });

  // В базе знаний видно, к какому лидмагниту прикреплён текст
  await page.goto("/knowledge");
  await expect(page.getByRole("row").filter({ hasText: title }).getByRole("link", { name: `Лидмагнит с базой ${tag}` })).toBeVisible();
});

test("PDF в чате конструктора становится базой лидмагнита; в разделе «База» новую базу подключают сразу при загрузке", async ({ page }) => {
  test.setTimeout(180_000);
  const tag = randomUUID().slice(0, 6);
  const leadName = `Лидмагнит с PDF ${tag}`;

  await createLeadMagnet(page, leadName);
  const constructor = page.getByRole("region", { name: "Конструктор", exact: true });
  const constructorInput = constructor.getByRole("textbox");
  const send = constructor.getByRole("button", { name: "Отправить", exact: true });
  await expect(async () => {
    await constructorInput.fill("сделай");
    await expect(send).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await constructorInput.press("Enter");
  await expect(page.getByRole("button", { name: "Начать заново" })).toBeVisible({ timeout: 30_000 });
  await expect(constructorInput).toBeEnabled({ timeout: 30_000 });

  // Файл с текстом — скрепкой в чат конструктора
  const pdf = readFileSync(join(process.cwd(), "tests/fixtures/knowledge/курс.pdf"));
  await constructor.locator('input[type="file"]').setInputFiles({ name: `Программа ${tag}.pdf`, mimeType: "application/pdf", buffer: pdf });
  await expect(async () => {
    await constructorInput.fill("Вот программа курса");
    await expect(send).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await constructorInput.press("Enter");
  await expect(constructorInput).toBeEnabled({ timeout: 30_000 });

  // База уже подключена: галочка в «Настройках», консультант отвечает по тексту PDF
  await openTab(page, "Настройки");
  await expect(page.getByRole("checkbox", { name: new RegExp(`Программа ${tag}`) })).toBeChecked({ timeout: 30_000 });
  await openTab(page, "Разговор");
  await page.getByRole("button", { name: "Начать заново" }).click();
  const preview = page.getByRole("tabpanel", { name: "Разговор" });
  await expect(preview.getByRole("paragraph").filter({ hasText: E2E_SCRIPT.firstMessage })).toBeVisible({ timeout: 30_000 });
  const previewInput = preview.getByRole("textbox", { name: "Сообщение", exact: true });
  await expect(async () => {
    await previewInput.fill(`Расскажите ${E2E_SCRIPT.knowledgeTrigger}, сколько длится курс`);
    await expect(preview.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await previewInput.press("Enter");
  await expect(preview.getByRole("paragraph").filter({ hasText: `${E2E_SCRIPT.knowledgeReply} Курс длится шесть недель.` })).toBeVisible({ timeout: 30_000 });

  // Раздел «База»: новую базу отмечают для лидмагнита прямо в окне загрузки
  await page.goto("/knowledge");
  await expect(page.getByRole("row").filter({ hasText: `Программа ${tag}` }).getByRole("link", { name: leadName })).toBeVisible();
  await page.getByRole("button", { name: "Добавить текст" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Файл базы знаний").setInputFiles({ name: `Отзывы ${tag}.md`, mimeType: "text/markdown", buffer: Buffer.from("Ученики довольны.") });
  await form.getByRole("checkbox", { name: leadName }).check();
  await form.screenshot({ path: test.info().outputPath("knowledge-dialog.png") });
  await form.getByRole("button", { name: "Сохранить" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: `Отзывы ${tag}` }).getByRole("link", { name: leadName })).toBeVisible();
});
