import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, DEFAULT_CONSULTANT_REPLY, KIT_CIPHER, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { callBookings } from "../booking/schema";
import { leadMagnetBots } from "../channels/schema";
import { inboxThreads } from "../inbox/schema";
import type { LeadMagnetSettings } from "../lead-magnets";
import { people } from "../people/schema";
import { passages } from "../conversations/schema";
import {
  findWebChatVisitor,
  openWebChat,
  readWebChat,
  sendWebChatMessage,
  webChatMessengerHandoff,
  type WebChatDependencies,
} from "../web-chat";
import { createSenlerApi } from "../senler/api";
import { FakeSenlerApi } from "../senler/fake-senler-api";
import { createSenlerSettings } from "../senler";
import { MESSENGER_HANDOFF_USAGE_SOURCE, offerMessengerHandoff } from "./handoff";
import { MESSENGER_HANDOFF_EVENT } from "./setting";
import { messengerHandoffs } from "./schema";

const OFFER_TOOL = "offer_messenger";
const CONTINUATION = "Продолжаем здесь: на чём мы остановились, то и делаем дальше.";
/** Ответ консультанта в веб-чате после показа кнопок: в мессенджере он не к месту. */
const BUTTONS_REPLY = "Нажмите кнопку мессенджера ниже — продолжим там.";

const HANDOFF: Partial<LeadMagnetSettings> = {
  messengerHandoff: { enabled: true, when: "Когда человек согласился пройти программу", how: "", channels: ["telegram"] },
};

let database: TestDatabase;
let kit: LiveDialogKit;
let deps: WebChatDependencies;
let address: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  deps = { db: kit.db, queue: kit.queue, clock: kit.clock, cipher: KIT_CIPHER, adapters: kit.dialogAdapters };
  address = `test-${randomUUID()}`;
  // Модель предлагает мессенджер, когда человек просит, — и только если инструмент ей дан
  kit.reply = webReply;
});

/** Модель предлагает мессенджер, когда человек просит, — и только если инструмент ей дан; после кнопок — объяснение. */
function webReply(call: Parameters<LiveDialogKit["reply"]>[0]) {
  if (call.toolNames.includes(OFFER_TOOL) && call.lastUserText.includes("в мессенджер"))
    return call.lastToolResult === undefined ? { toolCalls: [{ toolName: OFFER_TOOL, input: {} }] } : { text: BUTTONS_REPLY };
  return { text: DEFAULT_CONSULTANT_REPLY };
}

async function open(code: string) {
  const opened = await openWebChat(deps, { token: null, code, address });
  if (opened.kind !== "opened") throw new Error(`Чат не открылся: ${opened.kind}`);
  await kit.drain();
  return opened.token;
}

async function visitorOf(token: string) {
  const visitor = await findWebChatVisitor(kit.db, token);
  if (!visitor) throw new Error("Посетитель не найден");
  return visitor;
}

async function say(token: string, text: string) {
  const result = await sendWebChatMessage(deps, await visitorOf(token), { text, clientId: randomUUID(), address });
  await kit.drain();
  return result;
}

async function handoffState(token: string, code: string) {
  return webChatMessengerHandoff(kit.db, kit.dialogAdapters, await visitorOf(token), code);
}

async function webPersonId(token: string) {
  const visitor = await visitorOf(token);
  const [row] = await kit.db.select({ id: people.id }).from(people).where(eq(people.externalUserId, visitor.id));
  if (!row) throw new Error("Человек веб-чата не найден");
  return row.id;
}

/** Код перехода из кнопки мессенджера: `https://fake.test/<бот>?start=<код>`. */
function startCodeOf(url: string): string {
  const code = new URL(url).searchParams.get("start");
  if (!code) throw new Error(`В кнопке нет кода: ${url}`);
  return code;
}

/** Веб-чат, разговор, модель показала кнопки. Возвращает токен посетителя и код перехода. */
async function offered(settings: Partial<LeadMagnetSettings> = HANDOFF, adjustFlow?: (flow: AgentFlow) => AgentFlow) {
  const lead = await kit.publish(settings, adjustFlow);
  const token = await open(lead.code);
  await say(token, "Я дизайнер, хочу собрать приложение");
  await say(token, "Давайте продолжим в мессенджер");
  const state = await handoffState(token, lead.code);
  if (state?.state !== "offered") throw new Error(`Кнопок нет: ${JSON.stringify(state)}`);
  return { lead, token, code: startCodeOf(state.buttons[0]!.url), buttons: state.buttons };
}

