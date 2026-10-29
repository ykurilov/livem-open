import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { bots, outboundMessages } from "../../src/modules/channels/schema";
import { inboundMessages, passages } from "../../src/modules/conversations/schema";
import { createLeadMagnet, newProgramSettings, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
import { people } from "../../src/modules/people/schema";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import { connectDatabase, type DatabaseConnection } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { leadMagnetToFlow } from "../../src/modules/flows/settings-to-flow";
import { modelUsage } from "../../src/modules/spending/schema";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl, e2eServerEnv } from "./e2e-env";

// Блок «Программа» в отчёте: засеянные прохождения, цифры на экране и снимки в двух ширинах и двух темах
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

test("отчёт показывает блок «Программа» с засеянными данными", async ({ page }) => {
  test.setTimeout(240_000);
  const { db } = connection;
  const tag = "программа";
  const at = (iso: string) => new Date(iso);
  const token = `fake-prog${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_prog${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  const lead = await createLeadMagnet(db, { name: `Программа ${tag}` });
  const settings = {
    ...lead.draft,
    instruction: "Ты консультант.",
    firstMessage: E2E_SCRIPT.firstMessage,
    program: newProgramSettings(3),
    stages: [
      { id: "intro", name: "Знакомство", instruction: "Знакомься", transitionCondition: "Познакомились", startDay: null, isSale: false },
      { id: "sale", name: "Продажа", instruction: "Предложи", transitionCondition: "Ответил", startDay: 3, isSale: true },
    ],
  };
  // Ноды и «Продажа» отчёт берёт из сценария: он — из этих этапов, как при переводе настроек
  await saveDraft(db, lead.id, { ...settings, flow: leadMagnetToFlow(settings, []) }, "manual");
  const published = await publishWithBots(db, lead.id, { telegram: bot!.id });
  const snapshotId = published.snapshotId;

  const depth = [
    { day: 1, reason: null, answered: false },
    { day: 1, reason: null, answered: false },
    { day: 2, reason: null, answered: true },
    { day: 2, reason: null, answered: true },
    { day: 3, reason: "price" as const, answered: true },
    { day: 3, reason: "doubt" as const, answered: false },
    { day: 3, reason: "time" as const, answered: true },
  ];
  for (const [index, entry] of depth.entries()) {
    const [person] = await db
      .insert(people)
      .values({ channel: "telegram", botId: bot!.id, externalUserId: `prog-${index}`, displayName: `Человек ${index}`, createdAt: at("2026-10-01T09:00:00Z") })
      .returning();
    const [passage] = await db
      .insert(passages)
      .values({
        personId: person!.id,
        leadMagnetId: lead.id,
        snapshotId: snapshotId!,
        chatId: person!.id,
        programStartDate: "2026-10-01",
        furthestDay: entry.day,
        stageHistory: entry.reason ? [{ stageId: "sale", at: "2026-10-03T10:00:00Z", by: "day" }] : [],
        saleAnswer: entry.reason ? { reason: entry.reason, firm: false, softHandled: false, lastOfferDay: 3 } : null,
      })
      .returning();
    if (entry.day > 1) {
      await db.insert(outboundMessages).values({
        botId: bot!.id, personId: person!.id, passageId: passage!.id, kind: "outreach", text: "Как дела?", status: "sent",
        idempotencyKey: `prog-${index}`, createdAt: at("2026-10-02T10:00:00Z"),
      });
      await db.insert(modelUsage).values({ kind: "program_message", passageId: passage!.id, costUsd: "0.012000", createdAt: at("2026-10-02T10:00:00Z") });
    }
    if (entry.answered) {
      await db.insert(inboundMessages).values({
        botId: bot!.id, kind: "message", dedupeKey: `prog-in-${index}`, externalUserId: `prog-${index}`, text: "Я здесь", personId: person!.id,
        passageId: passage!.id, receivedAt: at("2026-10-02T12:00:00Z"),
      });
    }
  }

  const card = page.getByTestId("program-report");
  for (const [width, height] of [[1280, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto(`/lead-magnets/${lead.id}/publish`);
      await expect(card).toBeVisible();
      await expect(card.getByTestId("program-people")).toContainText("7");
      await expect(card.getByTestId("program-sale")).toContainText("3");
      await expect(card.getByTestId("program-returned")).toContainText("4 из 5");
      await expect(card.getByTestId("program-outreach")).toContainText("Бот написал первым 5 раз, ответили на 4");
      await expect(card).toContainText("Дорого");
      await expect(card).toContainText("Сомневаются");
      await page.addStyleTag({ content: "nextjs-portal, .yk-studio__header, [class*=sticky] { visibility: hidden !important; }" });
      // Capture the whole report outside Studio's scroll viewport, including off-screen Stat cards.
      await card.evaluate(element => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          parent.style.overflow = "visible";
          parent.style.height = "auto";
          parent.style.maxHeight = "none";
        }
      });
      await expect(card).toHaveScreenshot(`program-report-${width}-${colorScheme}.png`, { animations: "disabled", caret: "hide" });
    }
  }
});
