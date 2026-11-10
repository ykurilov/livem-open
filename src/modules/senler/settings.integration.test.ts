// Настройка Senler у бота ВК: ключ, группа по умолчанию, свои группы лидмагнитов, понятные ошибки
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { bots } from "../channels/schema";
import { createLeadMagnet } from "../lead-magnets";
import { attachBot } from "../lead-magnets/publish";
import { createBotService } from "../channels/bots";
import { FakeChannel } from "../channels/fake";
import { createTokenCipher } from "../platform/crypto";
import { createSenlerApi } from "./api";
import { FAKE_SENLER_KEY, FakeSenlerApi } from "./fake-senler-api";
import { senlerAddedSubscribers, senlerConnections, senlerLeadMagnetGroups } from "./schema";
import { createSenlerSettings, findSenlerAccess, type SenlerSettings } from "./settings";

const cipher = createTokenCipher(Buffer.alloc(32, 4).toString("base64"));

let database: TestDatabase;
let fake: FakeSenlerApi;
let settings: SenlerSettings;
let botId: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function insertBot(channel: "vk" | "telegram") {
  const externalId = String(Math.floor(Math.random() * 1e9));
  const [row] = await database.db
    .insert(bots)
    .values({ channel, title: "Сообщество", externalId, username: `club${externalId}`, tokenEncrypted: cipher.encrypt("t"), webhookSecret: "s" })
    .returning();
  return row!;
}

beforeEach(async () => {
  fake = new FakeSenlerApi();
  settings = createSenlerSettings({ db: database.db, cipher, api: createSenlerApi({ fetch: fake.fetch, timeoutMs: 200 }) });
  const bot = await insertBot("vk");
  botId = bot.id;
  fake.keys.set(FAKE_SENLER_KEY, bot.externalId);
});

describe("ключ Senler", () => {
  it("верный ключ сохраняется зашифрованным; настройка видна без ключа", async () => {
    expect(await settings.load(botId)).toBeNull();
    expect(await settings.connect(botId, `  ${FAKE_SENLER_KEY} `)).toEqual({ ok: true });

    const [row] = await database.db.select().from(senlerConnections).where(eq(senlerConnections.botId, botId));
    expect(row!.apiKeyEncrypted).not.toContain(FAKE_SENLER_KEY);
    expect(cipher.decrypt(row!.apiKeyEncrypted)).toBe(FAKE_SENLER_KEY);
    expect(await settings.load(botId)).toMatchObject({ defaultGroupId: null, leadMagnetGroups: {}, lastError: null });
  });

  it("неверный ключ, ключ от другого сообщества, Senler не отвечает — понятный отказ, ничего не сохранено", async () => {
    const wrong = await settings.connect(botId, "wrong-key");
    expect(wrong).toMatchObject({ ok: false });
    expect(!wrong.ok && wrong.error).toContain("ключ");

    fake.keys.set("other-community-key", "777");
    const other = await settings.connect(botId, "other-community-key");
    expect(!other.ok && other.error).toContain("другого сообщества");

    fake.replyOnce("subscriptions/get", new TypeError("fetch failed"));
    const down = await settings.connect(botId, FAKE_SENLER_KEY);
    expect(!down.ok && down.error).toContain("Senler не отвечает");

    expect(await settings.connect(botId, "  ")).toMatchObject({ ok: false, error: "Вставьте ключ Senler" });
    expect(await settings.load(botId)).toBeNull();
  });

  it("Senler — только для бота ВК", async () => {
    const telegram = await insertBot("telegram");
    const result = await settings.connect(telegram.id, FAKE_SENLER_KEY);
    expect(!result.ok && result.error).toContain("ВКонтакте");
  });

  it("новый ключ заменяет старый, группы остаются; «Отключить» убирает всё", async () => {
    await settings.connect(botId, FAKE_SENLER_KEY);
    await settings.saveGroups(botId, { defaultGroupId: "101", leadMagnetGroups: {} });
    fake.keys.set("second-key", fake.keys.get(FAKE_SENLER_KEY)!);
    expect(await settings.connect(botId, "second-key")).toEqual({ ok: true });
    expect((await settings.load(botId))?.defaultGroupId).toBe("101");

    await settings.disconnect(botId);
    expect(await settings.load(botId)).toBeNull();
  });
});

