// Откат на прежнюю версию приложения (SDK 0.25, plan.md раздел 8). Пока шли сценарии, колонки напоминаний и дня
// прохождений никто не вёл. Здесь они заполняются по тому, что сделал сценарий: ответы консультанта, сообщения первым,
// счёт сообщений дня. Старый работник найдёт напоминания по `next_reminder_at`. Запускать после остановки нового
// работника и до запуска старого образа. Удаляется вместе со старыми колонками в S10.
import type { AgentFlowHandle } from "@ykurilov/agent-chat-flows";
import { and, asc, eq, gt, gte, inArray, max } from "drizzle-orm";
import type { Pool } from "pg";
import { outboundMessages } from "../channels/schema";
import { passages } from "../conversations/schema";
import { getVersion, type LeadMagnetSettings } from "../lead-magnets";
import { people } from "../people/schema";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import { appSettings, type ReminderChainSettings } from "../platform/schema";
import { readSettings } from "../platform/settings";
import { addDays, dayStartsAt, programDay, programStartDate } from "../program/calendar";
import { agentFlowOf } from "./runtime";
import { pinnedChats } from "./running-chats";

/** Цепочка напоминаний старой версии (`DEFAULT_REMINDER_CHAIN` до S6): без неё старый работник не стартует напоминания. */
export const LEGACY_REMINDER_CHAIN: ReminderChainSettings = {
  steps: [{ afterMinutes: 15 }, { afterMinutes: 60 }, { dailyAt: ["10:00", "19:00"] }],
  quietHours: ["22:00", "09:00"],
  giveUpAfterDays: 3,
};

/** Колонки прохождения, которые читает старая версия и не вёл сценарий. */
const LEGACY_COLUMNS = [
  "reminderStep",
  "reminderChainStartedAt",
  "nextReminderAt",
  "outreachSentCount",
  "outreachDay",
  "dayMessageCount",
  "dayMessageCountDay",
  "personClosedDay",
] as const;
type LegacyColumn = (typeof LEGACY_COLUMNS)[number];
type PassageRow = typeof passages.$inferSelect;
type LegacyColumns = Partial<Pick<PassageRow, LegacyColumn>>;

/** `not_pinned` — чат не за сценарием: колонки вела старая версия, трогать нечего. */
export type RollbackOutcome = "planned" | "updated" | "unchanged" | "not_pinned";

export interface ChatRollback {
  passageId: string;
  chatId: string;
  leadMagnetId: string;
  outcome: RollbackOutcome;
  changes: Partial<Record<LegacyColumn, { from: unknown; to: unknown }>>;
  warnings: string[];
}

export interface RollbackReport {
  chats: ChatRollback[];
  /** Цепочки напоминаний в настройках приложения не было — вернули старую (или вернём при `apply`). */
  reminderChainRestored: boolean;
}

