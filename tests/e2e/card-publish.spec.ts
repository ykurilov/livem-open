import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { attachBot, createLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { bots } from "../../src/modules/channels/schema";
import { connectDatabase } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { eq } from "drizzle-orm";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

test("публикация из карточки: подсказки и «Опубликовано» не переживают свой момент, черновик не «работает»", async ({ page, context }) => {
  test.setTimeout(180_000);
  const connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 1 });
  try {
    const { db } = connection;
    const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_BASE_URL });
    await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);

    await page.goto("/bots");
    await page.getByLabel("Токен бота").fill(`fake-card${tag}`);
    await page.getByRole("button", { name: "Подключить" }).click();
    await expect(page.getByText("Бот подключён")).toBeVisible({ timeout: 60_000 });
    const [bot] = await db.select().from(bots).where(eq(bots.username, `bot_card${tag}`));

    const draftLead = async (name: string) => {
      const lead = await createLeadMagnet(db, { name });
      await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
      return lead;
    };
    const attachedName = `Привязан ${tag}`;
    const attached = await draftLead(attachedName);
    await attachBot(db, { leadMagnetId: attached.id, botId: bot!.id });
    const freshName = `Из карточки ${tag}`;
    await draftLead(freshName);

    await page.goto("/");
    const cardOf = (name: string) => page.getByRole("listitem").filter({ has: page.getByRole("link", { name, exact: true }) });
    // Бот привязан, но лидмагнит не опубликован: ссылки его не запускают
    await expect(cardOf(attachedName).getByText("Черновик", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(cardOf(attachedName).getByRole("button", { name: "Подключить к боту" })).toBeVisible();
    await expect(cardOf(attachedName).getByRole("button", { name: /Работает в/ })).toHaveCount(0);

    await cardOf(freshName).getByRole("button", { name: "Подключить к боту" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Подключить нового бота Telegram" }).click();
    await dialog.getByLabel("Токен бота").fill(`fake-cardnew${tag}`);
    await dialog.getByRole("button", { name: "Подключить", exact: true }).click();
    await expect(dialog.getByText("Бот подключён")).toBeVisible({ timeout: 60_000 });

    // Черновик: ссылки на веб-версию ещё нет
    await expect(dialog.getByTestId("card-web-link").getByText("Ссылка появится после публикации")).toBeVisible();
    await expect(dialog.getByTestId("card-entry-link-web")).toHaveCount(0);

    await dialog.getByRole("button", { name: "Опубликовать", exact: true }).click();
    await expect(dialog.getByText("Опубликовано", { exact: true })).toBeVisible({ timeout: 30_000 });
    // Ссылка появляется без перезагрузки и копируется одной кнопкой
    const webLink = dialog.getByTestId("card-entry-link-web");
    await expect(webLink).toBeVisible({ timeout: 30_000 });
    const webUrl = (await webLink.textContent())!.trim();
    await dialog.getByTestId("card-web-link").getByRole("button", { name: /Копировать/ }).click();
    await expect(dialog.getByTestId("card-web-link").getByText("Скопировано")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(webUrl);
    // На карточке в «Работает в» теперь и веб-версия
    await expect(cardOf(freshName).getByRole("button", { name: /Веб-версия/, includeHidden: true })).toHaveCount(1);
    await expect(dialog.getByText("Бот подключён"), "подсказка «нажмите „Опубликовать“» после публикации не нужна").toBeHidden();

    await dialog.getByRole("button", { name: "Снять с публикации" }).click();
    await expect(dialog.getByText("Снято с публикации", { exact: true }), "итог снятия виден в окне").toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole("button", { name: "Опубликовать", exact: true })).toBeVisible();
    await expect(dialog.getByText("Опубликовано", { exact: true }), "после снятия с публикации").toBeHidden();
    await expect(dialog.getByTestId("card-entry-link-web"), "снятое с публикации не раздаёт ссылку").toHaveCount(0);
  } finally {
    await connection.close();
  }
});
