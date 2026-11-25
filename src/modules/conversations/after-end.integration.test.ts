// Человек вернулся после конца разговора (согласием или сроком программы), а настройка лидмагнита — «Агент продолжит
// разговор»: тот же чат, тот же итог, ответ по правилу «после конца». Передать вопрос эксперту — «Входящие» с пометкой
// и уведомление в бот эксперта.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import {
  BASE_SETTINGS,
  createLiveDialogKit,
  DEFAULT_CONSULTANT_REPLY,
  defaultConsultantReply,
  type LiveDialogKit,
} from "../../../tests/integration/live-dialog-kit";
import { startCallNoticeConnect } from "../booking/notices";
import { outboundMessages } from "../channels/schema";
import { FINISHED_BEFORE } from "../consultant/tools";
import { listUnansweredThreads } from "../inbox/inbox";
import { leadMagnetReport, newProgramSettings, type LeadMagnetSettings } from "../lead-magnets";
import { updateSettings } from "../platform/settings";
import { AUTOREPLY_TEXT } from "./router";
import { passages } from "./schema";

const DAY = 24 * 60 * 60_000;
const EXPERT = "expert-1";
const GUIDANCE = "Спроси, получилось ли применить разбор, и предложи созвон только по просьбе";
const FAREWELL = BASE_SETTINGS.farewellMessage!;

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { dailyLimitUsd: "1000", monthlyBudgetUsd: null });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database, { pricePerMillion: 0 });
  person = `user-${randomUUID().slice(0, 8)}`;
  kit.reply = currentTurnOnly(defaultConsultantReply);
});

type Script = LiveDialogKit["reply"];

/**
 * После finish_dialog прощание отправляет приложение, а история модели кончается результатом инструмента. Новое сообщение
 * человека после конца тестовая модель приняла бы за шаг после инструмента в том же ходе. Результат, уже виденный
 * моделью, — из прошлого хода: сценарий видит его как обычный новый ход.
 */