export interface RollbackInput {
  db: Database;
  pool: Pool;
  /** Сценарий: счёт сообщений человека за день (`readRun().dayCounts`). */
  flow: Pick<AgentFlowHandle, "readRun">;
  clock: Clock;
  /** `false` — только посмотреть, что изменится. */
  apply: boolean;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MIN_GAP_MS = 60 * MINUTE_MS;
const LATE_AFTER_MS = 30 * MINUTE_MS;

/**
 * Срок следующего напоминания по старой цепочке (`reminders/schedule.ts` до S6, перенесено без изменений): первое — от
 * молчания, остальные — от предыдущего; после шагов «через N минут» — слоты дня; ночью — утром; не позже конца
 * `giveUpAfterDays`-го дня молчания (тогда старая версия закроет разговор «не завершил»).
 */
export function legacyNextReminderAt(input: { chain: ReminderChainSettings; clock: Clock; silenceStartedAt: Date; sentCount: number; now: Date }): Date {
  const { chain, clock, silenceStartedAt, sentCount, now } = input;
  const deadline = new Date(clock.nextMskTime("00:00", silenceStartedAt).getTime() + (chain.giveUpAfterDays - 1) * DAY_MS);
  const delays: number[] = [];
  for (const step of chain.steps) {
    if (!("afterMinutes" in step)) break;
    delays.push(step.afterMinutes);
  }
  const dailyAt = chain.steps.find((step): step is { dailyAt: string[] } => "dailyAt" in step)?.dailyAt ?? [];

  let at: Date | null;
  if (sentCount < delays.length) {
    const delayMs = (delays[sentCount]! - (sentCount > 0 ? delays[sentCount - 1]! : 0)) * MINUTE_MS;
    at = new Date((sentCount > 0 ? now : silenceStartedAt).getTime() + delayMs);
    const plannedPrevious = silenceStartedAt.getTime() + (sentCount > 0 ? delays[sentCount - 1]! : 0) * MINUTE_MS;
    if (sentCount > 0 && now.getTime() - plannedPrevious >= LATE_AFTER_MS) at = new Date(Math.max(at.getTime(), now.getTime() + MIN_GAP_MS));
  } else if (dailyAt.length > 0) {
    const after = new Date(sentCount > 0 ? now.getTime() + MIN_GAP_MS - 1 : now.getTime());
    at = new Date(Math.min(...dailyAt.map((time) => clock.nextMskTime(time, after).getTime())));
  } else {
    at = null;
  }
  if (!at) return deadline;
  if (clock.isQuietHours(at, chain.quietHours)) at = clock.nextMskTime(chain.quietHours[1], at);
  return at < deadline ? at : deadline;
}

const FIRST_MESSAGE_KINDS: Array<(typeof outboundMessages.$inferSelect)["kind"]> = ["reminder", "outreach"];

const later = (a: Date, b: Date | null | undefined) => (b && b > a ? b : a);

async function dayClosedOn(pool: Pool, chatId: string): Promise<string | null> {
  const { rows } = await pool.query<{ day_closed_on: string | null }>("select day_closed_on from agent_chat.flow_chats where chat_id = $1", [chatId]);
  return rows[0]?.day_closed_on ?? null;
}

/** Колонки старой версии по тому, что было при сценарии. */
async function legacyColumnsOf(
  input: RollbackInput,
  passage: PassageRow,
  settings: LeadMagnetSettings,
  chain: ReminderChainSettings,
  now: Date,
): Promise<LegacyColumns> {
  const { db } = input;
  const [reply] = await db
    .select({ at: max(outboundMessages.sentAt) })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.passageId, passage.id), eq(outboundMessages.kind, "consultant"), eq(outboundMessages.status, "sent")));
  // Колонка застыла при выкладке: ответы до неё — в ней, после — в исходящих. Назад начало тишины не уходит
  const frozen = passage.reminderChainStartedAt;
  const lastReplyAt = reply?.at ? later(reply.at, frozen) : (frozen ?? passage.startedAt);
  // Сообщения первым в нынешней тишине: после ответа консультанта и последнего сообщения человека
  const silenceFrom = later(lastReplyAt, passage.lastPersonMessageAt);
  const sentFirst = and(eq(outboundMessages.passageId, passage.id), inArray(outboundMessages.kind, FIRST_MESSAGE_KINDS), eq(outboundMessages.status, "sent"));
  const touches = await db
    .select({ sentAt: outboundMessages.sentAt })
    .from(outboundMessages)
    .where(and(sentFirst, gt(outboundMessages.sentAt, silenceFrom)))
    .orderBy(asc(outboundMessages.sentAt));
  const step = touches.length;
  const lastTouchAt = touches.at(-1)?.sentAt ?? null;

  if (!settings.program) {
    return {
      reminderStep: step,
      reminderChainStartedAt: lastReplyAt,
      nextReminderAt: legacyNextReminderAt({ chain, clock: input.clock, silenceStartedAt: lastReplyAt, sentCount: step, now: lastTouchAt ?? lastReplyAt }),
    };
  }

  // Программа: старая версия сама пересчитывает срок по колонкам при срабатывании — срок «сейчас» её будит
  const [person] = await db.select({ timeZone: people.timeZone }).from(people).where(eq(people.id, passage.personId));
  const timeZone = person?.timeZone ?? null;
  const startDate = passage.programStartDate ?? programStartDate(passage.startedAt, timeZone);
  const day = programDay({ startDate, now, timeZone });
  const today = addDays(startDate, day - 1);
  const sentToday = await db.$count(outboundMessages, and(sentFirst, gte(outboundMessages.sentAt, dayStartsAt(startDate, day, timeZone))));
  const run = await input.flow.readRun(passage.personId, passage.chatId);
  return {
    reminderStep: step,
    reminderChainStartedAt: later(lastReplyAt, lastTouchAt),
    outreachSentCount: sentToday,
    outreachDay: day,
    dayMessageCount: run?.dayCounts?.[today] ?? 0,
    dayMessageCountDay: day,
    personClosedDay: (await dayClosedOn(input.pool, passage.chatId)) === today ? day : passage.personClosedDay,
    nextReminderAt: passage.nextReminderAt && passage.nextReminderAt <= now ? passage.nextReminderAt : now,
  };
}

