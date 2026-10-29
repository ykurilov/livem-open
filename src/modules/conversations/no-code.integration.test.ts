// Бот без кода и снятие с публикации (US9)
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import {
  DEFAULT_CONSULTANT_REPLY,
  KIT_CIPHER,
  createLiveDialogKit,
  outboundOf,
  type LiveDialogKit,
} from "../../../tests/integration/live-dialog-kit";
import { createBotService, type BotService } from "../channels/bots";
import { bots, outboundMessages, type NoCodeMode } from "../channels/schema";
import { findEntryLinkByCode, publishLeadMagnet, PublishError, unpublishLeadMagnet } from "../lead-magnets";
import { countUnansweredThreads, listUnansweredThreads } from "../inbox";
import { MENU_BUTTON_LABEL_LIMIT, MENU_TEXT, menuButtonPayload } from "./no-code";
import { AUTOREPLY_TEXT } from "./router";
import { passages } from "./schema";

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;
let botService: BotService;
let alertsResolve: ReturnType<typeof vi.fn<(kind: string, period?: string) => Promise<void>>>;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  person = `user-${randomUUID().slice(0, 8)}`;
  botService = createBotService({
    db: database.db,
    adapters: { telegram: kit.channel },
    cipher: KIT_CIPHER,
    alerts: { resolve: (alertsResolve = vi.fn(async () => {})) },
    queue: kit.queue,
    publicBaseUrl: "https://livem.test",
  });
});

async function setMode(mode: NoCodeMode, defaultLeadMagnetId: string | null = null) {
  await database.db.update(bots).set({ noCodeMode: mode, defaultLeadMagnetId }).where(eq(bots.id, kit.bot.id));
}

async function say(text: string, startCode?: string) {
  await kit.send(person, text, startCode ? { startCode } : {});
  await kit.drain();
}

let pressCounter = 0;
async function press(payload: string) {
  const callbackId = `cb-${++pressCounter}`;
  await kit.webhook([{ type: "button", dedupeKey: `${person}-press-${pressCounter}`, userId: person, callbackId, payload }]);
  await kit.drain();
  return callbackId;
}

const lastMessage = () => kit.channel.messagesTo(person).at(-1)?.message;

describe("режим «ничего»", () => {
  it("сообщение без кода ложится во «Входящие», бот молчит", async () => {
    await kit.publish();
    await setMode("nothing");

    await say("Здравствуйте, сколько стоит курс?");

    expect(kit.textsTo(person)).toEqual([]);
    expect(await kit.passagesOf(person)).toEqual([]);
    expect((await kit.inboundOf(person)).map((row) => row.route)).toEqual(["inbox"]);
  });

  it("сообщение попадает в ленту «Входящих» этапа 7 со счётчиком", async () => {
    await kit.publish();
    await setMode("nothing");
    const before = await countUnansweredThreads(database.db);

    await say("Первый вопрос");
    await say("Второй вопрос");

    expect(await countUnansweredThreads(database.db)).toBe(before + 1);
    const [person_] = await kit.inboundOf(person);
    const thread = (await listUnansweredThreads(database.db)).find((entry) => entry.personId === person_!.personId);
    expect(thread).toMatchObject({ unansweredCount: 2 });
  });
});

/** Прошлое прохождение человека завершено — он «вернувшийся». */
const DAY = 24 * 60 * 60_000;

/** Рассылка человеку: строка исходящих, как её пишет отправка рассылок. */
async function sentMailing(userId: string, status: "sent" | "queued" = "sent") {
  const found = await kit.personOf(userId);
  await database.db.insert(outboundMessages).values({
    botId: kit.bot.id,
    personId: found!.id,
    kind: "mailing",
    mailingId: randomUUID(),
    text: "Новости",
    status,
    idempotencyKey: `mailing-${randomUUID()}`,
    ...(status === "sent" && { sentAt: kit.clock.now() }),
  });
}

async function finishPassages() {
  await finishPassagesOf(person);
}

async function finishPassagesOf(userId: string, status: "completed" | "not_completed" | "blocked" | "term_ended" = "completed") {
  for (const passage of await kit.passagesOf(userId))
    await database.db.update(passages).set({ status, endedAt: new Date() }).where(eq(passages.id, passage.id));
}