function currentTurnOnly(script: Script): Script {
  const seen = new Set<string>();
  return (call) => {
    const last = call.options.prompt.filter((message) => message.role !== "system" && message.role !== "user").at(-1);
    const result = last?.role === "tool" ? last.content.at(-1) : undefined;
    const id = result && "toolCallId" in result ? result.toolCallId : undefined;
    if (call.lastToolResult === undefined || id === undefined) return script(call);
    if (seen.has(id)) {
      // Вопрос — только сообщения человека после результата, без реплики прошлого хода
      const prompt = call.options.prompt.filter((message) => message.role !== "system");
      const trailing = prompt.slice(prompt.findLastIndex((message) => message.role !== "user") + 1);
      const lastUserText = trailing.map((message) => (message.role === "user" ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n") : "")).join("\n");
      return script({ ...call, lastToolResult: undefined, lastUserText });
    }
    seen.add(id);
    return script(call);
  };
}

const continueSettings = (extra: Partial<LeadMagnetSettings> = {}): Partial<LeadMagnetSettings> => ({
  ...BASE_SETTINGS,
  returnAfterProgram: "continue",
  returnGuidance: GUIDANCE,
  ...extra,
});

async function start(code: string) {
  await kit.send(person, `/start ${code}`, { startCode: code });
  await kit.drain();
}

async function say(text: string) {
  await kit.send(person, text);
  await kit.drain();
}

/** Разговор закончен согласием: «готов» — finish_dialog с исходом agreed, прощание ушло. */
async function finishAgreed(settings: Partial<LeadMagnetSettings> = continueSettings()) {
  const lead = await kit.publish(settings);
  await start(lead.code);
  await say("Рассказываю про свою задачу");
  await say("Я готов");
  const [ended] = await kit.passagesOf(person);
  expect(ended).toMatchObject({ status: "completed", summary: expect.objectContaining({ outcome: "agreed" }) });
  expect(kit.textsTo(person).at(-1)).toContain(FAREWELL);
  return { lead, ended: ended! };
}

const lastInbound = async () => (await kit.inboundOf(person)).at(-1);

describe("«Агент продолжит разговор»: человек вернулся после согласия", () => {
  it("без кода через 10 дней — тот же разговор, итог и статус прежние, ответ без прощания; агент видит прошлое и указание эксперта", async () => {
    const { ended } = await finishAgreed();
    kit.clock.advance(10 * DAY);
    const sent = kit.textsTo(person).length;
    const calls = kit.consultantCalls().length;
    const returnedAt = kit.clock.now().getTime();

    await say("Здравствуйте, у меня ещё вопрос");

    const rows = await kit.passagesOf(person);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ended.id, chatId: ended.chatId, status: "completed", endedAt: ended.endedAt, summary: ended.summary });
    // Отметка — в момент сообщения; дальше часы набора уже ушли вперёд на окно тишины
    expect(rows[0]!.returnedAfterEndAt?.getTime()).toBeGreaterThanOrEqual(returnedAt);
    expect(rows[0]!.returnedAfterEndAt!.getTime()).toBeLessThanOrEqual(kit.clock.now().getTime());
    expect(await lastInbound()).toMatchObject({ route: "passage", passageId: ended.id, autoreply: false });
    expect(kit.textsTo(person).slice(sent)).toEqual([DEFAULT_CONSULTANT_REPLY]);

    const [call] = kit.consultantCalls().slice(calls);
    expect(call!.lastUserText).toContain("Здравствуйте, у меня ещё вопрос");
    // Правило «после конца» и указание эксперта — в постоянной инструкции чата (afterEndRules), вместо встроенного SDK
    expect(call!.system).toContain(GUIDANCE);
    expect(call!.system).toContain("hand_to_expert");
    expect(call!.system).not.toContain("Программа разговора закончилась");
    expect(call!.lastUserText).not.toContain(GUIDANCE);
    // В хвосте хода — когда и чем кончился разговор и сколько длилась пауза
    expect(call!.lastUserText).toContain("Разговор закончился");
    expect(call!.lastUserText).toContain("Пауза: человек не писал");
    expect(call!.lastUserText).not.toContain("finish_dialog");
    expect(JSON.stringify(call!.options.prompt)).toContain("Рассказываю про свою задачу");
    expect(call!.toolNames).toContain("hand_to_expert");
  });

  it("следующие сообщения тоже идут агенту; finish_dialog после конца не меняет итог и не шлёт прощание снова", async () => {
    // Модель отвечает сама, когда finish_dialog сказал, что разговор уже закончен
    kit.reply = currentTurnOnly((call) =>
      JSON.stringify(call.lastToolResult ?? null).includes(FINISHED_BEFORE) ? { text: DEFAULT_CONSULTANT_REPLY } : defaultConsultantReply(call),
    );
    const { ended } = await finishAgreed();
    kit.clock.advance(3 * DAY);
    await say("Снова здравствуйте");
    const sent = kit.textsTo(person).length;

    await say("Я готов, спасибо");

    const [row] = await kit.passagesOf(person);
    expect(row).toMatchObject({ status: "completed", summary: ended.summary });
    const texts = kit.textsTo(person).slice(sent);
    expect(texts).toEqual([DEFAULT_CONSULTANT_REPLY]);
    expect(await lastInbound()).toMatchObject({ route: "passage", passageId: ended.id });
  });

  it("по ссылке того же лидмагнита — тот же разговор, без нового прохождения и первого сообщения; агент знает, что человек снова открыл бота", async () => {
    const { lead, ended } = await finishAgreed();
    kit.clock.advance(30 * DAY);
    const sent = kit.textsTo(person).length;
    const calls = kit.consultantCalls().length;

    await start(lead.code);

    expect(await kit.passagesOf(person)).toEqual([expect.objectContaining({ id: ended.id, status: "completed" })]);
    expect(await lastInbound()).toMatchObject({ route: "passage", passageId: ended.id, startedPassage: false });
    expect(kit.textsTo(person).slice(sent)).toEqual([DEFAULT_CONSULTANT_REPLY]);
    const [call] = kit.consultantCalls().slice(calls);
    expect(call!.lastUserText).not.toContain(`/start ${lead.code}`);
    expect(call!.lastUserText).toContain("по ссылке");
  });

  it("отчёт: вернулся после конца — один раз на возвращение, сообщения подряд не считаются; пауза в идущем разговоре — отдельно", async () => {
    const { lead } = await finishAgreed();
    kit.clock.advance(10 * DAY);
    await say("Здравствуйте, у меня ещё вопрос");
    await say("И ещё один");
    expect((await leadMagnetReport(kit.db, lead.leadMagnetId)).returns).toEqual({ afterPause: 0, afterEnd: 1 });

    // Другой человек: молчал меньше «Напоминать» (у прежнего сценария — до «не завершил», 3 дня) — не возврат, дольше — возврат
    person = `user-${randomUUID().slice(0, 8)}`;
    await start(lead.code);
    await say("Привет");
    kit.clock.advance(2 * DAY);
    await say("Я тут");
    expect((await leadMagnetReport(kit.db, lead.leadMagnetId)).returns).toEqual({ afterPause: 0, afterEnd: 1 });
    kit.clock.advance(4 * DAY);
    await say("Снова я");
    expect((await leadMagnetReport(kit.db, lead.leadMagnetId)).returns).toEqual({ afterPause: 1, afterEnd: 1 });
  });

  it("после конца ушла рассылка — ответ на неё во «Входящие», как раньше", async () => {
    const { ended } = await finishAgreed();
    kit.clock.advance(DAY);
    await database.db.insert(outboundMessages).values({
      botId: kit.bot.id,
      personId: ended.personId,
      kind: "mailing",
      mailingId: randomUUID(),
      text: "Новый поток курса",
      status: "sent",
      sentAt: kit.clock.now(),
      idempotencyKey: `mailing-${randomUUID()}`,
    });
    kit.clock.advance(DAY);
    const calls = kit.consultantCalls().length;

    await say("Интересно, расскажите подробнее");

    expect(await lastInbound()).toMatchObject({ route: "inbox", autoreply: true });
    expect(kit.consultantCalls()).toHaveLength(calls);
    expect((await kit.passagesOf(person))[0]!.returnedAfterEndAt).toBeNull();
  });

  it("после конца эксперт ответил из «Входящих» — следующее сообщение эксперту, не агенту", async () => {
    const { ended } = await finishAgreed();
    kit.clock.advance(DAY);
    await database.db.insert(outboundMessages).values({
      botId: kit.bot.id,
      personId: ended.personId,
      kind: "manual_reply",
      text: "Добрый день! Я на связи",
      status: "sent",
      sentAt: kit.clock.now(),
      idempotencyKey: `manual-${randomUUID()}`,
    });
    kit.clock.advance(DAY);
    const calls = kit.consultantCalls().length;

    await say("Спасибо, а можно подробнее?");

    expect((await lastInbound())!.route).toBe("inbox");
    expect(kit.consultantCalls()).toHaveLength(calls);
  });

  it("голый /start после конца — не реплика: как раньше, без агента", async () => {
    await finishAgreed();
    kit.clock.advance(DAY);
    const calls = kit.consultantCalls().length;

    await say("/start");

    expect((await lastInbound())!.route).not.toBe("passage");
    expect(kit.consultantCalls()).toHaveLength(calls);
  });
});

