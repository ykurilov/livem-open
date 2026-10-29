// Сбои посреди работы: падение процесса между записью и задачей, падение хода после инструментов, долгий ход
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import {
  BASE_SETTINGS,
  DEFAULT_CONSULTANT_REPLY,
  createLiveDialogKit,
  outboundOf,
  type LiveDialogKit,
  providerOutage,
} from "../../../tests/integration/live-dialog-kit";
import { outboundMessages } from "../channels/schema";
import type { ScriptedCall, ScriptedReply } from "../platform/scripted-model";
import { getLeadMagnet, saveDraft } from "../lead-magnets";
import { publishLeadMagnet } from "../lead-magnets/publish";
import { BURST_QUIET_MS } from "../consultant/headless-turn";
import { inboundMessages, passages } from "./schema";

const MINUTE = 60_000;
const FAREWELL = BASE_SETTINGS.farewellMessage!;

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  person = `user-${randomUUID().slice(0, 8)}`;
});

afterEach(() => {
  vi.useRealTimers();
});

async function startPassage(settings: Parameters<LiveDialogKit["publish"]>[0] = {}) {
  const lead = await kit.publish(settings);
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  return (await kit.passagesOf(person))[0]!;
}

async function passageRow(id: string) {
  const [row] = await database.db.select().from(passages).where(eq(passages.id, id));
  return row!;
}

/** Ждёт условия по настоящему времени (таймеры `setInterval` в тестах подменены). */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Не дождались: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Модель отвечает по сценарию, но первый запрос после результата инструмента падает. После сбоя провайдера SDK
 * продолжает начатый ответ (просит модель не вызывать инструменты заново) — модель дописывает текст.
 */
function failingAfterTools(script: (call: ScriptedCall) => ScriptedReply, afterTools: string): (call: ScriptedCall) => ScriptedReply {
  let failed = false;
  return (call) => {
    if (call.lastToolResult !== undefined || failed) {
      if (!failed) {
        failed = true;
        throw providerOutage();
      }
      return { text: afterTools };
    }
    return script(call);
  };
}

describe("подмётчик", () => {
  it("добирает входящие без задачи старше минуты и исходящие, зависшие между записью и задачей", async () => {
    const lead = await kit.publish();
    const now = kit.clock.now().getTime();
    const [stale] = await database.db
      .insert(inboundMessages)
      .values({
        botId: kit.bot.id,
        kind: "message",
        dedupeKey: `stale-${person}`,
        externalUserId: person,
        text: `/start ${lead.code}`,
        startCode: lead.code,
        receivedAt: new Date(now - 2 * MINUTE),
      })
      .returning();
    // Свежая запись: её задача, может быть, ещё в пути
    await database.db.insert(inboundMessages).values({
      botId: kit.bot.id,
      kind: "message",
      dedupeKey: `fresh-${person}`,
      externalUserId: `other-${person}`,
      text: "Привет",
      receivedAt: new Date(now - 30_000),
    });

    await kit.dialog.sweepStuck();
    expect(kit.queue.history.filter((job) => job.name === "inbound-route").map((job) => job.payload)).toEqual([
      { inboundMessageId: stale!.id },
    ]);
    await kit.drain();
    expect(kit.textsTo(person)).toHaveLength(1);

    const personRow = await kit.personOf(person);
    const sweepAt = kit.clock.now().getTime();
    const [stuck] = await database.db
      .insert(outboundMessages)
      .values({
        botId: kit.bot.id,
        personId: personRow!.id,
        kind: "consultant",
        text: "Застрявшее сообщение",
        idempotencyKey: `stuck-${person}`,
        nextAttemptAt: new Date(sweepAt - 2 * MINUTE),
      })
      .returning();
    // Ждёт повтора после временного сбоя: его задача отложена, подмётчик его не трогает
    await database.db.insert(outboundMessages).values({
      botId: kit.bot.id,
      personId: personRow!.id,
      kind: "consultant",
      text: "Ждёт повтора",
      idempotencyKey: `backoff-${person}`,
      attempts: 1,
      nextAttemptAt: new Date(sweepAt + 5 * MINUTE),
    });

    const sentBefore = kit.queue.count("outbound-send");
    await kit.dialog.sweepStuck();
    expect(kit.queue.history.filter((job) => job.name === "outbound-send").slice(sentBefore).map((job) => job.payload)).toEqual([
      { outboundMessageId: stuck!.id },
    ]);
    await kit.runDue();
    expect(kit.textsTo(person).at(-1)).toBe("Застрявшее сообщение");
  });
});

