import { randomUUID } from "node:crypto";
import { loadCurrentBranch } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import {
  DEFAULT_CONSULTANT_REPLY,
  createLiveDialogKit,
  defaultConsultantReply,
  outboundOf,
  providerOutage,
  type LiveDialogKit,
} from "../../../tests/integration/live-dialog-kit";
import { bots, outboundMessages } from "../channels/schema";
import { expertReplyText } from "../consultant/expert-reply";
import { AUTOREPLY_TEXT } from "../conversations/router";
import { inboundMessages } from "../conversations/schema";
import { loadPersonCard } from "../people";
import { STAFF_SILENCE_HOURS } from "../flows";
import { updateSettings } from "../platform/settings";
import {
  InboxReplyError,
  countUnansweredThreads,
  inboxThreads,
  listUnansweredThreads,
  loadInboxThread,
  replyFromInbox,
} from "./index";

const FAREWELL = "Спасибо за разговор! До встречи.";
const DAY = 24 * 60 * 60_000;
/** Ответил эксперт — консультант молчит, пока эксперт не замолчит на 2 часа (пауза сценария, решение Дмитрия). */
const STAFF_PAUSE_MS = STAFF_SILENCE_HOURS * 60 * 60_000 + 60_000;

let database: TestDatabase;
let kit: LiveDialogKit;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await updateSettings(database.db, { monthlyBudgetUsd: null, dailyLimitUsd: "1000" });
  kit = await createLiveDialogKit(database, { pricePerMillion: 0 });
});

const newUser = () => `user-${randomUUID().slice(0, 8)}`;

async function say(user: string, text: string, startCode?: string) {
  await kit.send(user, text, startCode ? { startCode } : {});
  await kit.drain();
}

/** Человек прошёл лидмагнит до конца. */
async function finishedPassage(user: string) {
  const lead = await kit.publish();
  await say(user, `/start ${lead.code}`, lead.code);
  await say(user, "Я готов к созвону");
  expect(kit.textsTo(user).at(-1)).toContain(FAREWELL);
}

async function threadOf(user: string) {
  const person = await kit.personOf(user);
  const [thread] = await kit.db.select().from(inboxThreads).where(eq(inboxThreads.personId, person!.id));
  return thread;
}

const replyDeps = () => ({ db: kit.db, queue: kit.queue, clock: kit.clock });