describe("«Передать мне во „Входящие“» — как раньше", () => {
  it("без кода после согласия — «Входящие» с автоответом, агент не зовётся; ссылка — новое прохождение", async () => {
    const { lead } = await finishAgreed({ ...BASE_SETTINGS, returnAfterProgram: "inbox" });
    kit.clock.advance(DAY);
    const sent = kit.textsTo(person).length;
    const calls = kit.consultantCalls().length;

    await say("Ещё вопрос");
    expect(kit.textsTo(person).slice(sent)).toEqual([AUTOREPLY_TEXT]);
    expect(kit.consultantCalls()).toHaveLength(calls);

    await start(lead.code);
    expect((await kit.passagesOf(person)).map((row) => row.status)).toEqual(["completed", "active"]);
  });
});

describe("«Агент продолжит разговор»: программа закончилась по сроку", () => {
  it("без кода и по ссылке — тот же разговор, статус «срок вышел» не меняется", async () => {
    const lead = await kit.publish(continueSettings({ program: newProgramSettings(3) }));
    await start(lead.code);
    await say("Привет");
    const [passage] = await kit.passagesOf(person);
    // Срок программы вышел: прохождение закрыто сроком, ход сценария окончен
    await database.db.update(passages).set({ status: "term_ended", endedAt: kit.clock.now(), nextReminderAt: null }).where(eq(passages.id, passage!.id));
    await kit.dialog.flow.end({ ownerId: passage!.personId, chatId: passage!.chatId, reason: "deadline" });
    await kit.drain();
    expect((await kit.passagesOf(person))[0]!.status).toBe("term_ended");
    kit.clock.advance(60 * DAY);
    const sent = kit.textsTo(person).length;

    await say("Я вернулся, помогите ещё");
    expect(kit.textsTo(person).slice(sent)).toEqual([DEFAULT_CONSULTANT_REPLY]);
    expect(await lastInbound()).toMatchObject({ route: "passage", passageId: passage!.id });

    await start(lead.code);
    const rows = await kit.passagesOf(person);
    expect(rows).toEqual([expect.objectContaining({ id: passage!.id, status: "term_ended" })]);
    expect(kit.textsTo(person).slice(sent)).toEqual([DEFAULT_CONSULTANT_REPLY, DEFAULT_CONSULTANT_REPLY]);
  });
});

