// Брошенный разговор («не завершил») продолжается тем же чатом, если человек вернулся меньше чем через неделю и рассылки
// после разговора не было (flow.reopen SDK 0.68). Иначе, как и при отказе сценария, — «Входящие» с автоответом.
import { randomUUID } from "node:crypto";
import type { AgentFlow } from "@ykurilov/agent-chat-flows";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, DEFAULT_CONSULTANT_REPLY, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { outboundMessages } from "../channels/schema";
import { newProgramSettings, unpublishLeadMagnet, type Stage } from "../lead-magnets";
import { menuButtonPayload } from "./no-code";
import { updateSettings } from "../platform/settings";
import { AUTOREPLY_TEXT } from "./router";

// 14:00 по Москве 12 октября
const START = new Date("2026-10-12T11:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FIRST_MESSAGE = "Здравствуйте! Я Василий, расскажите об идее.";

const STAGES: Stage[] = [
  { id: "start", name: "Знакомство", instruction: "Узнай идею приложения.", transitionCondition: "Идея есть", startDay: null, isSale: false },
  { id: "build", name: "Сборка", instruction: "Помоги собрать приложение.", transitionCondition: "Прислал ссылку", startDay: 2, isSale: false },
  { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: 3, isSale: true },
];

/** Два касания, потом тишина до «не завершил». */
const giveUpAfter = (days: number) => (flow: AgentFlow): AgentFlow => ({
  ...flow,
  nudges: { afterSilence: [{ amount: 15, unit: "min" }, { amount: 1, unit: "h" }], giveUpAfter: { amount: days, unit: "d" } },
});

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
  await database.pool.query("do $$ begin if to_regclass('agent_chat.flow_chats') is not null then delete from agent_chat.flow_chats; end if; end $$");
  kit = await createLiveDialogKit(database, { start: START, pricePerMillion: 0 });
  person = `user-${randomUUID().slice(0, 8)}`;
});

async function say(text: string) {
  await kit.send(person, text);
  await kit.runDue();
  kit.clock.advance(5_000);
  await kit.runDue();
  await kit.dialog.flow.settled();
}

/** Часы идут шагами до `until`, как обход таймеров работника. */
async function walk(until: Date, stepMs = 30 * MINUTE) {
  while (kit.clock.now() < until) {
    kit.clock.advance(Math.min(stepMs, until.getTime() - kit.clock.now().getTime()));
    await kit.dialog.flow.tick();
    await kit.dialog.flow.settled();
    await kit.runDue();
  }
}

const passages = () => kit.passagesOf(person);
const later = (ms: number) => new Date(kit.clock.now().getTime() + ms);

/** Разговор начат, человек ответил и замолчал; сценарий закончил его «не завершил». */
async function abandon(days = 3) {
  const lead = await kit.publish({ firstMessage: FIRST_MESSAGE }, giveUpAfter(days));
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.runDue();
  await say("Привет, я дизайнер");
  await walk(later(days * DAY + 2 * 60 * MINUTE));
  const [ended] = await passages();
  expect(ended).toMatchObject({ status: "not_completed" });
  return ended!;
}

const lastInbound = async () => (await kit.inboundOf(person)).at(-1);