describe("входящие после завершения", () => {
  it("сообщение после завершения — счётчик +1, автоответ один раз в сутки", async () => {
    const user = newUser();
    await finishedPassage(user);
    const before = await countUnansweredThreads(kit.db);

    await say(user, "А когда созвон?");
    expect(await threadOf(user)).toMatchObject({ unansweredCount: 1 });
    expect(await countUnansweredThreads(kit.db)).toBe(before + 1);
    expect(kit.textsTo(user).at(-1)).toBe(AUTOREPLY_TEXT);

    await say(user, "Жду ответа");
    expect(await threadOf(user)).toMatchObject({ unansweredCount: 2 });
    // Тот же человек — одна переписка в счётчике
    expect(await countUnansweredThreads(kit.db)).toBe(before + 1);
    expect(kit.textsTo(user).filter((text) => text === AUTOREPLY_TEXT)).toHaveLength(1);

    const person = await kit.personOf(user);
    const listed = (await listUnansweredThreads(kit.db)).find((thread) => thread.personId === person!.id);
    expect(listed).toMatchObject({ displayName: `Человек ${user}`, unansweredCount: 2, lastText: "Жду ответа", handoverReason: null });
  });

  it("ответ эксперта уходит от бота человека, обнуляет счётчик и снимает автоответ на сегодня", async () => {
    const user = newUser();
    await finishedPassage(user);
    await say(user, "Есть вопрос");
    const person = await kit.personOf(user);
    const thread = await loadInboxThread(kit.db, person!.id);
    expect(thread!.unansweredCount).toBe(1);

    await replyFromInbox(replyDeps(), {
      personId: person!.id,
      text: "  Здравствуйте! Отвечаю лично.  ",
      seenUpTo: thread!.lastMessageAt!,
      requestId: randomUUID(),
    });
    await kit.drain();

    expect(kit.textsTo(user).at(-1)).toBe("Здравствуйте! Отвечаю лично.");
    const manual = (await outboundOf(kit)).filter((row) => row.kind === "manual_reply");
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ botId: kit.bot.id, personId: person!.id, status: "sent" });
    expect(await threadOf(user)).toMatchObject({ unansweredCount: 0 });
    expect((await kit.personOf(user))!.lastManualReplyOn).toBe(kit.clock.mskDate());
    expect((await listUnansweredThreads(kit.db)).map((row) => row.personId)).not.toContain(person!.id);

    // В тот же день — во «Входящие», но без автоответа
    const sentBefore = kit.textsTo(user).length;
    await say(user, "Спасибо!");
    expect(await threadOf(user)).toMatchObject({ unansweredCount: 1 });
    expect(kit.textsTo(user)).toHaveLength(sentBefore);

    // На следующий день автоответ снова есть
    kit.clock.advance(DAY);
    await say(user, "Ещё вопрос");
    expect(kit.textsTo(user).at(-1)).toBe(AUTOREPLY_TEXT);
  });

  it("переписка: входящие и ответы бота по времени", async () => {
    const user = newUser();
    await finishedPassage(user);
    await say(user, "Вопрос после");
    const person = await kit.personOf(user);
    const before = await loadInboxThread(kit.db, person!.id);
    await replyFromInbox(replyDeps(), { personId: person!.id, text: "Ответ", seenUpTo: before!.lastMessageAt!, requestId: randomUUID() });
    await kit.drain();

    const thread = await loadInboxThread(kit.db, person!.id);
    expect(thread!.person).toMatchObject({ id: person!.id, displayName: `Человек ${user}`, channel: "telegram" });
    const tail = thread!.messages.slice(-3).map((message) => [message.direction, message.text]);
    expect(tail).toEqual([
      ["in", "Вопрос после"],
      ["out", AUTOREPLY_TEXT],
      ["out", "Ответ"],
    ]);
    expect(thread!.messages.at(-1)).toMatchObject({ kind: "manual_reply" });
  });

  it("сообщение, пришедшее после открытия переписки, ответ не обнуляет", async () => {
    const user = newUser();
    await finishedPassage(user);
    await say(user, "Первый вопрос");
    const person = await kit.personOf(user);
    const seen = await loadInboxThread(kit.db, person!.id);

    kit.clock.advance(60_000);
    await say(user, "Второй вопрос, пока вы писали");
    await replyFromInbox(replyDeps(), { personId: person!.id, text: "Ответ на первый", seenUpTo: seen!.lastMessageAt!, requestId: randomUUID() });

    expect(await threadOf(user)).toMatchObject({ unansweredCount: 1 });
  });

  it("сообщение, увиденное ещё в разговоре и переданное во «Входящие» при открытой переписке, ответ закрывает; пришедшее после — нет", async () => {
    const user = newUser();
    await finishedPassage(user);
    await say(user, "Первый вопрос");
    const person = await kit.personOf(user);
    // Сообщение ещё ведёт разговор (маршрут прохождения), но в переписке эксперт его уже видит
    const [handed] = await kit.db
      .insert(inboundMessages)
      .values({ botId: kit.bot.id, kind: "message", dedupeKey: `direct:${randomUUID()}`, externalUserId: user, text: "Второй, пока шёл разговор", personId: person!.id, route: "passage", processedAt: kit.clock.now() })
      .returning();
    const seen = await loadInboxThread(kit.db, person!.id);
    expect(seen!.messages.map((message) => message.text)).toContain("Второй, пока шёл разговор");

    // Пока форма открыта, разговор передал это сообщение эксперту, а следом человек написал ещё
    await kit.db.update(inboundMessages).set({ route: "inbox" }).where(eq(inboundMessages.id, handed!.id));
    await say(user, "Третий, после просмотра");
    expect(await threadOf(user)).toMatchObject({ unansweredCount: 3 });

    await replyFromInbox(replyDeps(), { personId: person!.id, text: "Отвечаю на оба", seenUpTo: seen!.seenUpTo, requestId: randomUUID() });
    expect(await threadOf(user)).toMatchObject({ unansweredCount: 1 });
  });

  it("исходящие после последнего входящего «прочитано до» не сдвигают", async () => {
    const user = newUser();
    await finishedPassage(user);
    await say(user, "Вопрос");
    const person = await kit.personOf(user);
    const [incoming] = await kit.db.select().from(inboundMessages).where(eq(inboundMessages.text, "Вопрос")).then((rows) => rows.filter((row) => row.personId === person!.id));
    const thread = await loadInboxThread(kit.db, person!.id);
    // После вопроса бот уже ответил автоответом: позже по времени, но это не входящее
    expect(thread!.messages.at(-1)).toMatchObject({ direction: "out" });
    expect(thread!.seenUpTo.getTime()).toBe(incoming!.receivedAt.getTime());
  });

  it("одна и та же отправка формы не уходит дважды", async () => {
    const user = newUser();
    await finishedPassage(user);
    await say(user, "Вопрос");
    const person = await kit.personOf(user);
    const thread = await loadInboxThread(kit.db, person!.id);
    const reply = { personId: person!.id, text: "Ответ", seenUpTo: thread!.lastMessageAt!, requestId: randomUUID() };

    await replyFromInbox(replyDeps(), reply);
    await replyFromInbox(replyDeps(), reply);
    await kit.drain();

    expect(kit.textsTo(user).filter((text) => text === "Ответ")).toHaveLength(1);
  });

  it("пустой ответ и неизвестный человек — ошибка", async () => {
    const user = newUser();
    await finishedPassage(user);
    const person = await kit.personOf(user);
    await expect(
      replyFromInbox(replyDeps(), { personId: person!.id, text: "   ", seenUpTo: kit.clock.now(), requestId: randomUUID() }),
    ).rejects.toThrow(InboxReplyError);
    await expect(
      replyFromInbox(replyDeps(), { personId: randomUUID(), text: "Привет", seenUpTo: kit.clock.now(), requestId: randomUUID() }),
    ).rejects.toThrow(InboxReplyError);
  });
});