describe("режим «лидмагнит по умолчанию»", () => {
  it("сообщение без кода начинает лидмагнит по умолчанию", async () => {
    const lead = await kit.publish({ firstMessage: "Лидмагнит по умолчанию" });
    await setMode("default", lead.leadMagnetId);

    await say("Привет");

    expect((await kit.passagesOf(person))[0]).toMatchObject({ leadMagnetId: lead.leadMagnetId, status: "active" });
    expect(kit.textsTo(person)[0]).toContain("Лидмагнит по умолчанию");
  });

  it("лидмагнит по умолчанию снят с публикации — как «ничего»", async () => {
    const lead = await kit.publish();
    await setMode("default", lead.leadMagnetId);
    await unpublishLeadMagnet(database.db, lead.leadMagnetId);

    await say("Привет");

    expect(kit.textsTo(person)).toEqual([]);
    expect((await kit.inboundOf(person)).map((row) => row.route)).toEqual(["inbox"]);
  });
});

describe("режим «меню»", () => {
  it("без кода — кнопки опубликованных лидмагнитов этого бота; вопрос человека остаётся во «Входящих»", async () => {
    const first = await kit.publish({ name: "Разбор воронки" });
    const second = await kit.publish({ name: "Аудит рекламы" });
    const hidden = await kit.publish({ name: "Снятый" });
    await unpublishLeadMagnet(database.db, hidden.leadMagnetId);
    const otherKit = await createLiveDialogKit(database);
    await otherKit.publish({ name: "Чужой бот" });
    await setMode("menu");

    await say("Здравствуйте");

    const menu = lastMessage()!;
    expect(menu.text).toBe(MENU_TEXT);
    expect(menu.buttons).toEqual(
      expect.arrayContaining([
        { label: "Разбор воронки", payload: menuButtonPayload(first.code) },
        { label: "Аудит рекламы", payload: menuButtonPayload(second.code) },
      ]),
    );
    expect(menu.buttons).toHaveLength(2);
    expect((await outboundOf(kit)).find((row) => row.kind === "menu")).toBeDefined();
    expect((await kit.inboundOf(person)).map((row) => row.route)).toEqual(["inbox"]);
  });

  it("голая команда /start — меню, но во «Входящие» не попадает", async () => {
    await kit.publish({ name: "Разбор воронки" });
    await setMode("menu");

    await say("/start");

    expect(lastMessage()?.buttons).toHaveLength(1);
    expect((await kit.inboundOf(person)).map((row) => row.route)).toEqual(["ignored"]);
  });

  it("повтор вебхука не шлёт меню второй раз", async () => {
    await kit.publish({ name: "Разбор воронки" });
    await setMode("menu");

    await kit.send(person, "Привет", { dedupeKey: `${person}-same` });
    await kit.send(person, "Привет", { dedupeKey: `${person}-same` });
    await kit.drain();

    expect(kit.channel.messagesTo(person)).toHaveLength(1);
  });

  it("длинное название на кнопке укорачивается до предела мессенджеров", async () => {
    await kit.publish({ name: "Очень длинное название лидмагнита, которое не влезет на кнопку" });
    await setMode("menu");

    await say("Привет");

    const label = lastMessage()!.buttons![0]!.label;
    expect(label.length).toBeLessThanOrEqual(MENU_BUTTON_LABEL_LIMIT);
    expect(label.endsWith("…")).toBe(true);
  });

  it("нажатие кнопки запускает выбранный лидмагнит по его основной ссылке и подтверждает нажатие", async () => {
    await kit.publish({ name: "Разбор воронки" });
    const chosen = await kit.publish({ name: "Аудит рекламы", firstMessage: "Начнём аудит!" });
    await setMode("menu");
    await say("Привет");

    const callbackId = await press(menuButtonPayload(chosen.code));

    const [passage] = await kit.passagesOf(person);
    const mainLink = await findEntryLinkByCode(database.db, chosen.code);
    expect(passage).toMatchObject({ leadMagnetId: chosen.leadMagnetId, entryLinkId: mainLink!.id, status: "active" });
    expect(kit.textsTo(person).at(-1)).toContain("Начнём аудит!");
    expect(kit.channel.answeredButtons).toContain(callbackId);

    // Повторное нажатие той же кнопки посреди разговора — разговор продолжается
    await press(menuButtonPayload(chosen.code));
    expect(await kit.passagesOf(person)).toHaveLength(1);
  });

  it("нажатие кнопки снятого лидмагнита — снова меню, разговор не начинается", async () => {
    const kept = await kit.publish({ name: "Остался" });
    const removed = await kit.publish({ name: "Снят" });
    await setMode("menu");
    await say("Привет");
    await unpublishLeadMagnet(database.db, removed.leadMagnetId);

    await press(menuButtonPayload(removed.code));

    expect(await kit.passagesOf(person)).toEqual([]);
    expect(lastMessage()!.buttons).toEqual([{ label: "Остался", payload: menuButtonPayload(kept.code) }]);
  });

  it("опубликованных лидмагнитов нет — как «ничего»", async () => {
    await setMode("menu");

    await say("Привет");

    expect(kit.textsTo(person)).toEqual([]);
    expect((await kit.inboundOf(person)).map((row) => row.route)).toEqual(["inbox"]);
  });

  it("чужая кнопка (не из меню) — ничего не делает, но нажатие подтверждается", async () => {
    await kit.publish();
    await setMode("menu");

    const callbackId = await press("something-else");

    expect(await kit.passagesOf(person)).toEqual([]);
    expect(kit.textsTo(person)).toEqual([]);
    expect(kit.channel.answeredButtons).toContain(callbackId);
  });
});

