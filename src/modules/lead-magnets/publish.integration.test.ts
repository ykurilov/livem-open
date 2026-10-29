import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { KIT_CIPHER, createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { bots } from "../channels/schema";
import { createLeadMagnet, getLeadMagnet, getVersion, LeadMagnetNotFoundError, saveDraft } from "./lead-magnets";
import { generateEntryCode } from "./links";
import { attachBot, describePublication, listAttachedBots, publishLeadMagnet, PublishError, publishWithBots } from "./publish";
import { entryLinks } from "./schema";

let database: TestDatabase;
let kit: LiveDialogKit;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
});

async function anotherTelegramBot() {
  const [row] = await database.db
    .insert(bots)
    .values({
      channel: "telegram",
      title: "Второй бот",
      externalId: randomUUID(),
      username: "second_bot",
      tokenEncrypted: KIT_CIPHER.encrypt("fake-second"),
      webhookSecret: "s",
    })
    .returning();
  return row!;
}

describe("код ссылки", () => {
  it("8 знаков из латиницы и цифр, каждый раз новый", () => {
    const codes = new Set(Array.from({ length: 200 }, generateEntryCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9]{8}$/);
  });
});

describe("публикация", () => {
  it("без бота не публикуется", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Без бота" });
    await expect(publishLeadMagnet(database.db, lead.id)).rejects.toThrow(/Привяжите хотя бы одного бота/);
    expect((await getLeadMagnet(database.db, lead.id))?.publishedSnapshotId).toBeNull();
  });

  it("на мессенджер — один бот: новый заменяет прежнего", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Боты" });
    const second = await anotherTelegramBot();
    await attachBot(database.db, { leadMagnetId: lead.id, botId: kit.bot.id });
    await attachBot(database.db, { leadMagnetId: lead.id, botId: second.id });
    expect((await listAttachedBots(database.db, lead.id)).map((bot) => bot.botId)).toEqual([second.id]);
  });

  it("снимок — версия черновика; основная ссылка ведёт в бота; правка черновика снимок не меняет", async () => {
    const lead = await kit.publish({ instruction: "Версия 1" });
    const row = await getLeadMagnet(database.db, lead.leadMagnetId);
    expect(row?.publishedSnapshotId).toBe(lead.snapshotId);
    expect(lead.snapshotId).toBe(row?.draftVersionId);
    expect(lead.code).toMatch(/^[A-Za-z0-9]{8}$/);

    const publication = await describePublication(database.db, { telegram: kit.channel }, lead.leadMagnetId);
    expect(publication.bots).toEqual([
      expect.objectContaining({ botId: kit.bot.id, link: kit.channel.entryLink(kit.bot, lead.code) }),
    ]);

    await saveDraft(database.db, lead.leadMagnetId, { ...row!.draft, instruction: "Версия 2" }, "manual");
    const snapshot = await getVersion(database.db, lead.snapshotId);
    expect(snapshot?.settings.instruction).toBe("Версия 1");
    expect(snapshot?.isSnapshot).toBe(true);
    expect((await getLeadMagnet(database.db, lead.leadMagnetId))?.publishedSnapshotId).toBe(lead.snapshotId);
  });

  it("повторная публикация — новый снимок, ссылка та же; начатое прохождение остаётся на своём снимке", async () => {
    const lead = await kit.publish({ instruction: "Инструкция версии 1" });
    const early = `early-${randomUUID().slice(0, 6)}`;
    await kit.send(early, `/start ${lead.code}`, { startCode: lead.code });
    await kit.drain();

    const row = await getLeadMagnet(database.db, lead.leadMagnetId);
    // Основная инструкция — общая часть сценария
    const draft = row!.draft;
    await saveDraft(database.db, lead.leadMagnetId, { ...draft, instruction: "Инструкция версии 2", flow: { ...draft.flow, common: "Инструкция версии 2" } }, "manual");
    const republished = await publishLeadMagnet(database.db, lead.leadMagnetId);
    expect(republished.snapshotId).not.toBe(lead.snapshotId);
    expect(republished.code).toBe(lead.code);
    const links = await database.db.select().from(entryLinks).where(eq(entryLinks.leadMagnetId, lead.leadMagnetId));
    expect(links).toHaveLength(1);

    const late = `late-${randomUUID().slice(0, 6)}`;
    await kit.send(late, `/start ${lead.code}`, { startCode: lead.code });
    await kit.drain();

    await kit.send(early, "Привет от раннего");
    await kit.drain();
    await kit.send(late, "Привет от позднего");
    await kit.drain();

    expect((await kit.passagesOf(early))[0]!.snapshotId).toBe(lead.snapshotId);
    expect((await kit.passagesOf(late))[0]!.snapshotId).toBe(republished.snapshotId);
    const earlyCall = kit.calls.find((call) => call.lastUserText.includes("Привет от раннего"))!;
    const lateCall = kit.calls.find((call) => call.lastUserText.includes("Привет от позднего"))!;
    expect(earlyCall.system).toContain("Инструкция версии 1");
    expect(earlyCall.system).not.toContain("Инструкция версии 2");
    expect(lateCall.system).toContain("Инструкция версии 2");
  });

  it("выбор ботов и публикация — одно целое: публикация не прошла — привязки прежние", async () => {
    const lead = await kit.publish();
    const before = await getLeadMagnet(database.db, lead.leadMagnetId);

    await expect(publishWithBots(database.db, lead.leadMagnetId, { telegram: null })).rejects.toThrow(PublishError);
    expect((await listAttachedBots(database.db, lead.leadMagnetId)).map((bot) => bot.botId)).toEqual([kit.bot.id]);
    expect((await getLeadMagnet(database.db, lead.leadMagnetId))?.publishedSnapshotId).toBe(before?.publishedSnapshotId);

    const second = await anotherTelegramBot();
    const republished = await publishWithBots(database.db, lead.leadMagnetId, { telegram: second.id });
    expect((await listAttachedBots(database.db, lead.leadMagnetId)).map((bot) => bot.botId)).toEqual([second.id]);
    expect(republished.code).toBe(lead.code);
  });

  it("страница публикации устарела: черновик успел измениться — ничего не публикуется и привязки прежние", async () => {
    const lead = await kit.publish({ instruction: "Версия 1" });
    const seen = (await getLeadMagnet(database.db, lead.leadMagnetId))!;
    // В другой вкладке сохранён новый черновик
    const newer = await saveDraft(database.db, lead.leadMagnetId, { ...seen.draft, cardDescription: "Не просмотрено" }, "manual");
    const second = await anotherTelegramBot();

    await expect(
      publishWithBots(database.db, lead.leadMagnetId, { telegram: second.id }, { expectedDraftVersionId: seen.draftVersionId }),
    ).rejects.toThrow(PublishError);
    const after = (await getLeadMagnet(database.db, lead.leadMagnetId))!;
    expect(after.publishedSnapshotId).toBe(lead.snapshotId);
    expect((await getVersion(database.db, newer.id))?.isSnapshot).toBe(false);
    expect((await listAttachedBots(database.db, lead.leadMagnetId)).map((bot) => bot.botId)).toEqual([kit.bot.id]);

    // Обновил страницу — видит новый черновик и публикует его
    const published = await publishWithBots(database.db, lead.leadMagnetId, { telegram: second.id }, { expectedDraftVersionId: newer.id });
    expect(published.snapshotId).toBe(newer.id);
    expect((await listAttachedBots(database.db, lead.leadMagnetId)).map((bot) => bot.botId)).toEqual([second.id]);
  });

  it("чужой id лидмагнита или бота — понятная ошибка, а не сбой базы", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Проверка id" });
    await expect(publishWithBots(database.db, "not-a-uuid", { telegram: kit.bot.id })).rejects.toThrow(LeadMagnetNotFoundError);
    await expect(publishWithBots(database.db, randomUUID(), { telegram: kit.bot.id })).rejects.toThrow(LeadMagnetNotFoundError);
    await expect(publishWithBots(database.db, lead.id, { telegram: "not-a-uuid" })).rejects.toThrow(PublishError);
    await expect(publishWithBots(database.db, lead.id, { telegram: randomUUID() })).rejects.toThrow(PublishError);
    expect(await listAttachedBots(database.db, lead.id)).toEqual([]);
  });
});
