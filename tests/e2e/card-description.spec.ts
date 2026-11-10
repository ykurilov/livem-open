import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { createLeadMagnet, getLeadMagnet } from "../../src/modules/lead-magnets";
import { connectDatabase } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";
import { openTab } from "./open-tab";

test("описание карточки правится во вкладке «Настройки» редактора и видно на карточке", async ({ page, context }) => {
  const connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 1 });
  try {
    const name = `Карточка ${randomUUID().slice(0, 8)}`;
    const lead = await createLeadMagnet(connection.db, { name, cardDescription: "Старое описание" });
    const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
    await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
    await page.goto("/");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("link", { name, exact: true }) });
    await expect(card.getByText("Старое описание")).toBeVisible();

    await card.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/lead-magnets/${lead.id}$`), { timeout: 60_000 });
    await openTab(page, "Настройки");
    await page.getByLabel("Описание карточки").fill("Три дня до первого приложения");
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect.poll(async () => (await getLeadMagnet(connection.db, lead.id))!.draft.cardDescription).toBe("Три дня до первого приложения");

    await page.goto("/");
    await expect(card.getByText("Три дня до первого приложения")).toBeVisible();
  } finally { await connection.close(); }
});
