// Доставка сообщений, которые сценарий пишет первым, через наши боты (срез S6): исход канала → исход для сценария.
import { randomUUID } from "node:crypto";
import type { FlowOutgoing } from "@ykurilov/agent-chat-flows";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { KIT_CIPHER, createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { checkAllBots, reportSendFailure, type ChannelAdapter } from "../channels";
import { outboundMessages } from "../channels/schema";
import { passages } from "../conversations/schema";
import { people } from "../people/schema";
import {
  PERSON_WROTE_AFTER_TOUCH_ERROR,
  REPAIR_WINDOW_PASSED_ERROR,
  SEND_CLAIM_MS,
  createFirstMessageDelivery,
  type FirstMessageDeliveryDependencies,
} from "./delivery";

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;
let chatId: string;
let personId: string;
let failures: Array<{ botId: string; error: string }>;
let endedFlows: Array<{ ownerId: string; chatId: string; reason: string; outcome?: string }>;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  person = `user-${randomUUID().slice(0, 8)}`;
  const lead = await kit.publish();
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  const [passage] = await kit.passagesOf(person);
  chatId = passage!.chatId;
  personId = passage!.personId;
  failures = [];
  endedFlows = [];
});

function delivery(channel: ChannelAdapter = kit.channel, extra: Partial<FirstMessageDeliveryDependencies> = {}) {
  return createFirstMessageDelivery({
    ...extra,
    db: database.db,
    clock: kit.clock,
    adapters: { telegram: channel },
    cipher: KIT_CIPHER,
    chatStorage: kit.chatStorage,
    onPermanentFailure: async (botId, error) => {
      failures.push({ botId, error });
      return "message";
    },
    endFlow: async (input) => void endedFlows.push(input),
  });
}

/** Проверка бота как в работнике: тревога, статус «ошибка», после починки — повтор помеченных исходящих. */
const botHealth = () => ({ db: database.db, queue: kit.queue, alerts: kit.alerts, adapters: { telegram: kit.channel }, cipher: KIT_CIPHER });

/** Доставка с настоящей проверкой бота при сбое насовсем, как её собирает живой разговор. */
function deliveryCheckingBot() {
  return createFirstMessageDelivery({
    db: database.db,
    clock: kit.clock,
    adapters: { telegram: kit.channel },
    cipher: KIT_CIPHER,
    chatStorage: kit.chatStorage,
    onPermanentFailure: (botId, error) => reportSendFailure(botHealth(), botId, error),
    endFlow: async (input) => void endedFlows.push(input),
  });
}

/** Итог обещания или «ещё ждёт», если не успело за `ms`. */
const settledWithin = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<"ещё ждёт">((resolve) => setTimeout(() => resolve("ещё ждёт"), ms))]);

/** Мессенджер, который отвечает только по команде: отправка «висит», пока тест не отпустит. */
function slowChannel() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const channel: ChannelAdapter = Object.create(kit.channel);
  channel.send = async (...args) => {
    entered();
    await gate;
    return kit.channel.send(...args);
  };
  return { channel, started, release };
}

/** Продление захвата в тестах — чаще, чтобы не ждать настоящие полминуты; редкий срок отличает его таймер от чужих. */
const RENEW_MS = 17;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ждёт условия до `ms`; итог — выполнилось ли. */
async function eventually(check: () => Promise<boolean>, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await pause(RENEW_MS);
  }
  return false;
}