describe("вернувшийся человек", () => {
  it("было прохождение, голый /start, режим «меню» — кнопки, а не автоответ", async () => {
    const lead = await kit.publish({ name: "Разбор" });
    await say(`/start ${lead.code}`, lead.code);
    await finishPassages();
    await setMode("menu");

    await say("/start");

    expect(lastMessage()).toMatchObject({ text: MENU_TEXT, buttons: [{ label: "Разбор", payload: menuButtonPayload(lead.code) }] });
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "ignored", autoreply: false });
  });

  it("было прохождение, голый /start, режим «по умолчанию» — лидмагнит по умолчанию не начинается, во «Входящие» с автоответом", async () => {
    const lead = await kit.publish({ firstMessage: "Снова здравствуйте" });
    await say(`/start ${lead.code}`, lead.code);
    await finishPassages();
    await setMode("default", lead.leadMagnetId);

    await say("/start");

    expect(await kit.passagesOf(person)).toHaveLength(1);
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox", autoreply: true });
  });

  it("было прохождение, обычное сообщение — во «Входящие» с автоответом, как раньше", async () => {
    const lead = await kit.publish();
    await say(`/start ${lead.code}`, lead.code);
    await finishPassages();
    await setMode("menu");

    await say("У меня вопрос");

    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox", autoreply: true });
  });

  // Режим «без кода» — только для новичка. Остальные без разговора — во «Входящие» с автоответом раз в день, без меню.
  // Брошенный («не завершил») меньше недели назад продолжается (reopen.integration.test.ts), здесь — давно брошенный
  for (const status of ["not_completed", "blocked", "term_ended"] as const) {
    it(`прохождение «${status}», обычное сообщение, режим «меню» — автоответ, а не кнопки`, async () => {
      const lead = await kit.publish({ name: "Разбор" });
      await say(`/start ${lead.code}`, lead.code);
      await finishPassagesOf(person, status);
      kit.clock.advance(8 * DAY);
      await setMode("menu");
      const sent = kit.channel.messagesTo(person).length;

      await say("Я вернулся");

      expect(kit.channel.messagesTo(person).slice(sent).map((sentMessage) => sentMessage.message.text)).toEqual([AUTOREPLY_TEXT]);
      expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox", autoreply: true });
    });

    it(`прохождение «${status}», обычное сообщение, режим «по умолчанию» — лидмагнит не начинается заново`, async () => {
      const lead = await kit.publish({ firstMessage: "Снова здравствуйте" });
      await say(`/start ${lead.code}`, lead.code);
      await finishPassagesOf(person, status);
      kit.clock.advance(8 * DAY);
      await setMode("default", lead.leadMagnetId);

      await say("Я вернулся");

      expect(await kit.passagesOf(person)).toHaveLength(1);
      expect(kit.textsTo(person).filter((text) => text.includes("Снова здравствуйте"))).toHaveLength(1);
      expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox", autoreply: true });
    });
  }

  it("вернувшийся нажал кнопку снятого лидмагнита: лидмагнит по умолчанию не начинается — «Входящие» с автоответом", async () => {
    const fallback = await kit.publish({ firstMessage: "Снова здравствуйте" });
    const removed = await kit.publish({ name: "Снят" });
    await say(`/start ${fallback.code}`, fallback.code);
    await finishPassages();
    await unpublishLeadMagnet(database.db, removed.leadMagnetId);
    await setMode("default", fallback.leadMagnetId);

    const callbackId = await press(menuButtonPayload(removed.code));

    expect(await kit.passagesOf(person)).toHaveLength(1);
    expect(kit.channel.answeredButtons).toContain(callbackId);
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox", autoreply: true });
    expect(kit.textsTo(person).at(-1)).toBe(AUTOREPLY_TEXT);
  });

  it("вернувшийся нажал кнопку снятого лидмагнита, режим «ничего» — не пропадает: «Входящие» с автоответом", async () => {
    const lead = await kit.publish();
    const removed = await kit.publish({ name: "Снят" });
    await say(`/start ${lead.code}`, lead.code);
    await finishPassages();
    await unpublishLeadMagnet(database.db, removed.leadMagnetId);

    await press(menuButtonPayload(removed.code));

    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox", autoreply: true });
  });

  it("прохождений и рассылок не было, но эксперт отвечал из «Входящих» — не новичок: без вступления лидмагнита", async () => {
    const lead = await kit.publish({ firstMessage: "Снова здравствуйте" });
    await say("Здравствуйте, вопрос по оплате");
    const found = await kit.personOf(person);
    await database.db.insert(outboundMessages).values({
      botId: kit.bot.id,
      personId: found!.id,
      kind: "manual_reply",
      text: "Добрый день! Сейчас проверю",
      status: "sent",
      sentAt: kit.clock.now(),
      idempotencyKey: `manual-${randomUUID()}`,
    });
    kit.clock.advance(2 * DAY);
    await setMode("default", lead.leadMagnetId);

    await say("Спасибо, а ещё вопрос");

    expect(await kit.passagesOf(person)).toEqual([]);
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox", autoreply: true });
  });

  it("код входа у вернувшегося работает как раньше: ссылка начинает лидмагнит", async () => {
    const lead = await kit.publish({ firstMessage: "Снова здравствуйте" });
    await say(`/start ${lead.code}`, lead.code);
    await finishPassagesOf(person, "not_completed");

    await say(`/start ${lead.code}`, lead.code);

    expect(await kit.passagesOf(person)).toHaveLength(2);
    expect(kit.textsTo(person).at(-1)).toContain("Снова здравствуйте");
  });

  it("прохождений не было, но уходила рассылка — не новичок: лидмагнит по умолчанию не начинается, автоответ", async () => {
    const lead = await kit.publish({ firstMessage: "Снова здравствуйте" });
    await setMode("default", lead.leadMagnetId);
    await kit.webhook([{ type: "unblocked", dedupeKey: `${person}-allowed`, userId: person }]);
    await kit.drain();
    await sentMailing(person);

    await say("Отвечаю на рассылку");

    expect(await kit.passagesOf(person)).toEqual([]);
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox", autoreply: true });
  });

  it("рассылка ещё не ушла (в очереди) — человек всё ещё новичок", async () => {
    const lead = await kit.publish({ firstMessage: "Лидмагнит по умолчанию" });
    await setMode("default", lead.leadMagnetId);
    await kit.webhook([{ type: "unblocked", dedupeKey: `${person}-allowed`, userId: person }]);
    await kit.drain();
    await sentMailing(person, "queued");

    await say("Здравствуйте");

    expect((await kit.passagesOf(person))[0]).toMatchObject({ leadMagnetId: lead.leadMagnetId, status: "active" });
  });

  it("последнее прохождение «завершил», а раньше было «не завершил» — автоответ", async () => {
    const first = await kit.publish({ name: "Первый" });
    await say(`/start ${first.code}`, first.code);
    await finishPassagesOf(person, "not_completed");
    const second = await kit.publish({ name: "Второй" });
    await say(`/start ${second.code}`, second.code);
    const [latest] = (await kit.passagesOf(person)).filter((passage) => passage.status === "active");
    await database.db.update(passages).set({ status: "completed", endedAt: new Date() }).where(eq(passages.id, latest!.id));
    await setMode("menu");

    await say("У меня вопрос");

    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox", autoreply: true });
  });
});