async function pressStart(userId: string, code: string) {
  await kit.send(userId, `/start ${code}`, { startCode: code });
  await kit.drain();
}

describe("переход из веб-чата в мессенджер", () => {
  it("модель показывает кнопки мессенджеров, где опубликован лидмагнит; поле ввода веб-чата закрыто", async () => {
    const { lead, token, buttons, code } = await offered();
    expect(buttons).toEqual([{ channel: "telegram", title: "Telegram", url: `https://fake.test/${kit.bot.username}?start=${code}` }]);
    expect(code).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(code).not.toContain(lead.code);
    const sent = await say(token, "Ещё вопрос");
    expect(sent).toMatchObject({ ok: false, reason: "messenger" });
  });

  it("«Старт» по коду: тот же человек и тот же разговор продолжаются в мессенджере, первым пишет агент без знакомства заново", async () => {
    const { token, code, lead } = await offered();
    const personId = await webPersonId(token);
    const [passageBefore] = await kit.db.select().from(passages).where(eq(passages.personId, personId));
    const feedBefore = await readWebChat(kit.db, kit.clock, await visitorOf(token));
    kit.reply = () => ({ text: CONTINUATION });
    const callsBefore = kit.consultantCalls().length;

    await pressStart("tg-anna", code);

    const person = await kit.personOf("tg-anna");
    expect(person?.id).toBe(personId);
    expect(person).toMatchObject({ channel: "telegram", botId: kit.bot.id, externalUserId: "tg-anna" });
    expect(await kit.db.select().from(people).where(eq(people.externalUserId, "tg-anna"))).toHaveLength(1);
    const after = await kit.passagesOf("tg-anna");
    expect(after.map((row) => row.id)).toEqual([passageBefore!.id]);
    expect(after[0]).toMatchObject({ status: "active", leadMagnetId: lead.leadMagnetId });
    // Не первое сообщение лидмагнита, а продолжение от агента
    expect(kit.textsTo("tg-anna")).toEqual([CONTINUATION]);
    const continuation = kit.consultantCalls().slice(callsBefore);
    expect(continuation).toHaveLength(1);
    expect(continuation[0]!.lastUserText).toContain("Telegram");
    expect(continuation[0]!.toolNames).not.toContain(OFFER_TOOL);

    const [row] = await kit.db.select().from(messengerHandoffs).where(eq(messengerHandoffs.code, code));
    expect(row?.takenAt).not.toBeNull();
    expect(row?.takenBotId).toBe(kit.bot.id);
    // Веб-чат: история на месте, ответы мессенджера туда не идут, вместо поля — где продолжается разговор
    const feedAfter = await readWebChat(kit.db, kit.clock, await visitorOf(token));
    expect(feedAfter.map((item) => item.text)).toEqual(feedBefore.map((item) => item.text));
    expect(await handoffState(token, lead.code)).toEqual({
      state: "taken",
      channel: "telegram",
      title: "Telegram",
      url: `https://fake.test/${kit.bot.username}?start=${code}`,
    });
    // Веб-чат открыт снова (с поясом браузера, а у человека пояса нет): ни нового веб-человека, ни нового разговора
    await kit.db.update(people).set({ timeZone: null }).where(eq(people.id, personId));
    const reopened = await openWebChat(deps, { token, code: lead.code, address, timeZone: "Europe/Moscow" });
    expect(reopened.kind).toBe("opened");
    await kit.drain();
    expect(await kit.db.select().from(people).where(eq(people.externalUserId, (await visitorOf(token)).id))).toHaveLength(0);
    expect((await kit.passagesOf("tg-anna")).map((row) => row.id)).toEqual([passageBefore!.id]);

    // Дальше разговор идёт в мессенджере тем же агентом
    kit.reply = () => ({ text: "Отлично, идём дальше." });
    await kit.send("tg-anna", "Привет, я тут");
    await kit.drain();
    expect(kit.textsTo("tg-anna").at(-1)).toBe("Отлично, идём дальше.");
    expect((await kit.passagesOf("tg-anna")).map((row) => row.id)).toEqual([passageBefore!.id]);
  });

  it("повторный «Старт» по тому же коду не дублирует продолжение и не начинает разговор заново", async () => {
    const { code } = await offered();
    kit.reply = () => ({ text: CONTINUATION });
    await pressStart("tg-boris", code);
    const calls = kit.consultantCalls().length;
    await pressStart("tg-boris", code);
    expect(kit.consultantCalls()).toHaveLength(calls);
    expect(kit.textsTo("tg-boris")).toEqual([CONTINUATION, CONTINUATION]);
    expect(await kit.passagesOf("tg-boris")).toHaveLength(1);
  });

  it("код уже взят другим человеком — чужой «Старт» начинает лидмагнит с начала, как обычная ссылка", async () => {
    const { code, token } = await offered();
    const personId = await webPersonId(token);
    kit.reply = () => ({ text: CONTINUATION });
    await pressStart("tg-vera", code);
    await pressStart("tg-stranger", code);
    const stranger = await kit.personOf("tg-stranger");
    expect(stranger?.id).not.toBe(personId);
    expect(kit.textsTo("tg-stranger")).toEqual(["Привет! Чем вы занимаетесь?"]);
    expect(await kit.passagesOf("tg-stranger")).toHaveLength(1);
  });

  it("человек уже писал этому боту: одна запись человека, его прежний разговор закрыт и виден в истории, во «Входящих» одна строка", async () => {
    const other = await kit.publish({ name: "Прежний лидмагнит" });
    await pressStart("tg-gleb", other.code);
    await kit.send("tg-gleb", "Старое сообщение");
    await kit.drain();
    const oldPerson = await kit.personOf("tg-gleb");
    const [oldPassage] = await kit.passagesOf("tg-gleb");
    // Запись на созвон, сделанная в мессенджере, — тоже переходит к общему человеку
    const [booking] = await kit.db
      .insert(callBookings)
      .values({ startsAt: new Date("2030-01-01T10:00:00Z"), endsAt: new Date("2030-01-01T10:30:00Z"), personId: oldPerson!.id })
      .returning();

    const { code, token } = await offered();
    const personId = await webPersonId(token);
    kit.reply = () => ({ text: CONTINUATION });
    await pressStart("tg-gleb", code);

    const rows = await kit.db.select().from(people).where(eq(people.externalUserId, "tg-gleb"));
    expect(rows.map((row) => row.id)).toEqual([personId]);
    const all = await kit.passagesOf("tg-gleb");
    expect(all.map((row) => row.id)).toContain(oldPassage!.id);
    const old = all.find((row) => row.id === oldPassage!.id)!;
    expect(old.status).not.toBe("active");
    // Чат SDK прежнего разговора остаётся за прежним владельцем
    expect(old.chatOwnerId).toBe(oldPerson!.id);
    expect(all.filter((row) => row.status === "active")).toHaveLength(1);
    expect(kit.textsTo("tg-gleb").at(-1)).toBe(CONTINUATION);
    const threads = await kit.db.select().from(inboxThreads).where(eq(inboxThreads.personId, oldPerson!.id));
    expect(threads).toHaveLength(0);
    const [movedBooking] = await kit.db.select().from(callBookings).where(eq(callBookings.id, booking!.id));
    expect(movedBooking!.personId).toBe(personId);
  });

  it("инструмент — только в веб-чате и только когда переход включён", async () => {
    const off = await kit.publish({});
    const offToken = await open(off.code);
    await say(offToken, "Давайте в мессенджер");
    expect(kit.consultantCalls().at(-1)!.toolNames).not.toContain(OFFER_TOOL);

    const on = await kit.publish(HANDOFF);
    const onToken = await open(on.code);
    await say(onToken, "Расскажу о себе");
    const webCall = kit.consultantCalls().at(-1)!;
    expect(webCall.toolNames).toContain(OFFER_TOOL);
    expect(JSON.stringify(webCall.options.tools)).toContain("Когда человек согласился пройти программу");
    // Условие — в постоянной инструкции, счёт сообщений — в хвосте хода: модель не считает сама
    expect(webCall.system).toContain("Когда человек согласился пройти программу");
    expect(webCall.lastUserText).toContain("Человек прислал в этом разговоре");

    await pressStart("tg-dina", on.code);
    await kit.send("tg-dina", "Привет из телеграма");
    await kit.drain();
    expect(kit.consultantCalls().at(-1)!.toolNames).not.toContain(OFFER_TOOL);
    expect(kit.consultantCalls().at(-1)!.lastUserText).not.toContain("Человек прислал в этом разговоре");
  });

  it("событие сценария «перешёл в мессенджер» переводит разговор в следующую ноду", async () => {
    const STAGES = [
      { id: "start", name: "Знакомство", instruction: "Узнай задачу.", transitionCondition: "", startDay: null, isSale: false },
      { id: "messenger", name: "В мессенджере", instruction: "Продолжай в мессенджере.", transitionCondition: "", startDay: null, isSale: false },
    ];
    const withEvent = (flow: AgentFlow): AgentFlow => ({
      ...flow,
      states: flow.states.map((state) =>
        state.id === "start"
          ? { ...state, exits: [...state.exits, { id: "start_messenger", when: { type: "event", event: "app", name: MESSENGER_HANDOFF_EVENT }, to: "messenger" }] }
          : state,
      ) as AgentFlow["states"],
    });
    const { code, token } = await offered({ ...HANDOFF, stages: STAGES }, withEvent);
    const personId = await webPersonId(token);
    const [before] = await kit.db.select().from(passages).where(eq(passages.personId, personId));
    expect(before?.currentStageId).not.toBe("messenger");
    kit.reply = () => ({ text: CONTINUATION });
    await pressStart("tg-egor", code);
    await kit.dialog.flow.settled();
    const [after] = await kit.db.select().from(passages).where(and(eq(passages.personId, personId), eq(passages.id, before!.id)));
    expect(after?.currentStageId).toBe("messenger");
  });

  it("ВКонтакте с Senler: перешедший из веб-чата попадает в группу Senler, как пришедший по ссылке", async () => {
    const senler = new FakeSenlerApi();
    kit = await createLiveDialogKit(database, { botChannel: "vk", senler: createSenlerApi({ fetch: senler.fetch, timeoutMs: 200 }) });
    deps = { db: kit.db, queue: kit.queue, clock: kit.clock, cipher: KIT_CIPHER, adapters: kit.dialogAdapters };
    kit.reply = webReply;
    senler.keys.set("senler-key", kit.bot.externalId);
    const settings = createSenlerSettings({ db: kit.db, cipher: KIT_CIPHER, api: createSenlerApi({ fetch: senler.fetch }) });
    expect(await settings.connect(kit.bot.id, "senler-key")).toEqual({ ok: true });
    expect(await settings.saveGroups(kit.bot.id, { defaultGroupId: "101", leadMagnetGroups: {} })).toEqual({ ok: true });

    const { code } = await offered({ messengerHandoff: { ...HANDOFF.messengerHandoff!, channels: ["vk"] } });
    kit.reply = () => ({ text: CONTINUATION });
    await pressStart("100500", code);

    expect(kit.textsTo("100500")).toEqual([CONTINUATION]);
    expect(senler.callsTo("subscribers/add")).toHaveLength(1);
    expect(senler.callsTo("subscribers/add")[0]!.body).toMatchObject({ vk_user_id: 100500, subscription_id: 101 });
  });

  it("в мессенджер не уходят веб-сообщения про кнопки: ни повтором «Старта» до продолжения, ни запасным текстом без хода", async () => {
    const { code, token } = await offered();
    expect((await readWebChat(kit.db, kit.clock, await visitorOf(token))).map((item) => item.text)).toContain(BUTTONS_REPLY);

    // Второй «Старт» пришёл раньше, чем агент написал продолжение
    kit.reply = () => ({ text: CONTINUATION });
    await kit.send("tg-zoya", `/start ${code}`, { startCode: code });
    await kit.runDue("messenger-handoff-continue");
    await kit.send("tg-zoya", `/start ${code}`, { startCode: code, dedupeKey: "second-start" });
    await kit.runDue("messenger-handoff-continue");
    await kit.drain();
    expect(kit.textsTo("tg-zoya")).toEqual([CONTINUATION]);

    // Хода не было (модель промолчала): человек видит, на чём остановились до кнопок
    kit.reply = webReply;
    const second = await offered();
    kit.reply = () => ({ text: "" });
    await pressStart("tg-yan", second.code);
    expect(kit.textsTo("tg-yan")).not.toContain(BUTTONS_REPLY);
    expect(kit.textsTo("tg-yan")).toEqual([DEFAULT_CONSULTANT_REPLY]);
  });

  it("кнопки появляются только вместе с объяснением агента: пока ответ хода не дошёл, поле ввода открыто", async () => {
    const lead = await kit.publish(HANDOFF);
    const token = await open(lead.code);
    await say(token, "Я дизайнер");
    const [passage] = await kit.db.select().from(passages).where(eq(passages.personId, await webPersonId(token)));
    // Инструмент сработал посреди хода, ответ ещё не отправлен
    const result = await offerMessengerHandoff(kit.db, kit.dialogAdapters, { ownerId: passage!.personId, chatId: passage!.chatId });
    expect(result.ok).toBe(true);
    expect(await handoffState(token, lead.code)).toBeNull();
    // Ответ дошёл — кнопки на месте поля
    await say(token, "Хорошо");
    expect((await handoffState(token, lead.code))?.state).toBe("offered");
  });

  it("кнопок не осталось (бот отвязали) — веб-чат не тупик: поле ввода открыто, разговор продолжается здесь", async () => {
    const { lead, token } = await offered();
    await kit.db.delete(leadMagnetBots).where(eq(leadMagnetBots.leadMagnetId, lead.leadMagnetId));
    expect(await handoffState(token, lead.code)).toBeNull();
    kit.reply = () => ({ text: "Отвечаю здесь." });
    const sent = await say(token, "Ещё вопрос");
    expect(sent.ok).toBe(true);
    const feed = await readWebChat(kit.db, kit.clock, await visitorOf(token));
    expect(feed.at(-1)?.text).toBe("Отвечаю здесь.");
  });

  it("после перехода веб-чат другого лидмагнита этого бота зовёт в мессенджер, второго человека нет", async () => {
    const { token, code } = await offered();
    const personId = await webPersonId(token);
    kit.reply = () => ({ text: CONTINUATION });
    await pressStart("tg-lev", code);
    const other = await kit.publish({ ...HANDOFF, name: "Другой лидмагнит" });

    await open(other.code);
    expect(await handoffState(token, other.code)).toEqual({
      state: "messenger",
      channel: "telegram",
      title: "Telegram",
      url: `https://fake.test/${kit.bot.username}?start=${other.code}`,
    });
    const sent = await say(token, "Здравствуйте");
    expect(sent).toMatchObject({ ok: false, reason: "messenger" });
    const visitorId = (await visitorOf(token)).id;
    expect(await kit.db.select().from(people).where(eq(people.externalUserId, visitorId))).toHaveLength(0);
    expect(await kit.passagesOf("tg-lev")).toHaveLength(1);

    // По кнопке человек приходит в бот по ссылке лидмагнита — тот же человек
    await pressStart("tg-lev", other.code);
    expect((await kit.personOf("tg-lev"))?.id).toBe(personId);
    expect((await kit.passagesOf("tg-lev")).map((row) => row.leadMagnetId)).toContain(other.leadMagnetId);
  });

  it("расход продолжения после перехода — своей строкой журнала, не «покупкой»", async () => {
    const { code, token } = await offered();
    const personId = await webPersonId(token);
    const [passage] = await kit.db.select().from(passages).where(eq(passages.personId, personId));
    kit.reply = () => ({ text: CONTINUATION });
    await pressStart("tg-mila", code);
    expect(await kit.chatStorage.sumUsage({ chatId: passage!.chatId, source: MESSENGER_HANDOFF_USAGE_SOURCE })).not.toHaveLength(0);
    expect(await kit.chatStorage.sumUsage({ chatId: passage!.chatId, source: "purchase_message" })).toHaveLength(0);
  });
});
