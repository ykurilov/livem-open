// Бот ВК и Senler в одном сообществе: пришедший по ссылке — в группу Senler, подписчик Senler без ссылки — без ответа бота
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { KIT_CIPHER, createLiveDialogKit, outboundOf, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { bots } from "../channels/schema";
import { AUTOREPLY_TEXT } from "../conversations/router";
import { inboundMessages, passages } from "../conversations/schema";
import { createLabeledLink } from "../lead-magnets/links";
import { createSenlerApi } from "./api";
import { FakeSenlerApi, senlerError } from "./fake-senler-api";
import { senlerConnections } from "./schema";
import { createSenlerSettings, subscribeToSenler } from "./index";

let database: TestDatabase;
let kit: LiveDialogKit;
let fake: FakeSenlerApi;
let lead: Awaited<ReturnType<LiveDialogKit["publish"]>>;
let userCounter = 100_000;

const KEY = "senler-dialog-key";
const nextUser = () => String(++userCounter);

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function connectSenler(defaultGroupId: string | null = "101") {
  const settings = createSenlerSettings({ db: database.db, cipher: KIT_CIPHER, api: createSenlerApi({ fetch: fake.fetch }) });
  expect(await settings.connect(kit.bot.id, KEY)).toEqual({ ok: true });
  expect(await settings.saveGroups(kit.bot.id, { defaultGroupId, leadMagnetGroups: {} })).toEqual({ ok: true });
  return settings;
}

async function useDefaultLeadMagnet() {
  await kit.db.update(bots).set({ noCodeMode: "default", defaultLeadMagnetId: lead.leadMagnetId }).where(eq(bots.id, kit.bot.id));
}

const lastError = async () => (await database.db.select().from(senlerConnections).where(eq(senlerConnections.botId, kit.bot.id)))[0]?.lastError ?? null;

beforeEach(async () => {
  fake = new FakeSenlerApi();
  kit = await createLiveDialogKit(database, { botChannel: "vk", senler: createSenlerApi({ fetch: fake.fetch, timeoutMs: 200 }) });
  fake.keys.set(KEY, kit.bot.externalId);
  lead = await kit.publish();
});

describe("пришёл по ссылке — в группу Senler", () => {
  it("ссылка с меткой: человек в группе бота, метка — источник", async () => {
    await connectSenler("101");
    const link = await createLabeledLink(kit.db, { leadMagnetId: lead.leadMagnetId, label: "Весенний интенсив" });
    const user = nextUser();
    await kit.send(user, "", { startCode: link.code });
    await kit.drain();

    expect(fake.callsTo("subscribers/add")).toHaveLength(1);
    expect(fake.callsTo("subscribers/add")[0]!.body).toMatchObject({ vk_user_id: Number(user), subscription_id: 101, utm_source: "Весенний интенсив" });
    expect(kit.textsTo(user)[0]).toContain("Привет! Чем вы занимаетесь?");
  });

  it("основная ссылка — без метки; своя группа лидмагнита главнее группы бота", async () => {
    const settings = await connectSenler("101");
    expect(await settings.saveGroups(kit.bot.id, { defaultGroupId: "101", leadMagnetGroups: { [lead.leadMagnetId]: "102" } })).toEqual({ ok: true });
    const user = nextUser();
    await kit.send(user, "", { startCode: lead.code });
    await kit.drain();

    const body = fake.callsTo("subscribers/add")[0]!.body;
    expect(body).toMatchObject({ subscription_id: 102 });
    expect(body).not.toHaveProperty("utm_source");
  });

  it("без Senler, без группы и без ссылки (лидмагнит по умолчанию) — в Senler ничего", async () => {
    await kit.send(nextUser(), "", { startCode: lead.code });
    await kit.drain();

    await connectSenler(null);
    await kit.send(nextUser(), "", { startCode: lead.code });
    await kit.drain();

    await connectSenler("101");
    await kit.db.update(bots).set({ noCodeMode: "default", defaultLeadMagnetId: lead.leadMagnetId }).where(eq(bots.id, kit.bot.id));
    const user = nextUser();
    await kit.send(user, "Здравствуйте");
    await kit.drain();
    expect((await kit.passagesOf(user)).length).toBe(1);

    expect(fake.callsTo("subscribers/add")).toHaveLength(0);
    expect(kit.queue.count("senler-subscribe")).toBe(0);
  });

  it("группа удалена в Senler — ошибка видна у бота, повтора нет, разговор идёт", async () => {
    await connectSenler("101");
    fake.groups = fake.groups.filter((group) => group.id !== 101);
    const user = nextUser();
    await kit.send(user, "", { startCode: lead.code });
    await kit.drain();

    expect(fake.callsTo("subscribers/add")).toHaveLength(1);
    expect(await lastError()).toContain("удалена");
    expect(kit.textsTo(user)).toHaveLength(1);
  });

  it("Senler не отвечает — ошибка записана, задача падает на повтор; успех стирает ошибку", async () => {
    await connectSenler("101");
    const passage = { id: "" };
    fake.replyOnce("subscribers/add", new TypeError("fetch failed"));
    const user = nextUser();
    await kit.send(user, "", { startCode: lead.code });
    await kit.runDue("senler-subscribe");
    passage.id = (await kit.passagesOf(user))[0]!.id;
    const deps = { db: kit.db, cipher: KIT_CIPHER, api: createSenlerApi({ fetch: fake.fetch }) };

    await expect(subscribeToSenler(deps, passage.id)).rejects.toThrow("Senler не отвечает");
    expect(await lastError()).toContain("Senler не отвечает");

    await subscribeToSenler(deps, passage.id);
    expect(await lastError()).toBeNull();
    expect(fake.subscribers.get(user)?.subscriptions.map((entry) => entry.subscription_id)).toEqual([101]);
  });

  it("снова пришёл по ссылке — в ту же группу не добавляем повторно; отписавшегося обратно не подписываем", async () => {
    await connectSenler("101");
    const user = nextUser();
    await kit.send(user, "", { startCode: lead.code });
    await kit.drain();
    await kit.send(user, "готов");
    await kit.drain();
    expect(fake.callsTo("subscribers/add")).toHaveLength(1);
    fake.unsubscribe(user);

    const other = await createLabeledLink(kit.db, { leadMagnetId: lead.leadMagnetId, label: "Эфир" });
    kit.clock.advance(24 * 60 * 60_000);
    await kit.send(user, "", { startCode: other.code });
    await kit.drain();

    expect(await kit.passagesOf(user)).toHaveLength(2);
    expect(fake.callsTo("subscribers/add")).toHaveLength(1);
    expect(await lastError()).toBeNull();
  });

  it("человек запретил сообществу сообщения — не ошибка настройки: без красной плашки и без повторов", async () => {
    await connectSenler("101");
    fake.replyOnce("subscribers/add", senlerError(4, "User not allowed messages"));
    const user = nextUser();
    await kit.send(user, "", { startCode: lead.code });
    await kit.drain();

    expect(fake.callsTo("subscribers/add")).toHaveLength(1);
    expect(await lastError()).toBeNull();
  });

  it("сбой у нас, а не в Senler — эксперт видит понятный текст, а не техническую ошибку; задача повторится", async () => {
    await connectSenler("101");
    const user = nextUser();
    await kit.send(user, "", { startCode: lead.code });
    await kit.runDue("senler-subscribe");
    const [passage] = await kit.passagesOf(user);
    const broken = { ...createSenlerApi({ fetch: fake.fetch }), addSubscriber: () => Promise.reject(new TypeError("Cannot read properties of undefined")) };

    await expect(subscribeToSenler({ db: kit.db, cipher: KIT_CIPHER, api: broken }, passage!.id)).rejects.toThrow("Cannot read");
    expect(await lastError()).toBe("Не удалось добавить человека в Senler, попробуем ещё раз");
  });
});

describe("подписчик Senler пишет без нашей ссылки — бот молчит", () => {
  it("новичок-подписчик: ни лидмагнита по умолчанию, ни меню; сообщение во «Входящих»", async () => {
    await connectSenler();
    await kit.db.update(bots).set({ noCodeMode: "default", defaultLeadMagnetId: lead.leadMagnetId }).where(eq(bots.id, kit.bot.id));
    const user = nextUser();
    fake.subscribe(user, [101]);
    await kit.send(user, "Спасибо за рассылку!");
    await kit.drain();

    expect(await kit.passagesOf(user)).toHaveLength(0);
    expect(kit.textsTo(user)).toEqual([]);
    expect((await kit.inboundOf(user))[0]).toMatchObject({ route: "inbox", autoreply: false });
    expect(fake.callsTo("subscribers/get")[0]!.body).toMatchObject({ vk_user_id: Number(user) });

    await kit.db.update(bots).set({ noCodeMode: "menu", defaultLeadMagnetId: null }).where(eq(bots.id, kit.bot.id));
    await kit.send(user, "А ещё вопрос");
    await kit.drain();
    expect(kit.textsTo(user)).toEqual([]);
  });

  it("новичок не подписчик (или только «без группы») — как без Senler: лидмагнит по умолчанию", async () => {
    await connectSenler();
    await kit.db.update(bots).set({ noCodeMode: "default", defaultLeadMagnetId: lead.leadMagnetId }).where(eq(bots.id, kit.bot.id));
    const user = nextUser();
    fake.subscribe(user, [0]);
    await kit.send(user, "Здравствуйте");
    await kit.drain();

    expect(await kit.passagesOf(user)).toHaveLength(1);
    expect(kit.textsTo(user)[0]).toContain("Привет! Чем вы занимаетесь?");
  });

  it("наш человек (уже проходил лидмагнит) с подпиской Senler — автоответ как раньше, Senler не спрашиваем", async () => {
    await connectSenler();
    const user = nextUser();
    await kit.send(user, "", { startCode: lead.code });
    await kit.drain();
    await kit.send(user, "готов");
    await kit.drain();
    expect((await kit.passagesOf(user))[0]!.status).toBe("completed");
    // Мы же добавили его в группу Senler — он подписчик
    expect(fake.subscribers.has(user)).toBe(true);
    kit.clock.advance(24 * 60 * 60_000);
    const asked = fake.callsTo("subscribers/get").length;

    await kit.send(user, "Есть вопрос");
    await kit.drain();

    expect(kit.textsTo(user).at(-1)).toBe(AUTOREPLY_TEXT);
    expect(fake.callsTo("subscribers/get")).toHaveLength(asked);
  });

  it("брошенный разговор нашего человека с подпиской Senler продолжается консультантом", async () => {
    await connectSenler();
    const user = nextUser();
    await kit.send(user, "", { startCode: lead.code });
    await kit.drain();
    expect(fake.subscribers.has(user)).toBe(true);
    const [started] = await kit.passagesOf(user);
    await kit.db.update(passages).set({ status: "not_completed", endedAt: kit.clock.now() }).where(eq(passages.id, started!.id));
    kit.clock.advance(60 * 60_000);
    const calls = kit.consultantCalls().length;

    await kit.send(user, "Ответ на рассылку");
    await kit.drain();

    expect(kit.consultantCalls().length).toBeGreaterThan(calls);
    expect((await kit.inboundOf(user)).at(-1)!.route).not.toBe("inbox");
    expect(fake.callsTo("subscribers/get")).toHaveLength(0);
  });

  it("незнакомый подписчик Senler, вернувшийся позже, — по-прежнему без автоответа", async () => {
    await connectSenler();
    const user = nextUser();
    fake.subscribe(user, [101]);
    await kit.send(user, "Привет");
    await kit.drain();
    kit.clock.advance(24 * 60 * 60_000);
    await kit.send(user, "Ещё раз привет");
    await kit.drain();

    expect(kit.textsTo(user)).toEqual([]);
    expect(await kit.inboundOf(user)).toEqual([expect.objectContaining({ route: "inbox", autoreply: false }), expect.objectContaining({ route: "inbox", autoreply: false })]);
  });

  it("ключ отозван в Senler — новичок получает ответ, как без Senler; причина видна в карточке", async () => {
    await connectSenler();
    await useDefaultLeadMagnet();
    fake.keys.delete(KEY);
    const user = nextUser();
    fake.subscribe(user, [101]);
    await kit.send(user, "Здравствуйте");
    await kit.drain();

    expect(await kit.passagesOf(user)).toHaveLength(1);
    expect(kit.textsTo(user)[0]).toContain("Привет! Чем вы занимаетесь?");
    expect(await lastError()).toMatch(/ключ.*бот отвечает всем/s);
  });

  it("ответ Senler непонятного вида — не «не подписчик» молча, а как без Senler с ошибкой в карточке", async () => {
    await connectSenler();
    await useDefaultLeadMagnet();
    const user = nextUser();
    fake.replyOnce("subscribers/get", { status: 200, body: { success: true, subscribers: [] } });
    await kit.send(user, "Здравствуйте");
    await kit.drain();

    expect(await kit.passagesOf(user)).toHaveLength(1);
    expect(await lastError()).toContain("непонятного вида");
  });

  it("Senler временно не отвечает — разбор повторяется, а не молчит; ответил — всё по правилам", async () => {
    await connectSenler();
    await useDefaultLeadMagnet();
    const user = nextUser();
    fake.replyOnce("subscribers/get", new TypeError("fetch failed"));
    await kit.send(user, "Здравствуйте");
    await expect(kit.runDue()).rejects.toThrow("Senler не отвечает");
    const [inbound] = await kit.inboundOf(user);
    expect(inbound!.processedAt).toBeNull();

    // Повтор очереди: Senler ответил, человек не подписчик — лидмагнит по умолчанию
    await kit.dialog.routeInbound(inbound!.id);
    await kit.drain();
    expect(await kit.passagesOf(user)).toHaveLength(1);
    expect(kit.textsTo(user)[0]).toContain("Привет! Чем вы занимаетесь?");
  });

  it("Senler не отвечает дольше отведённого — человек получает ответ, как без Senler, ошибка в карточке", async () => {
    await connectSenler();
    await useDefaultLeadMagnet();
    const user = nextUser();
    fake.replyOnce("subscribers/get", new TypeError("fetch failed"));
    fake.replyOnce("subscribers/get", new TypeError("fetch failed"));
    await kit.send(user, "Здравствуйте");
    await expect(kit.runDue()).rejects.toThrow("Senler не отвечает");
    const [inbound] = await kit.inboundOf(user);
    // Повторы шли пять минут
    await kit.db.update(inboundMessages).set({ receivedAt: new Date(kit.clock.now().getTime() - 5 * 60_000) }).where(eq(inboundMessages.id, inbound!.id));

    await kit.dialog.routeInbound(inbound!.id);
    await kit.drain();
    expect(await kit.passagesOf(user)).toHaveLength(1);
    expect(await lastError()).toContain("Senler долго не отвечал");
  });

  it("отписался в Senler (неактивный подписчик) — как без Senler: лидмагнит по умолчанию", async () => {
    await connectSenler();
    await useDefaultLeadMagnet();
    const user = nextUser();
    fake.subscribe(user, [101]);
    fake.unsubscribe(user);
    await kit.send(user, "Здравствуйте");
    await kit.drain();

    expect(fake.callsTo("subscribers/get")[0]!.body).toMatchObject({ lead_status: 1 });
    expect(await kit.passagesOf(user)).toHaveLength(1);
  });

  it("идущий разговор и ссылка — Senler не спрашиваем", async () => {
    await connectSenler();
    const user = nextUser();
    fake.subscribe(user, [101]);
    await kit.send(user, "", { startCode: lead.code });
    await kit.drain();
    await kit.send(user, "Я занимаюсь йогой");
    await kit.drain();

    expect(fake.callsTo("subscribers/get")).toHaveLength(0);
    expect(kit.consultantCalls().length).toBeGreaterThan(0);
  });

  it("бот без Senler — Senler не спрашиваем, всё как раньше", async () => {
    const user = `${randomUUID().slice(0, 4)}`;
    await kit.send(user, "Привет");
    await kit.drain();
    expect(fake.requests).toHaveLength(0);
  });
});