describe("повтор хода", () => {
  it("ход упал после finish_dialog — повтор отвечает ровно одним сообщением с прощанием", async () => {
    const passage = await startPassage();
    kit.reply = failingAfterTools((call) => {
      if (call.lastUserText.includes("готов"))
        return { toolCalls: [{ toolName: "finish_dialog", input: { goal: "Цель", stuckAt: "Застрял", chosenStep: "Созвон", outcome: "agreed" } }] };
      return { text: DEFAULT_CONSULTANT_REPLY };
    }, "Договорились.");
    const before = kit.textsTo(person).length;

    await kit.send(person, "Я готов к созвону");
    await kit.runDue();
    kit.clock.advance(5_000);
    await kit.runDue();
    expect((await passageRow(passage.id)).status).toBe("completed");

    // Ход упал — ошибка в очередь не уходит, ход сам назначает себе повтор
    await kit.drain();

    expect(kit.textsTo(person).slice(before)).toEqual([FAREWELL]);
    const inbound = await kit.inboundOf(person);
    expect(inbound.at(-1)).toMatchObject({ route: "passage" });
    expect(inbound.at(-1)!.answeredAt).not.toBeNull();
    const after = await passageRow(passage.id);
    expect(after).toMatchObject({ status: "completed" });
    expect(after.summary).toMatchObject({ chosenStep: "Созвон" });
  });

  it("модель при повторе хода повторяет действия — переход этапа и факт о человеке не дублируются", async () => {
    const passage = await startPassage({
      stages: [
        { id: "intro", name: "Знакомство", instruction: "Узнай нишу", transitionCondition: "Ниша известна", startDay: null, isSale: false },
        { id: "goal", name: "Цель", instruction: "Узнай цель", transitionCondition: "Цель названа", startDay: null, isSale: false },
      ],
    });
    const actions = {
      toolCalls: [
        { toolName: "flow_exit", input: { exit: 1, why: "Назвал нишу" } },
        { toolName: "flow_note", input: { fact: "Дизайнер интерьеров" } },
      ],
    };
    kit.judge = () => ["intro_done"];
    let afterTools = 0;
    kit.reply = (call) => {
      if (call.lastToolResult === undefined) return actions;
      afterTools += 1;
      if (afterTools === 1) throw providerOutage();
      // Повтор хода: модель не уверена, что действия прошли, и вызывает их снова
      if (afterTools === 2) return actions;
      return { text: "Записал." };
    };

    await kit.send(person, "Я дизайнер интерьеров");
    await kit.drain();
    await kit.dialog.flow.settled();

    const after = await passageRow(passage.id);
    expect(after.currentStageId).toBe("goal");
    expect(after.stageHistory.map((entry) => entry.stageId)).toEqual(["goal"]);
    expect((await kit.personOf(person))!.facts.map((fact) => fact.text)).toEqual(["Дизайнер интерьеров"]);
    expect(kit.textsTo(person).at(-1)).toBe("Записал.");
  });
});

