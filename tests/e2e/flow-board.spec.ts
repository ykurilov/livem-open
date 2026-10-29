import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { leadMagnetToFlow } from "../../src/modules/flows/settings-to-flow";
import { createLeadMagnet, getLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { createField } from "../../src/modules/people";
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
  const session = {
    user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] },
    accessToken: "e2e",
    refreshToken: "e2e",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
});

const stage = (id: string, name: string) => ({ id, name, instruction: "Веди разговор", transitionCondition: "Готово", startDay: null, isSale: false });

/** Лидмагнит с двумя этапами, переведёнными в сценарий: «Знакомство» и «Предложение» (продажа). */
async function seedLead(tag: string) {
  const { db } = connection;
  // Имя поля в словаре уникально: повтор теста в той же базе (--repeat-each, повтор после сбоя) берёт своё
  const { repeatEachIndex, retry } = test.info();
  const field = await createField(db, { name: `Город ${tag} ${repeatEachIndex}.${retry}`, type: "text", description: "Где живёт человек" });
  const lead = await createLeadMagnet(db, { name: `Доска ${tag}` });
  const settings = {
    ...lead.draft,
    instruction: "Ты консультант.",
    firstMessage: "Здравствуйте!",
    fieldIds: [field.id],
    stages: [stage("s-meet", "Знакомство"), { ...stage("s-offer", "Предложение"), isSale: true }],
  };
  await saveDraft(db, lead.id, { ...settings, flow: leadMagnetToFlow(settings, [field]) }, "manual");
  return lead.id;
}

async function openBoard(page: Page, id: string) {
  await page.goto(`/lead-magnets/${id}`);
  // Клик до того, как страница ожила, пропадает: повторяем, пока вкладка не откроется
  const tab = page.getByRole("tab", { name: "Сценарий" });
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  // Доска только для просмотра, пока страница выясняет, правит ли черновик конструктор
  const board = page.getByRole("tabpanel", { name: "Сценарий" });
  await expect(board.getByRole("application")).toBeVisible({ timeout: 60_000 });
  await expect(board.getByText("Только просмотр")).toBeHidden({ timeout: 60_000 });
  return board;
}

/**
 * Нажимает «Сохранить» и ждёт ответа сервера на сохранение. Под общей нагрузкой прогона ответ бывает дольше 5 секунд,
 * а кнопка всё это время выключена и пишет «Сохранить»; итог («Сохранено» или отказ) доска показывает сразу после ответа.
 */
async function saveBoard(page: Page, board: Locator) {
  // Ответ именно на сохранение: серверное действие, которому ушёл сценарий целиком
  const isSave = (request: Request) => request.method() === "POST" && request.headers()["next-action"] !== undefined && (request.postData() ?? "").includes('"states"');
  const answered = page.waitForResponse((response) => isSave(response.request()), { timeout: 60_000 });
  const startedAt = Date.now();
  await board.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect((await answered).ok()).toBe(true);
  test.info().annotations.push({ type: "board-save-ms", description: String(Date.now() - startedAt) });
}

// Панель «Сценарий» свёрнута, пока ничего не выбрано (`inspector="collapsible"`): выбор ноды на графе её раскрывает
async function openState(board: ReturnType<Page["getByRole"]>, name: string) {
  await board.getByRole("application").getByRole("button", { name, exact: true }).click();
  await expect(board.getByRole("complementary")).toBeVisible();
}

test("эксперт переименовывает ноду на доске — сценарий сохраняется и переживает перезагрузку", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await seedLead("e2e-нода");
  const board = await openBoard(page, id);

  await openState(board, "Знакомство");
  await board.getByRole("textbox", { name: "Название", exact: true }).fill("Знакомство с человеком");
  await saveBoard(page, board);
  await expect(board.getByRole("button", { name: "Сохранено" })).toBeVisible();

  const { flow } = (await getLeadMagnet(connection.db, id))!.draft;
  expect(flow.states.map((state) => state.title)).toContain("Знакомство с человеком");

  const reopened = await openBoard(page, id);
  await expect(reopened.getByRole("application").getByRole("button", { name: "Знакомство с человеком", exact: true })).toBeVisible();
});

test("«две Продажи»: ошибка видна на доске, сервер такой сценарий не принимает", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await seedLead("e2e-продажи");
  const board = await openBoard(page, id);

  await openState(board, "Знакомство");
  await board.getByText("Дополнительно", { exact: true }).click();
  await board.getByRole("button", { name: "Записать отказ от продукта" }).click();
  await board.getByRole("textbox", { name: "Метки" }).fill("продажа");
  await board.getByRole("textbox", { name: "Метки" }).press("Enter");

  await board.getByRole("button", { name: "Проверить граф" }).click();
  await expect(board.getByText("«Продажа» — только в одной ноде")).toBeVisible();

  // Отказ сервера показывает сама доска: «Не сохранено» в шапке, замечание — у ноды и в «Проверить граф»
  await saveBoard(page, board);
  await expect(board.getByText("Не сохранено")).toBeVisible();
  await expect(board.getByText("Сценарий не сохранён")).toHaveCount(0);

  // В базе осталась одна «Продажа»
  const { flow } = (await getLeadMagnet(connection.db, id))!.draft;
  expect(flow.states.filter((state) => state.tags.includes("продажа"))).toHaveLength(1);
});