const sameValue = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function warningsOf(passage: PassageRow, settings: LeadMagnetSettings): string[] {
  const warnings: string[] = [];
  const stageIds = new Set(settings.stages.map((stage) => stage.id));
  if (passage.currentStageId && !stageIds.has(passage.currentStageId))
    warnings.push(`нода «${passage.currentStageId}» есть только в сценарии: среди этапов снимка её нет, старая версия её не знает`);
  if (!settings.program && agentFlowOf(settings.flow)?.schedule)
    warnings.push("«Дни и время» есть только в сценарии: старая версия поведёт разговор без программы");
  return warnings;
}

export async function rollbackRunningChats(input: RollbackInput): Promise<RollbackReport> {
  const { db, apply } = input;
  const now = input.clock.now();
  const reminderChainRestored = (await readSettings(db)).reminderChain === null;
  if (reminderChainRestored && apply) await db.update(appSettings).set({ reminderChain: LEGACY_REMINDER_CHAIN });

  const running = await db.select().from(passages).where(eq(passages.status, "active")).orderBy(asc(passages.startedAt));
  const pinned = await pinnedChats(input.pool, running.map((passage) => passage.chatId));
  const chats: ChatRollback[] = [];
  for (const passage of running) {
    const base = { passageId: passage.id, chatId: passage.chatId, leadMagnetId: passage.leadMagnetId, changes: {}, warnings: [] };
    if (!pinned.has(passage.chatId)) {
      chats.push({ ...base, outcome: "not_pinned" });
      continue;
    }
    const snapshot = await getVersion(db, passage.snapshotId);
    if (!snapshot) throw new Error(`Снимок ${passage.snapshotId} не найден`);
    const columns = await legacyColumnsOf(input, passage, snapshot.settings, LEGACY_REMINDER_CHAIN, now);
    const changes: ChatRollback["changes"] = {};
    for (const column of LEGACY_COLUMNS)
      if (column in columns && !sameValue(passage[column], columns[column])) changes[column] = { from: passage[column], to: columns[column] };
    const changed = Object.keys(changes).length > 0;
    if (changed && apply) await db.update(passages).set(columns).where(and(eq(passages.id, passage.id), eq(passages.status, "active")));
    chats.push({ ...base, outcome: !changed ? "unchanged" : apply ? "updated" : "planned", changes, warnings: warningsOf(passage, snapshot.settings) });
  }
  return { chats, reminderChainRestored };
}

const OUTCOME_LABELS: Record<RollbackOutcome, string> = {
  planned: "изменю",
  updated: "изменено",
  unchanged: "без изменений",
  not_pinned: "не за сценарием, не трогаю",
};

const shown = (value: unknown) =>
  value instanceof Date
    ? value.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : String(value);

/** Отчёт скрипта: строка на прохождение, «было → стало» по колонкам, итог. Время — по Москве. */
export function formatRollbackReport(report: RollbackReport, options: { apply: boolean }): string {
  const lines = report.chats.map((chat) => {
    const head = `[${OUTCOME_LABELS[chat.outcome]}] прохождение ${chat.passageId} (лидмагнит ${chat.leadMagnetId}, чат ${chat.chatId})`;
    const changes = Object.entries(chat.changes).map(([column, change]) => `${column}: ${shown(change.from)} → ${shown(change.to)}`);
    return [head, ...changes, ...chat.warnings.map((warning) => `внимание: ${warning}`)].join("\n    ");
  });
  if (report.reminderChainRestored)
    lines.unshift(`${options.apply ? "Вернул" : "Верну"} цепочку напоминаний старой версии в настройки приложения (15 мин, 1 ч, 10:00 и 19:00, 3 дня).`);
  const count = (outcome: RollbackOutcome) => report.chats.filter((chat) => chat.outcome === outcome).length;
  const summary = options.apply
    ? `Итог: идущих ${report.chats.length}; изменено ${count("updated")}, без изменений ${count("unchanged")}, не за сценарием ${count("not_pinned")}.`
    : `Режим «посмотреть», ничего не записано. Идущих ${report.chats.length}; изменю ${count("planned")}, без изменений ${count("unchanged")}, не за сценарием ${count("not_pinned")}. Применить: --apply`;
  return [...lines, summary].join("\n");
}