describe("кнопка лидмагнита чужого бота", () => {
  it("лидмагнит опубликован на другом боте — не запускается, бот снова показывает своё меню", async () => {
    const own = await kit.publish({ name: "Свой" });
    const foreignKit = await createLiveDialogKit(database);
    const foreign = await foreignKit.publish({ name: "Чужой" });
    await setMode("menu");

    const callbackId = await press(menuButtonPayload(foreign.code));

    expect(await kit.passagesOf(person)).toEqual([]);
    expect(kit.channel.answeredButtons).toContain(callbackId);
    expect(lastMessage()!.buttons).toEqual([{ label: "Свой", payload: menuButtonPayload(own.code) }]);
  });
});

describe("снятие с публикации", () => {
  it("ссылка снятого лидмагнита ведёт в режим без кода, начатый разговор продолжается", async () => {
    const other = await kit.publish({ name: "Другой" });
    const lead = await kit.publish({ name: "Снимаемый" });
    await say(`/start ${lead.code}`, lead.code);
    await say("Я дизайнер");
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);

    await unpublishLeadMagnet(database.db, lead.leadMagnetId);

    // Начатый разговор идёт дальше на своём снимке
    await say("Продолжим");
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
    expect((await kit.passagesOf(person))[0]!.status).toBe("active");

    // Новый человек по той же ссылке — поведение без кода (меню без снятого)
    await setMode("menu");
    person = `user-${randomUUID().slice(0, 8)}`;
    await say(`/start ${lead.code}`, lead.code);
    expect(await kit.passagesOf(person)).toEqual([]);
    expect(lastMessage()!.buttons).toEqual([{ label: "Другой", payload: menuButtonPayload(other.code) }]);
  });

  it("человек с прошлым разговором по ссылке снятого лидмагнита — как без кода у вернувшегося: «Входящие» с автоответом", async () => {
    const lead = await kit.publish();
    await say(`/start ${lead.code}`, lead.code);
    await say("Готов");
    await unpublishLeadMagnet(database.db, lead.leadMagnetId);
    const sent = kit.textsTo(person).length;

    await say(`/start ${lead.code}`, lead.code);

    expect(kit.textsTo(person).slice(sent)).toEqual([AUTOREPLY_TEXT]);
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox", autoreply: true });
  });

  it("опубликовать снова — ссылка снова работает", async () => {
    const lead = await kit.publish();
    await unpublishLeadMagnet(database.db, lead.leadMagnetId);
    const again = await publishLeadMagnet(database.db, lead.leadMagnetId);
    expect(again.code).toBe(lead.code);

    await say(`/start ${lead.code}`, lead.code);
    expect((await kit.passagesOf(person))[0]).toMatchObject({ leadMagnetId: lead.leadMagnetId });
  });
});