describe("вернулся в брошенный разговор", () => {
  it("2 дня спустя — тот же чат и та же нода, без нового вступления; модель видит прежнюю переписку", async () => {
    const ended = await abandon();
    const ownerId = (await kit.personOf(person))!.id;
    const stateBefore = (await kit.dialog.flow.readRun(ownerId, ended.chatId))?.state;
    kit.clock.advance(2 * DAY);
    const sentBefore = kit.textsTo(person).length;
    const callsBefore = kit.consultantCalls().length;

    await say("Я вернулся, давайте продолжим");

    expect(await passages()).toEqual([expect.objectContaining({ id: ended.id, chatId: ended.chatId, status: "active", endedAt: null })]);
    expect(await lastInbound()).toMatchObject({ route: "passage", passageId: ended.id, autoreply: false });
    const newTexts = kit.textsTo(person).slice(sentBefore);
    expect(newTexts).toEqual([DEFAULT_CONSULTANT_REPLY]);
    expect(newTexts.join()).not.toContain(FIRST_MESSAGE);
    const run = await kit.dialog.flow.readRun(ownerId, ended.chatId);
    expect(run?.state).toBe(stateBefore);
    const [call] = kit.consultantCalls().slice(callsBefore);
    expect(JSON.stringify(call!.options.prompt)).toContain("Привет, я дизайнер");
  });

  it("пока сценарий открывался, человек начал другой лидмагнит по ссылке — открытый сценарий закрывается обратно с прежней причиной", async () => {
    const ended = await abandon();
    const ownerId = ended.personId;
    const other = await kit.publish({ firstMessage: "Другой лидмагнит" });
    kit.clock.advance(2 * DAY);
    const reopen = kit.dialog.flow.reopen.bind(kit.dialog.flow);
    const spy = vi.spyOn(kit.dialog.flow, "reopen").mockImplementation(async (input) => {
      // Между проходами маршрутизации пришла ссылка другого лидмагнита и начала разговор
      await kit.send(person, `/start ${other.code}`, { startCode: other.code });
      await kit.runDue();
      return reopen(input);
    });
    try {
      await say("Я вернулся");
    } finally {
      spy.mockRestore();
    }

    const rows = await passages();
    expect(rows.find((row) => row.id === ended.id)).toMatchObject({ status: "not_completed" });
    expect(rows.find((row) => row.id !== ended.id)).toMatchObject({ leadMagnetId: other.leadMagnetId, status: "active" });
    const run = await kit.dialog.flow.readRun(ownerId, ended.chatId);
    expect(run).toMatchObject({ endReason: "abandoned" });
    expect(run?.endedAt).toBeGreaterThan(run?.reopenedAt ?? 0);
  });

  it("кнопка снятого лидмагнита 2 дня спустя — брошенный разговор открывается снова, нажатие подтверждено, касания идут", async () => {
    const ended = await abandon();
    const removed = await kit.publish({ name: "Снят" });
    await unpublishLeadMagnet(database.db, removed.leadMagnetId);
    kit.clock.advance(2 * DAY);

    await kit.webhook([{ type: "button", dedupeKey: `${person}-press`, userId: person, callbackId: "cb-1", payload: menuButtonPayload(removed.code) }]);
    await kit.runDue();
    await kit.dialog.flow.settled();

    expect(await passages()).toEqual([expect.objectContaining({ id: ended.id, status: "active" })]);
    expect(kit.channel.answeredButtons).toContain("cb-1");
    const run = await kit.dialog.flow.readRun(ended.personId, ended.chatId);
    expect(run?.endedAt).toBeUndefined();
  });

  it("8 дней спустя — «Входящие» с автоответом, разговор остаётся «не завершил»", async () => {
    const ended = await abandon();
    kit.clock.advance(8 * DAY);
    const sentBefore = kit.textsTo(person).length;

    await say("Здравствуйте, у меня вопрос про другой курс");

    expect(await passages()).toEqual([expect.objectContaining({ id: ended.id, status: "not_completed" })]);
    expect(await lastInbound()).toMatchObject({ route: "inbox", autoreply: true });
    expect(kit.textsTo(person).slice(sentBefore)).toEqual([AUTOREPLY_TEXT]);
  });

  it("после разговора ушла рассылка — человек отвечает на неё: «Входящие», не разговор", async () => {
    const ended = await abandon();
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

    await say("Интересно, расскажите подробнее");

    expect(await passages()).toEqual([expect.objectContaining({ id: ended.id, status: "not_completed" })]);
    expect(await lastInbound()).toMatchObject({ route: "inbox", autoreply: true });
  });

  it("срок программы уже вышел — сценарий не открывается: «Входящие» с автоответом", async () => {
    // Программа 3 дня с 12 октября; разговор закончен своей причиной приложения 13-го, человек вернулся 16-го —
    // меньше недели, но программа кончилась
    const lead = await kit.publish({ firstMessage: FIRST_MESSAGE, stages: STAGES, program: newProgramSettings(3), maxPersonMessages: 100 });
    await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
    await kit.runDue();
    await say("Привет, я дизайнер");
    kit.clock.advance(DAY);
    const [started] = await passages();
    await kit.dialog.flow.end({ ownerId: started!.personId, chatId: started!.chatId, reason: "paused_by_expert" });
    await kit.dialog.flow.settled();
    expect(await passages()).toEqual([expect.objectContaining({ status: "not_completed" })]);
    kit.clock.advance(3 * DAY);

    await say("Я вернулся");

    expect(await passages()).toEqual([expect.objectContaining({ id: started!.id, status: "not_completed" })]);
    expect(await lastInbound()).toMatchObject({ route: "inbox", autoreply: true });
  });
});
