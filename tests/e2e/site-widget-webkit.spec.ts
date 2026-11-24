import { expect, test } from "@playwright/test";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { e2eDatabaseUrl } from "./e2e-env";
import { passagesOf, publishedLeadMagnet, startExpertSite, type ExpertSite } from "./site-widget-kit";

// Где браузеры расходятся: Safari по умолчанию режет сторонние cookie и по-своему наследует стили в теневой корень
let connection: DatabaseConnection;
let site: ExpertSite;

test.beforeAll(async () => {
  connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 2 });
  site = await startExpertSite();
});

test.afterAll(async () => {
  await Promise.all([connection.close(), site.close()]);
});

test("Safari: виджет на чужом сайте узнаёт посетителя без cookie и не берёт стили сайта", async ({ page }) => {
  test.setTimeout(120_000);
  const { db } = connection;
  const lead = await publishedLeadMagnet(db, Date.now().toString(36), "Safari");
  await site.open(page, {
    code: lead.code,
    mode: "inline",
    css: `livem-chat { --livem-color: rgb(10, 120, 60); } body { font-size: 30px; color: rgb(255, 0, 0); } button { background: rgb(255, 0, 0); }`,
  });

  const feed = page.getByRole("log", { name: "Переписка" });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).toBeVisible({ timeout: 30_000 });
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).not.toHaveCSS("color", "rgb(255, 0, 0)");
  await expect(feed.getByText(E2E_SCRIPT.firstMessage)).not.toHaveCSS("font-size", "30px");

  await page.getByRole("textbox", { name: "Сообщение" }).fill("Пишу из Safari");
  const send = page.getByRole("button", { name: "Отправить" });
  await expect(send).toHaveCSS("background-color", "rgb(10, 120, 60)");
  await send.click();
  await expect(feed.getByText(E2E_SCRIPT.consultantReply)).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(feed.getByText("Пишу из Safari")).toBeVisible({ timeout: 30_000 });
  expect(await passagesOf(db, lead.id)).toHaveLength(1);
});