describe("что не попадает во «Входящие»", () => {
  it("сообщение посреди нового прохождения идёт консультанту", async () => {
    const user = newUser();
    await finishedPassage(user);
    await say(user, "Вопрос после первого");
    expect(await threadOf(user)).toMatchObject({ unansweredCount: 1 });

    const second = await kit.publish();
    await say(user, `/start ${second.code}`, second.code);
    await say(user, "Ответ на рассылку посреди нового");

    expect(kit.textsTo(user).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
    expect(await threadOf(user)).toMatchObject({ unansweredCount: 1 });
  });
});

describe("ответ эксперта посреди разговора доходит до консультанта", () => {
  /** Всё, что модель видит от собеседника в запросе (без системной инструкции). */
  const userTexts = (call: (typeof kit.calls)[number]) =>
    call.options.prompt
      .filter((message) => message.role === "user")
      .flatMap((message) => message.content.map((part) => (part.type === "text" ? part.text : "")))
      .join("\n");

  it("следующий ход видит ответ эксперта один раз, начало запроса не меняется", async () => {
    const user = newUser();
    await say(user, "Здравствуйте");
    await replyFromInbox(replyDeps(), { personId: (await kit.personOf(user))!.id, text: "Старый ответ до разговора", seenUpTo: new Date(), requestId: randomUUID() });
    await kit.drain();
    kit.clock.advance(1000);
    const lead = await kit.publish();
    await say(user, `/start ${lead.code}`, lead.code);
    await say(user, "Расскажите про курс");
    const person = (await kit.personOf(user))!;

    await replyFromInbox(replyDeps(), { personId: person.id, text: "Созвон в четверг в 15:00", seenUpTo: new Date(), requestId: randomUUID() });
    await kit.drain();
    kit.clock.advance(STAFF_PAUSE_MS);
    const before = kit.calls.length;
    await say(user, "Отлично, жду");
    await say(user, "А что взять с собой?");

    const [withReply, next] = kit.calls.slice(before);
    expect(userTexts(withReply!)).toContain("Созвон в четверг в 15:00");
    expect(userTexts(withReply!)).toContain("Живой сотрудник ответил человеку вместо тебя");
    expect(userTexts(withReply!)).not.toContain("Старый ответ до разговора");
    // Реплика сотрудника — не оборванный ход: пометки «ответа нет» вокруг неё модель не видит
    expect(JSON.stringify(withReply!.options.prompt)).not.toContain("Ответа на это сообщение нет");
    // Запрос прошлого хода — начало нового: кэш модели цел
    const previous = kit.calls[before - 1]!.options.prompt;
    expect(withReply!.options.prompt.slice(0, previous.length - 1)).toEqual(previous.slice(0, -1));
    // Второй раз ответ эксперта не дописывается
    expect(userTexts(next!).split("Созвон в четверг в 15:00")).toHaveLength(2);
  });

  /** Человек посреди разговора, эксперт ему ответил из «Входящих». */
  async function midConversation() {
    const user = newUser();
    const lead = await kit.publish();
    await say(user, `/start ${lead.code}`, lead.code);
    await say(user, "Расскажите про курс");
    return { user, person: (await kit.personOf(user))! };
  }

  /** Эксперт ответил и замолчал: пауза консультанта прошла. */
  async function expertSays(personId: string, text: string) {
    await replyFromInbox(replyDeps(), { personId, text, seenUpTo: new Date(), requestId: randomUUID() });
    await kit.drain();
    kit.clock.advance(STAFF_PAUSE_MS);
  }

  it("пока эксперт ведёт разговор, консультант молчит: сообщение человека — эксперту во «Входящие»; 2 часа тишины эксперта — снова консультант", async () => {
    const { user, person } = await midConversation();
    await replyFromInbox(replyDeps(), { personId: person.id, text: "Созвон в четверг в 15:00", seenUpTo: new Date(), requestId: randomUUID() });
    await kit.drain();
    const callsBefore = kit.calls.length;
    const textsBefore = kit.textsTo(user).length;

    kit.clock.advance(60 * 60_000);
    await say(user, "А можно в пятницу?");
    expect(kit.calls.length).toBe(callsBefore);
    expect(kit.textsTo(user).length).toBe(textsBefore);
    expect(await threadOf(user)).toMatchObject({ unansweredCount: 1 });

    kit.clock.advance(STAFF_PAUSE_MS);
    await say(user, "Ау?");
    expect(kit.textsTo(user).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);
    // Консультант видит и ответ эксперта, и вопрос, на который ответил эксперт, а не он
    const seen = userTexts(kit.calls.at(-1)!);
    expect(seen).toContain("Созвон в четверг в 15:00");
    expect(seen).toContain("А можно в пятницу?");
  });

  it("ответ эксперта ложится репликой сотрудника с его именем: модель видит, кто ответил вместо неё", async () => {
    const { user, person } = await midConversation();
    await replyFromInbox(replyDeps(), { personId: person.id, text: "Созвон в четверг в 15:00", staffName: "Ольга", seenUpTo: new Date(), requestId: randomUUID() });
    await kit.drain();
    kit.clock.advance(STAFF_PAUSE_MS);

    await say(user, "Отлично, жду");
    expect(userTexts(kit.calls.at(-1)!)).toContain("Живой сотрудник «Ольга» ответил человеку вместо тебя: «Созвон в четверг в 15:00»");
  });

  it("у эксперта нет имени — модель видит просто «сотрудник»", async () => {
    const { user, person } = await midConversation();
    await expertSays(person.id, "Созвон в четверг в 15:00");

    await say(user, "Отлично, жду");
    expect(userTexts(kit.calls.at(-1)!)).toContain("Живой сотрудник ответил человеку вместо тебя: «Созвон в четверг в 15:00»");
  });

  const expertMessagesIn = async (user: string) => {
    const [passage] = await kit.passagesOf(user);
    const branch = await loadCurrentBranch(kit.chatStorage, passage!.chatId);
    return branch.map(expertReplyText).filter((text) => text !== null);
  };

  it("ход упал после записи ответа эксперта: повтор не дописывает его второй раз", async () => {
    const { user, person } = await midConversation();
    await expertSays(person.id, "Созвон в четверг в 15:00");
    let failed = false;
    kit.reply = (call) => {
      if (!failed) {
        failed = true;
        throw providerOutage();
      }
      return defaultConsultantReply(call);
    };
    const before = kit.calls.length;

    await say(user, "Отлично, жду");

    expect(kit.calls.length - before).toBe(2);
    expect(userTexts(kit.calls.at(-1)!).split("Созвон в четверг в 15:00")).toHaveLength(2);
    expect(await expertMessagesIn(user)).toEqual(["Созвон в четверг в 15:00"]);
    // И вне текущей ветки копии нет
    const [passage] = await kit.passagesOf(user);
    const everywhere = (await kit.chatStorage.listMessages(passage!.chatId)).map(expertReplyText).filter((text) => text !== null);
    expect(everywhere).toEqual(["Созвон в четверг в 15:00"]);
  });

  it("не ушедшие человеку ответы эксперта (сбой, блокировка) в историю не попадают", async () => {
    const { user, person } = await midConversation();
    kit.channel.failNext({ ok: false, reason: "permanent", error: "Bad Request: chat not found" });
    await expertSays(person.id, "Не дошло: сбой");
    await expertSays(person.id, "Не дошло: блокировка");
    await kit.db.update(outboundMessages).set({ status: "blocked" }).where(eq(outboundMessages.text, "Не дошло: блокировка"));
    expect((await outboundOf(kit)).filter((row) => row.kind === "manual_reply").map((row) => row.status).sort()).toEqual([
      "blocked",
      "failed",
    ]);

    await say(user, "Отлично, жду");
    expect(userTexts(kit.calls.at(-1)!)).not.toContain("Не дошло");
    expect(await expertMessagesIn(user)).toEqual([]);
  });

  it("два ответа эксперта подряд: оба в истории по порядку, без двух реплик собеседника подряд в запросе", async () => {
    const { user, person } = await midConversation();
    await expertSays(person.id, "Первый ответ эксперта");
    kit.clock.advance(1000);
    await expertSays(person.id, "Второй ответ эксперта");

    await say(user, "Спасибо, понял");
    const prompt = kit.calls.at(-1)!.options.prompt;
    const seen = userTexts(kit.calls.at(-1)!);
    expect(seen.indexOf("Первый ответ эксперта")).toBeGreaterThan(-1);
    expect(seen.indexOf("Второй ответ эксперта")).toBeGreaterThan(seen.indexOf("Первый ответ эксперта"));
    expect(seen.indexOf("Спасибо, понял")).toBeGreaterThan(seen.indexOf("Второй ответ эксперта"));
    // Реплики — до хвоста хода: строка «Имя в профиле мессенджера» идёт после слов человека отдельным сообщением SDK
    const replicas = prompt.filter((message) => message.role !== "system");
    const lastWords = replicas.findLastIndex((message) => JSON.stringify(message.content).includes("Спасибо, понял"));
    const roles = replicas.slice(0, lastWords + 1).map((message) => message.role);
    expect(roles.filter((role, index) => role === roles[index - 1])).toEqual([]);
    expect(await expertMessagesIn(user)).toEqual(["Первый ответ эксперта", "Второй ответ эксперта"]);
  });

  it("в карточке человека ответ эксперта — реплика эксперта, а не слова человека", async () => {
    const user = newUser();
    const lead = await kit.publish();
    await say(user, `/start ${lead.code}`, lead.code);
    await say(user, "Расскажите про курс");
    const person = (await kit.personOf(user))!;
    await replyFromInbox(replyDeps(), { personId: person.id, text: "Созвон в четверг в 15:00", seenUpTo: new Date(), requestId: randomUUID() });
    await kit.drain();
    kit.clock.advance(STAFF_PAUSE_MS);
    await say(user, "Отлично, жду");

    const card = await loadPersonCard({ db: kit.db, chatStorage: kit.chatStorage }, person.id);
    const lines = card!.passages[0]!.messages.map((message) => [message.role, message.text]);
    expect(lines).toContainEqual(["expert", "Созвон в четверг в 15:00"]);
    expect(lines).toContainEqual(["user", "Отлично, жду"]);
    expect(lines.filter(([role, text]) => role === "user" && /Созвон|Эксперт/.test(text ?? ""))).toEqual([]);
  });
});

describe("откуда бы ни пришло сообщение с маршрутом «входящие»", () => {
  it("режим «ничего»: сообщение без кода человеку без прохождений", async () => {
    const [bot] = await kit.db.select().from(bots).where(eq(bots.id, kit.bot.id));
    expect(bot!.noCodeMode).toBe("nothing");
    const user = newUser();
    await say(user, "Здравствуйте, я по объявлению");

    expect(await threadOf(user)).toMatchObject({ unansweredCount: 1 });
    const person = await kit.personOf(user);
    const listed = (await listUnansweredThreads(kit.db)).find((thread) => thread.personId === person!.id);
    expect(listed).toMatchObject({ lastText: "Здравствуйте, я по объявлению" });
  });

  it("любая запись входящего с маршрутом «входящие» попадает в счётчик", async () => {
    const user = newUser();
    await finishedPassage(user);
    const person = await kit.personOf(user);
    // Так пишет любой будущий маршрут: строка входящего с `route = inbox`
    await kit.db.insert(inboundMessages).values({
      botId: kit.bot.id,
      kind: "message",
      dedupeKey: `direct:${randomUUID()}`,
      externalUserId: user,
      text: "Записано напрямую",
      personId: person!.id,
      route: "inbox",
      processedAt: kit.clock.now(),
    });
    expect(await threadOf(user)).toMatchObject({ unansweredCount: 1 });
  });

  it("разговор, переданный эксперту после упавшего хода, — с причиной", async () => {
    const user = newUser();
    const lead = await kit.publish();
    await say(user, `/start ${lead.code}`, lead.code);
    kit.reply = (call) => {
      if (call.lastUserText.includes("Длинный")) throw new Error("This model's maximum context length is 1000 tokens. However, your messages resulted in 5000 tokens");
      return defaultConsultantReply(call);
    };
    await say(user, "Длинный рассказ о себе");

    expect(await threadOf(user)).toMatchObject({ unansweredCount: 1 });
    const person = await kit.personOf(user);
    const listed = (await listUnansweredThreads(kit.db)).find((thread) => thread.personId === person!.id);
    expect(listed!.handoverReason).toMatch(/слишком длинным/);
    const thread = await loadInboxThread(kit.db, person!.id);
    expect(thread!.handoverReason).toMatch(/слишком длинным/);

    // Эксперт ответил — причина больше не висит
    await replyFromInbox(replyDeps(), { personId: person!.id, text: "Отвечу сам", seenUpTo: thread!.lastMessageAt!, requestId: randomUUID() });
    expect((await loadInboxThread(kit.db, person!.id))!.handoverReason).toBeNull();
  });
});