describe("группы подписчиков", () => {
  beforeEach(async () => {
    await settings.connect(botId, FAKE_SENLER_KEY);
  });

  it("список групп — из Senler", async () => {
    expect(await settings.listGroups(botId)).toEqual({
      ok: true,
      groups: [
        { id: "101", name: "Подписчики марафона" },
        { id: "102", name: "Весенний интенсив" },
      ],
    });
  });

  it("группа бота и своя группа лидмагнита сохраняются; «как у бота» — без записи", async () => {
    const lead = await createLeadMagnet(database.db, { name: `Лидмагнит ${randomUUID().slice(0, 4)}` });
    const plain = await createLeadMagnet(database.db, { name: `Лидмагнит ${randomUUID().slice(0, 4)}` });
    await attachBot(database.db, { leadMagnetId: lead.id, botId });
    await attachBot(database.db, { leadMagnetId: plain.id, botId });

    expect(await settings.saveGroups(botId, { defaultGroupId: "101", leadMagnetGroups: { [lead.id]: "102", [plain.id]: null } })).toEqual({ ok: true });
    expect(await settings.load(botId)).toMatchObject({ defaultGroupId: "101", leadMagnetGroups: { [lead.id]: "102" }, lastError: null });

    expect(await settings.saveGroups(botId, { defaultGroupId: null, leadMagnetGroups: { [lead.id]: null } })).toEqual({ ok: true });
    expect(await settings.load(botId)).toMatchObject({ defaultGroupId: null, leadMagnetGroups: {}, lastError: null });
  });

  it("группы нет в Senler — «группа удалена»; лидмагнит не этого бота — отказ", async () => {
    const missing = await settings.saveGroups(botId, { defaultGroupId: "404", leadMagnetGroups: {} });
    expect(!missing.ok && missing.error).toContain("удалена");

    const stranger = await createLeadMagnet(database.db, { name: "Чужой" });
    const foreign = await settings.saveGroups(botId, { defaultGroupId: "101", leadMagnetGroups: { [stranger.id]: "102" } });
    expect(foreign.ok).toBe(false);
    expect((await settings.load(botId))?.defaultGroupId).toBeNull();
  });

  it("Senler не отвечает — группы не сохраняются, список — с ошибкой", async () => {
    fake.replyOnce("subscriptions/get", new TypeError("fetch failed"));
    const saved = await settings.saveGroups(botId, { defaultGroupId: "101", leadMagnetGroups: {} });
    expect(!saved.ok && saved.error).toContain("Senler не отвечает");

    fake.replyOnce("subscriptions/get", new TypeError("fetch failed"));
    const listed = await settings.listGroups(botId);
    expect(!listed.ok && listed.error).toContain("Senler не отвечает");
  });

  it("ключ отозвали в Senler — список групп говорит, что ключ не принят", async () => {
    fake.keys.delete(FAKE_SENLER_KEY);
    const listed = await settings.listGroups(botId);
    expect(!listed.ok && listed.error).toContain("ключ");
  });

  it("группы сохранены заново — прежняя ошибка («группа удалена») снимается", async () => {
    await database.db.update(senlerConnections).set({ lastError: "Группа подписчиков удалена в Senler: выберите другую", lastErrorAt: new Date() }).where(eq(senlerConnections.botId, botId));
    expect(await settings.saveGroups(botId, { defaultGroupId: "102", leadMagnetGroups: {} })).toEqual({ ok: true });
    expect((await settings.load(botId))?.lastError).toBeNull();
  });

  it("новый ключ — новая версия ключа для формы групп", async () => {
    const before = (await settings.load(botId))!.keyUpdatedAt;
    await settings.saveGroups(botId, { defaultGroupId: "101", leadMagnetGroups: {} });
    expect((await settings.load(botId))!.keyUpdatedAt).toEqual(before);
    await settings.connect(botId, FAKE_SENLER_KEY);
    expect((await settings.load(botId))!.keyUpdatedAt.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("удаление бота", () => {
  it("ключ, группы и отметки Senler удаляются вместе с ботом; удалённый бот в Senler не ходит", async () => {
    await settings.connect(botId, FAKE_SENLER_KEY);
    const lead = await createLeadMagnet(database.db, { name: `Лидмагнит ${randomUUID().slice(0, 4)}` });
    await attachBot(database.db, { leadMagnetId: lead.id, botId });
    await settings.saveGroups(botId, { defaultGroupId: "101", leadMagnetGroups: { [lead.id]: "102" } });
    await database.db.insert(senlerAddedSubscribers).values({ botId, vkUserId: "1", groupId: "101" });
    const service = createBotService({
      db: database.db,
      adapters: { vk: new FakeChannel({ kind: "vk" }) },
      cipher,
      alerts: { resolve: async () => {} },
      queue: { enqueue: async () => {} },
      publicBaseUrl: "https://livem.test",
    });

    expect(await service.deleteBot(botId)).toEqual({ ok: true });
    for (const table of [senlerConnections, senlerLeadMagnetGroups, senlerAddedSubscribers])
      expect(await database.db.select().from(table).where(eq(table.botId, botId))).toEqual([]);
  });

  it("бот помечен удалённым — доступа к Senler нет", async () => {
    await settings.connect(botId, FAKE_SENLER_KEY);
    await database.db.update(bots).set({ deletedAt: new Date() }).where(eq(bots.id, botId));
    expect(await findSenlerAccess(database.db, cipher, botId)).toBeNull();
  });
});