describe("настройки бота без кода", () => {
  it("сохраняет режим и лидмагнит по умолчанию", async () => {
    const lead = await kit.publish();
    const saved = await botService.updateNoCodeSettings(kit.bot.id, { mode: "default", defaultLeadMagnetId: lead.leadMagnetId });
    expect(saved).toEqual({ ok: true });
    expect(await botService.getBot(kit.bot.id)).toMatchObject({ noCodeMode: "default", defaultLeadMagnetId: lead.leadMagnetId });

    await botService.updateNoCodeSettings(kit.bot.id, { mode: "menu", defaultLeadMagnetId: null });
    expect(await botService.getBot(kit.bot.id)).toMatchObject({ noCodeMode: "menu", defaultLeadMagnetId: null });
  });

  it("«по умолчанию» без лидмагнита или с лидмагнитом чужого бота — ошибка", async () => {
    const otherKit = await createLiveDialogKit(database);
    const foreign = await otherKit.publish();

    expect(await botService.updateNoCodeSettings(kit.bot.id, { mode: "default", defaultLeadMagnetId: null })).toMatchObject({
      ok: false,
    });
    expect(
      await botService.updateNoCodeSettings(kit.bot.id, { mode: "default", defaultLeadMagnetId: foreign.leadMagnetId }),
    ).toMatchObject({ ok: false });
    expect(await botService.updateNoCodeSettings(kit.bot.id, { mode: "weird" as NoCodeMode, defaultLeadMagnetId: null })).toMatchObject({
      ok: false,
    });
  });
});