/** Таймеры продления захвата, которые завела доставка, и сняла ли она каждый. */
function watchRenewalTimers() {
  const set = vi.spyOn(globalThis, "setInterval");
  const clear = vi.spyOn(globalThis, "clearInterval");
  return {
    started: () => set.mock.calls.flatMap((call, index) => (call[1] === RENEW_MS ? [set.mock.results[index]!.value] : [])),
    cleared: (timer: unknown) => clear.mock.calls.some(([cleared]) => cleared === timer),
    restore: () => {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}

function message(patch: Partial<FlowOutgoing> = {}): FlowOutgoing {
  const text = patch.text ?? "Как продвигается идея?";
  return { ownerId: personId, chatId, messageId: randomUUID(), text, parts: [{ type: "text", text }], reasons: [{ kind: "silence", step: 1 }], attempt: 1, ...patch };
}

const shownVideo = (id: string) =>
  ({
    type: "tool-show_video",
    toolCallId: `call-${id}`,
    state: "output-available",
    input: { id },
    output: { видео: { id, название: `Ролик ${id}`, площадка: "kinescope", код: `code${id}` } },
  }) as unknown as FlowOutgoing["parts"][number];

const outreachRows = () => database.db.select().from(outboundMessages).where(eq(outboundMessages.personId, personId)).then((rows) => rows.filter((row) => row.kind === "outreach"));

describe("доставка сообщений первым через наш бот", () => {
  it("уходит сразу в мессенджер человека и пишется в исходящие разговора как «первым»", async () => {
    const sentBefore = kit.textsTo(person).length;
    expect(await delivery()(message())).toEqual({ status: "delivered" });

    expect(kit.textsTo(person).slice(sentBefore)).toEqual(["Как продвигается идея?"]);
    const [passage] = await kit.passagesOf(person);
    expect(await outreachRows()).toEqual([
      expect.objectContaining({ kind: "outreach", status: "sent", passageId: passage!.id, botId: kit.bot.id, text: "Как продвигается идея?" }),
    ]);
  });

  it("касание с карточкой ролика: текст, следом ролик ссылкой, ролик записан в исходящие", async () => {
    const sentBefore = kit.textsTo(person).length;
    const text = "Вот короткий ролик про первый шаг";
    expect(await delivery()(message({ text, parts: [{ type: "text", text }, shownVideo("v1")] }))).toEqual({ status: "delivered" });

    expect(kit.textsTo(person).slice(sentBefore)).toEqual([text, "▶ Ролик v1\nhttps://kinescope.io/codev1"]);
    expect(await outreachRows()).toEqual([expect.objectContaining({ video: { title: "Ролик v1", url: "https://kinescope.io/codev1" } })]);
  });

  it("касание только карточкой, без текста, тоже уходит; ролик, уже показанный в разговоре, второй раз не шлётся", async () => {
    const sentBefore = kit.textsTo(person).length;
    expect(await delivery()(message({ text: "", parts: [shownVideo("v2")] }))).toEqual({ status: "delivered" });
    expect(kit.textsTo(person).slice(sentBefore)).toEqual(["▶ Ролик v2\nhttps://kinescope.io/codev2"]);

    // Ответ с этим роликом уже в истории: человек его получил
    const [last] = (await kit.chatStorage.listMessages(chatId)).slice(-1);
    await kit.chatStorage.insertMessage({ ...last!, id: randomUUID(), parentId: last!.id, role: "assistant", parts: [shownVideo("v2")] });
    const repeat = "Пересмотрите ролик";
    expect(await delivery()(message({ text: repeat, parts: [{ type: "text", text: repeat }, shownVideo("v2")] }))).toEqual({ status: "delivered" });
    expect(kit.textsTo(person).at(-1)).toBe(repeat);
  });

  it("касание с картинкой: фото с текстом в подписи, файл — из папки загрузок; показанная раньше картинка второй раз не шлётся", async () => {
    const fileName = "image-00000000-0000-4000-8000-0000000000c1.png";
    const shownImage = {
      type: "tool-show_image",
      toolCallId: "call-c1",
      state: "output-available",
      input: { id: "c1" },
      output: { картинка: { id: "c1", название: "Редактор", подпись: "Где редактор", адрес: `/api/images/${fileName}`, ширина: 10, высота: 10 } },
    } as unknown as FlowOutgoing["parts"][number];
    const text = "Вот где редактор";
    const before = kit.channel.messagesTo(person).length;
    expect(await delivery()(message({ text, parts: [{ type: "text", text }, shownImage] }))).toEqual({ status: "delivered" });
    const [sent] = kit.channel.messagesTo(person).slice(before);
    expect(sent!.message).toMatchObject({ text, imagePath: expect.stringMatching(new RegExp(`/${fileName}$`)) });

    const [last] = (await kit.chatStorage.listMessages(chatId)).slice(-1);
    await kit.chatStorage.insertMessage({ ...last!, id: randomUUID(), parentId: last!.id, role: "assistant", parts: [shownImage] });
    const repeat = "Ещё раз про редактор";
    expect(await delivery()(message({ text: repeat, parts: [{ type: "text", text: repeat }, shownImage] }))).toEqual({ status: "delivered" });
    expect(kit.channel.messagesTo(person).at(-1)!.message.imagePath).toBeUndefined();
  });

  it("тот же messageId второй раз не отправляется: доставлено", async () => {
    const outgoing = message();
    await delivery()(outgoing);
    const sentBefore = kit.textsTo(person).length;

    expect(await delivery()({ ...outgoing, attempt: 2 })).toEqual({ status: "delivered" });
    expect(kit.textsTo(person)).toHaveLength(sentBefore);
    expect(await outreachRows()).toHaveLength(1);
  });

  it("медленный мессенджер не держит строку исходящих: пока идёт отправка, запись свободна и видна «отправляется»", async () => {
    const slow = slowChannel();
    const sending = delivery(slow.channel)(message());
    await slow.started;

    // Отправка внутри транзакции держала бы строку под замком: nowait упал бы с «could not obtain lock»
    const client = await database.pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<{ status: string }>(
        "select status from app.outbound_messages where person_id = $1 and kind = 'outreach' for update nowait",
        [personId],
      );
      await client.query("rollback");
      expect(rows).toEqual([{ status: "sending" }]);
    } finally {
      client.release();
      slow.release();
    }
    expect(await sending).toEqual({ status: "delivered" });
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "sent", attempts: 1 })]);
  });

  it("два обхода одновременно с одним messageId — уходит один раз: второй ждёт повтора, потом «доставлено»", async () => {
    const outgoing = message();
    const slow = slowChannel();
    const first = delivery(slow.channel)(outgoing);
    await slow.started;
    const sentBefore = kit.textsTo(person).length;

    // Второй обход не ждёт первого: сразу «повторить позже»
    try {
      expect(await settledWithin(delivery()({ ...outgoing }), 2_000)).toEqual({ status: "retry" });
    } finally {
      slow.release();
    }
    expect(await first).toEqual({ status: "delivered" });
    expect(await delivery()({ ...outgoing, attempt: 2 })).toEqual({ status: "delivered" });

    expect(kit.textsTo(person).slice(sentBefore)).toEqual([outgoing.text]);
    expect(await outreachRows()).toHaveLength(1);
  });

  it("живая отправка дольше срока захвата — захват продлевается: второй обход не шлёт повторно, после итога продление снято", async () => {
    const outgoing = message();
    const slow = slowChannel();
    const timers = watchRenewalTimers();
    try {
      const first = delivery(slow.channel, { claimRenewMs: RENEW_MS })(outgoing);
      await slow.started;
      const sentBefore = kit.textsTo(person).length;

      // Мессенджер думает дольше срока захвата: без продления строку забрал бы следующий обход
      kit.clock.advance(SEND_CLAIM_MS + 60_000);
      const renewed = await eventually(async () => (await outreachRows())[0]!.nextAttemptAt > kit.clock.now());
      try {
        expect(renewed).toBe(true);
        expect(await settledWithin(delivery()({ ...outgoing, attempt: 2 }), 2_000)).toEqual({ status: "retry" });
      } finally {
        slow.release();
      }
      expect(await first).toEqual({ status: "delivered" });
      expect(kit.textsTo(person).slice(sentBefore)).toEqual([outgoing.text]);
      const settled = await outreachRows();
      expect(settled).toEqual([expect.objectContaining({ status: "sent", attempts: 1 })]);

      expect(timers.started().length).toBeGreaterThan(0);
      expect(timers.started().every(timers.cleared)).toBe(true);
      await pause(5 * RENEW_MS);
      expect(await outreachRows()).toEqual(settled);
    } finally {
      timers.restore();
    }
  });

  it("первый обход завис и его захват забрал другой — продление и итог зависшего не затирают нового владельца", async () => {
    const outgoing = message();
    const slow = slowChannel();
    const first = delivery(slow.channel, { claimRenewMs: RENEW_MS })(outgoing);
    await slow.started;
    // Другой обход взял строку после истёкшего захвата (зависший процесс не успел продлить)
    const takenOver = new Date(kit.clock.now().getTime() + 10 * 60_000);
    await database.db.update(outboundMessages).set({ nextAttemptAt: takenOver, attempts: 7 }).where(eq(outboundMessages.idempotencyKey, `flow:${outgoing.messageId}`));

    await pause(5 * RENEW_MS);
    slow.release();
    await first;
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "sending", nextAttemptAt: takenOver, attempts: 7 })]);
  });

  it("отправка упала исключением до мессенджера — продление захвата снято, ошибка уходит наверх", async () => {
    const timers = watchRenewalTimers();
    try {
      const rateLimiter = { acquire: async () => Promise.reject(new Error("ограничитель упал")) };
      await expect(delivery(kit.channel, { claimRenewMs: RENEW_MS, rateLimiter })(message())).rejects.toThrow("ограничитель упал");
      expect(timers.started().length).toBeGreaterThan(0);
      expect(timers.started().every(timers.cleared)).toBe(true);
    } finally {
      timers.restore();
    }
  });

  it("отправка оборвалась на середине (работник упал) — после срока захвата тот же текст уходит, второй записи нет", async () => {
    const outgoing = message();
    await database.db.insert(outboundMessages).values({
      botId: kit.bot.id,
      personId,
      kind: "outreach",
      passageId: (await kit.passagesOf(person))[0]!.id,
      text: outgoing.text,
      idempotencyKey: `flow:${outgoing.messageId}`,
      status: "sending",
      // Захват упавшего работника ещё не истёк
      nextAttemptAt: new Date(kit.clock.now().getTime() + 60_000),
    });
    const sentBefore = kit.textsTo(person).length;

    expect(await delivery()(outgoing)).toEqual({ status: "retry" });
    kit.clock.advance(5 * 60_000);
    expect(await delivery()({ ...outgoing, attempt: 2 })).toEqual({ status: "delivered" });
    expect(kit.textsTo(person).slice(sentBefore)).toEqual([outgoing.text]);
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "sent" })]);
  });

  it("прохождение уже закрыто — касание не уходит, записи нет, сценарий заканчивается", async () => {
    await database.db.update(passages).set({ status: "completed", endedAt: kit.clock.now() }).where(eq(passages.chatId, chatId));
    const sent = kit.channel.sent.length;

    expect(await delivery()(message())).toEqual({ status: "failed" });
    expect(kit.channel.sent).toHaveLength(sent);
    expect(await outreachRows()).toEqual([]);
    expect(endedFlows).toEqual([{ ownerId: personId, chatId, reason: "passage_closed", outcome: "прохождение уже закрыто: completed" }]);
  });

  it("прощание «срок вышел»: прохождение уже закрыто концом сценария — прощание всё равно уходит, сценарий не трогается", async () => {
    await database.db.update(passages).set({ status: "term_ended", endedAt: kit.clock.now() }).where(eq(passages.chatId, chatId));
    const sentBefore = kit.textsTo(person).length;

    expect(await delivery()(message({ text: "Наша трёхдневка закончилась!", reasons: [{ kind: "farewell" }] }))).toEqual({ status: "delivered" });
    expect(kit.textsTo(person).slice(sentBefore)).toEqual(["Наша трёхдневка закончилась!"]);
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "sent", text: "Наша трёхдневка закончилась!" })]);
    expect(endedFlows).toEqual([]);
  });

  it("человек заблокировал бота — blocked, человек помечен", async () => {
    kit.channel.blockUser(person);
    expect(await delivery()(message())).toEqual({ status: "blocked" });

    const [row] = await database.db.select({ blockedAt: people.blockedAt }).from(people).where(eq(people.id, personId));
    expect(row!.blockedAt).toEqual(kit.clock.now());
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "blocked" })]);
  });

  it("ВК не даёт писать первым (950) — window_closed, без тревоги эксперту", async () => {
    kit.channel.failNext({ ok: false, reason: "reply_window_closed" });
    expect(await delivery()(message())).toEqual({ status: "window_closed" });
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(failures).toEqual([]);
  });

  it("ограничение скорости — повтор через указанный срок; сеть — повтор по ряду сценария; потом тот же текст уходит один раз", async () => {
    const outgoing = message();
    kit.channel.failNext({ ok: false, reason: "rate_limited", retryAfterMs: 7_000 });
    expect(await delivery()(outgoing)).toEqual({ status: "retry", afterMs: 7_000 });
    kit.channel.failNext({ ok: false, reason: "temporary", error: "ECONNRESET" });
    expect(await delivery()({ ...outgoing, attempt: 2 })).toEqual({ status: "retry" });

    // Пока ждёт повтор сценария, подметальщик исходящих его не трогает: отправку повторяет только сценарий
    kit.clock.advance(60 * 60_000);
    await kit.dialog.sweepStuck();
    await kit.drain();
    expect(kit.textsTo(person).filter((text) => text === outgoing.text)).toEqual([]);

    expect(await delivery()({ ...outgoing, attempt: 3 })).toEqual({ status: "delivered" });
    expect(kit.textsTo(person).filter((text) => text === outgoing.text)).toHaveLength(1);
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "sent" })]);
  });

  it("сбой насовсем — failed и тревога о боте; сообщение не ждёт починки бота", async () => {
    kit.channel.failNext({ ok: false, reason: "permanent", error: "chat not found" });
    expect(await delivery()(message())).toEqual({ status: "failed" });
    expect(failures).toEqual([{ botId: kit.bot.id, error: "chat not found" }]);
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "failed", awaitsBotRepair: false })]);
  });

  it("токен бота отозван — сценарию «ждать починки», запись ждёт; очередь после починки её не шлёт; тот же messageId после починки — только остаток", async () => {
    const text = "Вот ролик к следующему шагу";
    const outgoing = message({ text, parts: [{ type: "text", text }, shownVideo("v7")] });
    const sentBefore = kit.textsTo(person).length;
    // Мессенджер принял текст, на ролике бот перестал отвечать: токен отозван
    kit.channel.failNext({ ok: false, reason: "permanent", error: "Unauthorized", sentParts: 1 });
    kit.channel.breakConnection("Unauthorized");

    expect(await deliveryCheckingBot()(outgoing)).toEqual({ status: "await_repair" });
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "awaiting_repair", sentParts: 1, awaitsBotRepair: false })]);

    // Бота починили: проверка ботов повторяет помеченные исходящие очереди — касание сценария не её, второй отправки нет
    kit.channel.breakConnection(null);
    await checkAllBots(botHealth());
    await kit.drain();
    expect(kit.textsTo(person).slice(sentBefore)).toEqual([]);
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "awaiting_repair" })]);

    // Сценарий после починки отдаёт ту же попытку: текст второй раз не уходит, повтор продолжает с ролика
    expect(await deliveryCheckingBot()(outgoing)).toEqual({ status: "delivered" });
    expect(kit.textsTo(person).slice(sentBefore)).toEqual(["▶ Ролик v7\nhttps://kinescope.io/codev7"]);
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "sent", sentParts: 1 })]);
  });

  it("касание ждало починки дольше 3 суток (время базы) — «не доставлено» без отправки, даже если бот уже исправен", async () => {
    const outgoing = message();
    kit.channel.failNext({ ok: false, reason: "permanent", error: "Unauthorized" });
    kit.channel.breakConnection("Unauthorized");
    expect(await deliveryCheckingBot()(outgoing)).toEqual({ status: "await_repair" });
    // Часы приложения не двигаем: окно считается по времени базы
    await database.pool.query("update app.outbound_messages set created_at = now() - interval '3 days 1 minute' where idempotency_key = $1", [`flow:${outgoing.messageId}`]);
    kit.channel.breakConnection(null);
    const sent = kit.channel.sent.length;

    expect(await deliveryCheckingBot()(outgoing)).toEqual({ status: "failed" });
    expect(kit.channel.sent).toHaveLength(sent);
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "failed", error: REPAIR_WINDOW_PASSED_ERROR })]);
  });

  it("прощание «срок вышел» ждало починки — после неё уходит, сценарий не трогается", async () => {
    await database.db.update(passages).set({ status: "term_ended", endedAt: kit.clock.now() }).where(eq(passages.chatId, chatId));
    const farewell = message({ text: "Наша трёхдневка закончилась!", reasons: [{ kind: "farewell" }] });
    kit.channel.failNext({ ok: false, reason: "permanent", error: "Unauthorized" });
    kit.channel.breakConnection("Unauthorized");
    expect(await deliveryCheckingBot()(farewell)).toEqual({ status: "await_repair" });
    kit.channel.breakConnection(null);
    const sentBefore = kit.textsTo(person).length;

    expect(await deliveryCheckingBot()(farewell)).toEqual({ status: "delivered" });
    expect(kit.textsTo(person).slice(sentBefore)).toEqual(["Наша трёхдневка закончилась!"]);
    expect(endedFlows).toEqual([]);
  });

  it.each(["completed", "not_completed", "blocked"] as const)(
    "прощание ждало починки, а прохождение закрыли явно (%s) — не уходит, сценарий заканчивается",
    async (status) => {
      await database.db.update(passages).set({ status: "term_ended", endedAt: kit.clock.now() }).where(eq(passages.chatId, chatId));
      const farewell = message({ text: "Наша трёхдневка закончилась!", reasons: [{ kind: "farewell" }] });
      kit.channel.failNext({ ok: false, reason: "permanent", error: "Unauthorized" });
      kit.channel.breakConnection("Unauthorized");
      expect(await deliveryCheckingBot()(farewell)).toEqual({ status: "await_repair" });
      kit.channel.breakConnection(null);
      await database.db.update(passages).set({ status }).where(eq(passages.chatId, chatId));
      const sent = kit.channel.sent.length;

      expect(await deliveryCheckingBot()(farewell)).toEqual({ status: "failed" });
      expect(kit.channel.sent).toHaveLength(sent);
      expect(endedFlows).toEqual([{ ownerId: personId, chatId, reason: "passage_closed", outcome: `прохождение уже закрыто: ${status}` }]);
    },
  );

  it("прощание ждало починки, а человек написал во «Входящие» — старое прощание не уходит, «не доставлено»", async () => {
    await database.db.update(passages).set({ status: "term_ended", endedAt: kit.clock.now() }).where(eq(passages.chatId, chatId));
    const farewell = message({ text: "Наша трёхдневка закончилась!", reasons: [{ kind: "farewell" }] });
    kit.channel.failNext({ ok: false, reason: "permanent", error: "Unauthorized" });
    kit.channel.breakConnection("Unauthorized");
    expect(await deliveryCheckingBot()(farewell)).toEqual({ status: "await_repair" });
    // После «срок вышел» сообщение человека идёт эксперту, а не в историю сценария
    await kit.send(person, "А можно ещё вопрос?");
    await kit.drain();
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox" });
    kit.channel.breakConnection(null);
    const sentBefore = kit.textsTo(person).length;

    expect(await deliveryCheckingBot()(farewell)).toEqual({ status: "failed" });
    expect(kit.textsTo(person).slice(sentBefore)).toEqual([]);
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "failed", error: PERSON_WROTE_AFTER_TOUCH_ERROR })]);
  });

  /** Прощание из двух частей ушло в сломанный бот на ролике, бота починили, возобновлённая отправка упала временным сбоем. */
  async function farewellRepairedThenTemporaryFailure() {
    await database.db.update(passages).set({ status: "term_ended", endedAt: kit.clock.now() }).where(eq(passages.chatId, chatId));
    const text = "Наша трёхдневка закончилась!";
    const farewell = message({ text, parts: [{ type: "text", text }, shownVideo("v9")], reasons: [{ kind: "farewell" }] });
    kit.channel.failNext({ ok: false, reason: "permanent", error: "Unauthorized", sentParts: 1 });
    kit.channel.breakConnection("Unauthorized");
    expect(await deliveryCheckingBot()(farewell)).toEqual({ status: "await_repair" });
    kit.channel.breakConnection(null);
    kit.channel.failNext({ ok: false, reason: "temporary", error: "сеть" });
    expect(await deliveryCheckingBot()(farewell)).toEqual({ status: "retry" });
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "failed", sentParts: 1 })]);
    return farewell;
  }

  it("после починки временный сбой, затем человек написал во «Входящие» — повтор сценария старое прощание не шлёт, части не теряются", async () => {
    const farewell = await farewellRepairedThenTemporaryFailure();
    await kit.send(person, "А можно ещё вопрос?");
    await kit.drain();
    expect((await kit.inboundOf(person)).at(-1)).toMatchObject({ route: "inbox" });
    const sent = kit.channel.sent.length;

    expect(await deliveryCheckingBot()({ ...farewell, attempt: 2 })).toEqual({ status: "failed" });
    expect(kit.channel.sent).toHaveLength(sent);
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "failed", sentParts: 1, error: PERSON_WROTE_AFTER_TOUCH_ERROR })]);
  });

  it("после починки обход отправки упал (захват истёк), затем человек написал во «Входящие» — повтор старое прощание не шлёт", async () => {
    const farewell = await farewellRepairedThenTemporaryFailure();
    // Следующая попытка взяла строку и упала вместе с работником: захват истёк
    await database.db
      .update(outboundMessages)
      .set({ status: "sending", nextAttemptAt: new Date(kit.clock.now().getTime() - 1_000) })
      .where(eq(outboundMessages.idempotencyKey, `flow:${farewell.messageId}`));
    await kit.send(person, "А можно ещё вопрос?");
    await kit.drain();
    const sent = kit.channel.sent.length;

    expect(await deliveryCheckingBot()({ ...farewell, attempt: 2 })).toEqual({ status: "failed" });
    expect(kit.channel.sent).toHaveLength(sent);
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "failed", sentParts: 1, error: PERSON_WROTE_AFTER_TOUCH_ERROR })]);
  });

  it("после починки временный сбой, человек молчит — повтор сценария доставляет то же прощание: только остаток", async () => {
    const farewell = await farewellRepairedThenTemporaryFailure();
    const sentBefore = kit.textsTo(person).length;

    expect(await deliveryCheckingBot()({ ...farewell, attempt: 2 })).toEqual({ status: "delivered" });
    expect(kit.textsTo(person).slice(sentBefore)).toEqual(["▶ Ролик v9\nhttps://kinescope.io/codev9"]);
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "sent", sentParts: 1 })]);
  });

  it("бот жив, не прошло само сообщение — failed без повторов, даже с настоящей проверкой бота", async () => {
    kit.channel.failNext({ ok: false, reason: "permanent", error: "chat not found" });
    expect(await deliveryCheckingBot()(message())).toEqual({ status: "failed" });
    expect(await outreachRows()).toEqual([expect.objectContaining({ status: "failed", awaitsBotRepair: false })]);
  });

  it("чат без прохождения (тестовый чат «Проверки») в настоящие боты не уходит", async () => {
    const sent = kit.channel.sent.length;
    expect(await delivery()(message({ ownerId: "cabinet", chatId: randomUUID() }))).toEqual({ status: "failed" });
    expect(kit.channel.sent).toHaveLength(sent);
  });
});