test("панель этапа: вид условия «Словами → Данные → Словами» хранит текст, «Узнать о человеке» свёрнуто, инструменты по-русски", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await seedLead("e2e-панель");
  const board = await openBoard(page, id);
  await openState(board, "Знакомство");
  const panel = board.getByRole("complementary");

  // Список полей свёрнут в одну строку со счётчиком
  await expect(panel.getByText(/^Узнать о человеке: \d+ из \d+$/)).toBeVisible();
  await expect(panel.locator("details[data-flow-learn]")).not.toHaveAttribute("open", "");

  // Переход «Словами»: текст условия переживает переключение на «Данные» и обратно
  const kinds = panel.getByRole("radiogroup", { name: "Когда" }).first();
  await expect(kinds.getByRole("radio", { name: "Словами" })).toHaveAttribute("aria-checked", "true");
  const card = kinds.locator("xpath=../..");
  const condition = card.locator("textarea").first();
  await condition.fill("Человек назвал свой город");
  await kinds.getByRole("radio", { name: "Данные" }).click();
  await expect(kinds.getByRole("radio", { name: "Данные" })).toHaveAttribute("aria-checked", "true");
  await kinds.getByRole("radio", { name: "Словами" }).click();
  await expect(card.locator("textarea").first()).toHaveValue("Человек назвал свой город");
  await page.screenshot({ path: test.info().outputPath("panel-condition.png") });

  // Инструменты — русскими названиями, служебные имена в сценарии прежние
  await panel.getByText("Дополнительно", { exact: true }).click();
  for (const title of ["Завершить разговор", "Записать отказ от продукта", "Открыть ссылку человека"])
    await expect(panel.getByRole("button", { name: title })).toBeVisible();
  await expect(panel.getByRole("button", { name: "sale_answer" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Завершить разговор" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("panel-tools.png") });

  // Подпись перехода по инструменту на самой доске — тоже по-русски
  const graph = board.getByRole("application");
  await expect(graph.getByRole("listitem").filter({ hasText: "Вызван инструмент «Завершить разговор»" })).toBeVisible();
  await expect(graph.getByText(/finish_dialog/)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("board-tool-edge.png") });
});

/** Граф сам подбирает масштаб и сдвиг под окно; снимок — когда они и размер доски перестали меняться на 400 мс. */
async function waitForGraphToSettle(board: Locator) {
  const viewport = board.locator(".react-flow__viewport");
  let last = "";
  let stableSince = Date.now();
  await expect
    .poll(async () => {
      const now = await viewport.evaluate(element => JSON.stringify({
        transform: getComputedStyle(element).transform,
        bounds: element.getBoundingClientRect().toJSON(),
        board: element.closest(".react-flow")?.getBoundingClientRect().toJSON(),
      }));
      if (now !== last) {
        last = now;
        stableSince = Date.now();
      }
      return last !== "" && Date.now() - stableSince >= 400;
    }, { intervals: [100], timeout: 15_000 })
    .toBe(true);
}

test("снимки доски в светлой и тёмной теме: 1280 и 390 пикселей", async ({ page }) => {
  test.setTimeout(240_000);
  // Логотип рисуется через requestAnimationFrame, поэтому animations: "disabled" его не останавливает.
  // Системный reduced motion оставляет настоящий статичный кадр без маскирования интерфейса.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const id = await seedLead("e2e-снимки");
  for (const [width, height] of [[1280, 800], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const board = await openBoard(page, id);
      await expect(board.getByRole("application")).toBeVisible();
      await waitForGraphToSettle(board);
      // Граф подгоняется под окно один раз, при появлении доски. Шапка редактора и поля кабинета в этот момент ещё
      // перестраиваются, и доска потом вырастает: граф остаётся там, где его поставили под старый размер, и место
      // зависит от скорости загрузки. «Весь граф» подгоняет его заново под окончательный размер доски. Нажатие без
      // прокрутки к кнопке: на телефоне доска выше окна, и снимок ушёл бы вниз страницы.
      await board.getByRole("button", { name: "Весь граф", exact: true }).dispatchEvent("click");
      await waitForGraphToSettle(board);
      // Счётчик «Входящих» в меню растёт от переписок параллельных тестов
      await page.addStyleTag({ content: "nextjs-portal, .app-navigation-count { display: none !important; }" });
      await expect(page).toHaveScreenshot(`flow-board-${width}-${colorScheme}.png`, { animations: "disabled", caret: "hide" });
    }
  }
});


test("эксперт переставил карточку на доске — конструктор не закрыт (Дмитрий 15.10)", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await seedLead("e2e-перестановка");
  const board = await openBoard(page, id);

  const card = board.getByRole("application").getByRole("button", { name: "Знакомство", exact: true });
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + 90, { steps: 8 });
  await page.mouse.up();

  await page.getByRole("tab", { name: "Разговор" }).click();
  await expect(page.getByText("Сначала сохраните правку на вкладке «Сценарий»")).toBeHidden();
  await expect(page.getByPlaceholder("Опишите, что поменять…")).toBeEnabled();
});

test("правка на доске, ушёл на «Разговор» и вернулся — доска пишет «Не сохранено», сохранить можно (Дмитрий 15.10)", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await seedLead("e2e-возврат");
  const board = await openBoard(page, id);

  await openState(board, "Знакомство");
  await board.getByRole("textbox", { name: "Название", exact: true }).fill("Знакомство поближе");
  await page.getByRole("tab", { name: "Разговор" }).click();
  await expect(page.getByText("Сначала сохраните правку на вкладке «Сценарий»")).toBeVisible();

  await page.getByRole("tab", { name: "Сценарий" }).click();
  await expect(board.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
  await saveBoard(page, board);
  await expect(board.getByRole("button", { name: "Сохранено" })).toBeVisible();
  await page.getByRole("tab", { name: "Разговор" }).click();
  await expect(page.getByText("Сначала сохраните правку на вкладке «Сценарий»")).toBeHidden();
});