describe("удаление бота", () => {
  it("с опубликованными лидмагнитами — нельзя, с объяснением; после снятия — удаляется", async () => {
    const lead = await kit.publish({ name: "Разбор воронки" });
    kit.channel.connectedWebhooks.set(kit.bot.id, "https://livem.test/hook");

    const refused = await botService.deleteBot(kit.bot.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/снимите с публикации.*Разбор воронки/i);
    expect((await botService.listBots()).map((bot) => bot.id)).toContain(kit.bot.id);

    await unpublishLeadMagnet(database.db, lead.leadMagnetId);
    expect(await botService.deleteBot(kit.bot.id)).toEqual({ ok: true });
    // Тревога «бот не работает» удалённому боту не нужна
    expect(alertsResolve).toHaveBeenCalledWith("bot_error", kit.bot.id);

    expect((await botService.listBots()).map((bot) => bot.id)).not.toContain(kit.bot.id);
    expect(await botService.getBot(kit.bot.id)).toBeNull();
    expect(kit.channel.connectedWebhooks.has(kit.bot.id)).toBe(false);
    // Удалённый бот больше не принимает сообщения
    expect((await kit.send(person, "Привет")).status).toBe(401);
  });

  it("идущие разговоры бота: удаление закрывает их как «не завершил» и снимает напоминания", async () => {
    const lead = await kit.publish();
    await say("/start", lead.code);
    const other = `user-${randomUUID().slice(0, 8)}`;
    await kit.send(other, "/start", { startCode: lead.code });
    await kit.drain();
    await finishPassagesOf(other);
    await unpublishLeadMagnet(database.db, lead.leadMagnetId);
    expect(await botService.countActiveConversations(kit.bot.id)).toBe(1);

    expect(await botService.deleteBot(kit.bot.id)).toEqual({ ok: true });

    const [passage] = await kit.passagesOf(person);
    expect(passage).toMatchObject({ status: "not_completed", nextReminderAt: null });
    expect(passage!.endedAt).not.toBeNull();
    // Завершённый разговор так и остаётся завершённым
    expect((await kit.passagesOf(other))[0]).toMatchObject({ status: "completed" });
  });

  it("предупреждение перед удалением: сколько разговоров идёт на этом боте", async () => {
    const lead = await kit.publish();
    expect(await botService.countActiveConversations(kit.bot.id)).toBe(0);
    await say("/start", lead.code);
    await kit.send(`user-${randomUUID().slice(0, 8)}`, "/start", { startCode: lead.code });
    await kit.drain();

    expect(await botService.countActiveConversations(kit.bot.id)).toBe(2);
    expect(await botService.countActiveConversations(randomUUID())).toBe(0);
  });

  it("на удалённого бота лидмагнит не публикуется, даже если привязка осталась", async () => {
    const lead = await kit.publish();
    await unpublishLeadMagnet(database.db, lead.leadMagnetId);
    // Привязка пережила удаление — так бывает, если публикация шла одновременно с удалением
    await database.db.update(bots).set({ deletedAt: new Date() }).where(eq(bots.id, kit.bot.id));

    await expect(publishLeadMagnet(database.db, lead.leadMagnetId)).rejects.toBeInstanceOf(PublishError);
  });

  it("удалённого бота можно подключить заново тем же токеном", async () => {
    await botService.deleteBot(kit.bot.id);

    const again = await botService.connectBot({ channel: "telegram", token: kit.bot.token });

    expect(again).toMatchObject({ ok: true, bot: { id: kit.bot.id } });
    expect((await botService.listBots()).map((bot) => bot.id)).toContain(kit.bot.id);
  });
});