describe("передача вопроса эксперту после конца", () => {
  const HANDOVER = "Хочет обсудить с экспертом групповую программу для своей команды";

  async function connectExpert() {
    const { link } = await startCallNoticeConnect(kit.db, kit.dialogAdapters, kit.bot.id);
    const code = new URL(link).searchParams.get("start")!;
    await kit.send(EXPERT, `/start ${code}`, { startCode: code });
    await kit.runDue();
  }

  const handingOver = currentTurnOnly((call) => {
    if (call.lastToolResult === undefined && call.lastUserText.includes("свяжите с экспертом"))
      return { toolCalls: [{ toolName: "hand_to_expert", input: { summary: HANDOVER } }] };
    if (call.lastToolResult !== undefined && call.lastUserText.includes("свяжите с экспертом")) return { text: "Передал ваш вопрос эксперту." };
    return defaultConsultantReply(call);
  });

  it("с согласия человека — «Входящие» с пометкой и выжимкой, уведомление в бот эксперта; разговор продолжается", async () => {
    await connectExpert();
    kit.reply = handingOver;
    const { ended } = await finishAgreed();
    kit.clock.advance(5 * DAY);

    await say("Да, свяжите с экспертом, пожалуйста");

    expect(kit.textsTo(person).at(-1)).toBe("Передал ваш вопрос эксперту.");
    const [row] = await kit.passagesOf(person);
    expect(row).toMatchObject({ id: ended.id, status: "completed", summary: ended.summary });
    expect(row!.handedToExpertAt?.getTime()).toBe(kit.clock.now().getTime());
    expect(row!.handoverReason).toContain(HANDOVER);

    const thread = (await listUnansweredThreads(database.db)).find((item) => item.personId === ended.personId);
    expect(thread).toBeDefined();
    expect(thread!.handoverReason).toContain(HANDOVER);

    const notice = kit.textsTo(EXPERT).at(-1)!;
    expect(notice).toContain(HANDOVER);
    expect(notice).toContain(`Человек ${person}`);

    // Обычное следующее сообщение — снова агенту, без нового уведомления
    const noticesBefore = kit.textsTo(EXPERT).length;
    await say("Ещё вопрос по теме");
    expect(kit.textsTo(EXPERT)).toHaveLength(noticesBefore);
    expect((await lastInbound())!.route).toBe("passage");
  });

  it("до конца разговора инструмент отказывает: ни пометки, ни уведомления", async () => {
    await connectExpert();
    kit.reply = handingOver;
    const lead = await kit.publish(continueSettings());
    await start(lead.code);
    const noticesBefore = kit.textsTo(EXPERT).length;
    let result: unknown;
    const script = kit.reply;
    kit.reply = (call) => {
      if (call.lastToolResult !== undefined) result = call.lastToolResult;
      return script(call);
    };

    await say("Сразу свяжите с экспертом");

    expect(JSON.stringify(result)).toContain("после конца");
    const [row] = await kit.passagesOf(person);
    expect(row).toMatchObject({ status: "active", handedToExpertAt: null });
    expect(kit.textsTo(EXPERT)).toHaveLength(noticesBefore);
  });

  it("у лидмагнита «Передать мне во „Входящие“» инструмента нет", async () => {
    const lead = await kit.publish({ ...BASE_SETTINGS, returnAfterProgram: "inbox" });
    await start(lead.code);
    await say("Привет");
    expect(kit.consultantCalls().at(-1)!.toolNames).not.toContain("hand_to_expert");
  });
});