describe("долгий ход", () => {
  it("повтор задачи, пока идёт долгий ход: модель не запускается второй раз, ответ один", async () => {
    const passage = await startPassage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    kit.reply = () => ({ text: DEFAULT_CONSULTANT_REPLY, until: gate });

    await kit.send(person, "Я дизайнер");
    await kit.runDue("inbound-turn");
    expect(kit.queue.takeDue()?.name).toBe("inbound-turn");
    const running = kit.dialog.runTurn(passage.id);
    await until(async () => kit.calls.length === 1, "модель получила запрос");

    // Ход идёт уже 6 минут; задача хода пришла снова (подмётчик, повтор очереди)
    kit.clock.advance(6 * MINUTE);
    const repeated = kit.dialog.runTurn(passage.id);
    release();
    await Promise.all([running, repeated]);
    await kit.drain();
    expect(kit.calls).toHaveLength(1);
    expect(kit.textsTo(person).filter((text) => text === DEFAULT_CONSULTANT_REPLY)).toHaveLength(1);
    expect((await kit.inboundOf(person)).at(-1)!.answeredAt).not.toBeNull();
  });

  it("остановка работника посреди хода: ответ «остановлен», ход встаёт в очередь заново, эксперту не передаётся", async () => {
    const passage = await startPassage();
    // Модель отвечает, только когда её запрос отменят: ход гарантированно идёт в момент остановки
    kit.reply = (call) => ({ text: DEFAULT_CONSULTANT_REPLY, until: abortOf(call.options.abortSignal) });

    await kit.send(person, "Я дизайнер");
    await kit.runDue("inbound-turn");
    expect(kit.queue.takeDue()?.name).toBe("inbound-turn");
    const running = kit.dialog.runTurn(passage.id);
    await until(async () => kit.calls.length === 1, "модель получила запрос");

    await kit.dialog.flush({ waitForAnswersMs: 0 });
    await running;

    const answers = (await kit.chatStorage.listMessages(passage.chatId!)).filter((message) => message.role === "assistant");
    expect(answers.at(-1)?.status).toBe("stopped");
    const after = await passageRow(passage.id);
    expect(after).toMatchObject({ handedToExpertAt: null, turnFailures: 0 });
    expect(kit.alertTexts).toEqual([]);
    expect(kit.queue.pending).toContainEqual(expect.objectContaining({ name: "inbound-turn", singletonKey: passage.id }));
    expect(kit.textsTo(person)).not.toContain(DEFAULT_CONSULTANT_REPLY);
  });

  it("работник перезапустился посреди пачки — человек получил ровно один ответ, от консультанта своей версии, с её инструкцией", async () => {
    // Инструкция службы своя у каждой версии (условие завершения); инструкцию эксперта сценарий закрепляет за чатом сам
    const lead = await kit.publish({ endCondition: "Человек записался на разбор первой версии" });
    await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
    await kit.drain();
    const passage = (await kit.passagesOf(person))[0]!;
    // Пока разговор идёт, эксперт опубликовал новую версию: разговор остаётся на своей
    const draft = (await getLeadMagnet(database.db, lead.leadMagnetId))!.draft;
    await saveDraft(database.db, lead.leadMagnetId, { ...draft, endCondition: "Человек записался на разбор второй версии" }, "manual");
    await publishLeadMagnet(database.db, lead.leadMagnetId);

    const advance = kit.onBurstRecorded;
    // Сообщения записаны, окно тишины ещё идёт — работник останавливается
    let stopping: Promise<void> | undefined;
    kit.onBurstRecorded = () => {
      stopping = kit.dialog.flush({ waitForAnswersMs: 0 });
    };
    await kit.send(person, "Я дизайнер");
    await kit.send(person, "Веду курсы");
    await kit.runDue();
    await stopping;
    expect(kit.consultantCalls()).toHaveLength(0);

    kit.onBurstRecorded = advance;
    await kit.restartWorker();
    // Окно и удержание пачки упавшим работником прошли. Первой брошенное проверяет служба новой версии: у неё свой разговор
    kit.clock.advance(BURST_QUIET_MS + 31_000);
    const newcomer = `user-${randomUUID().slice(0, 8)}`;
    await kit.send(newcomer, `/start ${lead.code}`, { startCode: lead.code });
    await kit.drain();
    await kit.send(newcomer, "Привет");
    await kit.drain();
    await kit.dialog.tickBursts();
    await kit.drain();

    expect(kit.textsTo(person).filter((text) => text === DEFAULT_CONSULTANT_REPLY)).toHaveLength(1);
    const answered = kit.consultantCalls().filter((call) => call.lastUserText.includes("Я дизайнер"));
    expect(answered).toHaveLength(1);
    expect(answered[0]!.lastUserText).toContain("Веду курсы");
    expect(answered[0]!.system).toContain("Условие завершения разговора: Человек записался на разбор первой версии");
    expect(answered[0]!.system).not.toContain("второй версии");
    const people = (await kit.chatStorage.listMessages(passage.chatId!)).filter((message) => message.role === "user");
    expect(people.map((message) => message.parts.map((part) => ("text" in part ? part.text : "")).join(""))).toEqual(["Я дизайнер", "Веду курсы"]);
    const inbound = (await kit.inboundOf(person)).filter((row) => !row.startedPassage);
    expect(inbound.every((row) => row.answeredAt !== null && row.route === "passage")).toBe(true);
    expect(new Set(inbound.map((row) => row.turnId)).size).toBe(1);
    expect(await passageRow(passage.id)).toMatchObject({ handedToExpertAt: null, turnFailures: 0, personMessageCount: 2 });
  });
});

function abortOf(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) throw new Error("Запрос к модели без сигнала отмены");
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
