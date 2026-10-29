import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { createLeadMagnet, getLeadMagnet } from "../../src/modules/lead-magnets";
import { connectDatabase } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

test("описание карточки правится в самой карточке на главной, в «Настройках» его нет", async ({ page, context }) => {
  const connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 1 });
  try {
    const name = `Карточка ${randomUUID().slice(0, 8)}`;
    const lead = await createLeadMagnet(connection.db, { name, cardDescription: "Старое описание" });
    const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
    await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
    await page.goto("/");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("link", { name, exact: true }) });
    await expect(card.getByText("Старое описание")).toBeVisible();
    await card.getByRole("button", { name: `Изменить описание «${name}»` }).click();
    await card.getByRole("textbox", { name: `Описание «${name}»` }).fill("Три дня до первого приложения");
    await card.getByRole("button", { name: "Сохранить" }).click();
    await expect(card.getByText("Три дня до первого приложения")).toBeVisible();
    await expect(page).toHaveURL(`${E2E_BASE_URL}/`);
    await expect.poll(async () => (await getLeadMagnet(connection.db, lead.id))!.draft.cardDescription).toBe("Три дня до первого приложения");

    await card.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/lead-magnets/${lead.id}$`), { timeout: 60_000 });
    await page.getByRole("tab", { name: "Настройки" }).click();
    await expect(page.getByLabel("Чем агент начинает разговор (обязательно)")).toBeVisible();
    await expect(page.getByText("Описание карточки")).toHaveCount(0);
  } finally { await connection.close(); }
});
