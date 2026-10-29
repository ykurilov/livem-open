import type { ChatStorage, UsageSource } from "@ykurilov/agent-chat-core";
import type { FlowState } from "@ykurilov/agent-chat-flows/format";
import { and, asc, avg, count, eq, inArray, isNotNull, sql, sum } from "drizzle-orm";
import { outboundMessages } from "../channels/schema";
import type { SaleReason } from "../consultant/schema";
import { inboundMessages, passages } from "../conversations/schema";
import { modelUsage } from "../spending/schema";
import type { DatabaseExecutor } from "../platform/db";
import { entryLinks, leadMagnets, leadMagnetVersions } from "./schema";
import type { LeadMagnetSettings } from "./settings";
import { SALE_TAG } from "../flows/settings-to-flow";

/** Нода сценария в отчёте. */
interface RouteStep {
  id: string;
  name: string;
  isSale: boolean;
}

const stepOfState = (state: FlowState): RouteStep => ({ id: state.id, name: state.title.trim() || state.id, isSale: state.tags.includes(SALE_TAG) });

/**
 * Путь по снимку — ноды сценария: их правят на доске, этапы настроек тогда устаревают. Первая — стартовая: в ней
 * человек, пока нода не сменилась. Конечные ноды не входят. Сценарий есть у всех снимков: миграция дописала его старым.
 */
function routeOf({ flow }: LeadMagnetSettings): RouteStep[] {
  const working = flow.states.filter((state) => state.exits.length > 0);
  const start = working.find((state) => state.id === flow.start);
  return [...(start ? [start] : []), ...working.filter((state) => state !== start)].map(stepOfState);
}

const stepsCache = new WeakMap<LeadMagnetSettings, Map<string, RouteStep>>();

/** Нода по id в снимке, и конечная тоже; `null` — стартовая. */
function stepOf(settings: LeadMagnetSettings | undefined, id: string | null): RouteStep | undefined {
  if (!settings) return undefined;
  let steps = stepsCache.get(settings);
  if (!steps) {
    steps = new Map(settings.flow.states.map((state) => [state.id, stepOfState(state)]));
    stepsCache.set(settings, steps);
  }
  const stepId = id ?? settings.flow.start;
  return stepId === null ? undefined : steps.get(stepId);
}

/** Средняя цена завершённого прохождения по лидмагнитам, $. Лидмагнита без завершённых прохождений в списке нет. */
export async function averagePassageCosts(db: DatabaseExecutor): Promise<Map<string, number>> {
  const rows = await db
    .select({ leadMagnetId: passages.leadMagnetId, averageUsd: avg(passages.costUsd) })
    .from(passages)
    .where(eq(passages.status, "completed"))
    .groupBy(passages.leadMagnetId);
  return new Map(rows.map((row) => [row.leadMagnetId, Number(row.averageUsd)]));
}

/** Строка отчёта по ссылке. `linkId = null` — пришли без ссылки (лидмагнит по умолчанию, меню бота). */
export interface LinkReportRow {
  linkId: string | null;
  /** Метка; `null` у основной ссылки и у строки «без ссылки». */
  label: string | null;
  isMain: boolean;
  archived: boolean;
  arrived: number;
  completed: number;
  /** Сколько стоили все прохождения по ссылке, $. */
  costUsd: number;
}

export interface StageStopRow {
  stageId: string;
  name: string;
  /** Сколько людей бросили разговор на этом этапе (не завершил или заблокировал бота). */
  stopped: number;
}

export interface LeadMagnetReport {
  byLink: LinkReportRow[];
  stoppedByStage: StageStopRow[];
}

/** Отчёт лидмагнита: по ссылкам и меткам (пришло, завершило, стоимость) и по этапам, где люди остановились. */
export async function leadMagnetReport(db: DatabaseExecutor, leadMagnetId: string): Promise<LeadMagnetReport> {
  const [byLink, stoppedByStage] = await Promise.all([reportByLink(db, leadMagnetId), reportStoppedByStage(db, leadMagnetId)]);
  return { byLink, stoppedByStage };
}

async function reportByLink(db: DatabaseExecutor, leadMagnetId: string): Promise<LinkReportRow[]> {
  const links = await db
    .select()
    .from(entryLinks)
    .where(eq(entryLinks.leadMagnetId, leadMagnetId))
    // Основная ссылка (без метки) первой, затем метки по порядку создания
    .orderBy(sql`${entryLinks.label} is not null`, asc(entryLinks.createdAt), asc(entryLinks.id));
  const totals = await db
    .select({
      linkId: passages.entryLinkId,
      arrived: count(),
      completed: sql<number>`count(*) filter (where ${passages.status} = 'completed')`.mapWith(Number),
      costUsd: sum(passages.costUsd),
    })
    .from(passages)
    .where(eq(passages.leadMagnetId, leadMagnetId))
    .groupBy(passages.entryLinkId);
  const totalsOf = (linkId: string | null) => {
    const row = totals.find((entry) => entry.linkId === linkId);
    return { arrived: row?.arrived ?? 0, completed: row?.completed ?? 0, costUsd: Number(row?.costUsd ?? 0) };
  };

  const rows: LinkReportRow[] = links.map((link) => ({
    linkId: link.id,
    label: link.label,
    isMain: link.label === null,
    archived: link.archivedAt !== null,
    ...totalsOf(link.id),
  }));
  const withoutLink = totalsOf(null);
  if (withoutLink.arrived > 0) rows.push({ linkId: null, label: null, isMain: false, archived: false, ...withoutLink });
  return rows;
}

const STOPPED_STATUSES = ["not_completed", "blocked"] as const;

/**
 * Где люди бросили разговор. Нода ещё не сменилась (`current_stage_id` пуст) — значит, человек в стартовой.
 * Названия и порядок — по опубликованной версии (иначе по черновику); ноды из старых снимков — следом. Путь из одной
 * ноды (разговор без этапов) разбивки не даёт.
 */
async function reportStoppedByStage(db: DatabaseExecutor, leadMagnetId: string): Promise<StageStopRow[]> {
  const groups = await db
    .select({ snapshotId: passages.snapshotId, stageId: passages.currentStageId, stopped: count() })
    .from(passages)
    .where(and(eq(passages.leadMagnetId, leadMagnetId), inArray(passages.status, [...STOPPED_STATUSES])))
    .groupBy(passages.snapshotId, passages.currentStageId);

  const [lead] = await db
    .select({ draft: leadMagnets.draft, publishedSnapshotId: leadMagnets.publishedSnapshotId })
    .from(leadMagnets)
    .where(eq(leadMagnets.id, leadMagnetId));
  if (!lead) return [];
  const settingsOf = await snapshotSettings(db, [...groups.map((group) => group.snapshotId), ...(lead.publishedSnapshotId ? [lead.publishedSnapshotId] : [])]);

  const current = (lead.publishedSnapshotId && settingsOf.get(lead.publishedSnapshotId)) || lead.draft;
  const currentRoute = routeOf(current);
  if (currentRoute.length < 2) return [];
  const rows = new Map<string, StageStopRow>(currentRoute.map((step) => [step.id, { stageId: step.id, name: step.name, stopped: 0 }]));
  for (const group of groups) {
    const step = stepOf(settingsOf.get(group.snapshotId), group.stageId);
    const stageId = step?.id ?? group.stageId;
    if (!stageId) continue; // снимка нет
    const row = rows.get(stageId) ?? { stageId, name: step?.name ?? stageId, stopped: 0 };
    row.stopped += group.stopped;
    rows.set(stageId, row);
  }
  return [...rows.values()];
}

/** Настройки снимков по id: один запрос. */
async function snapshotSettings(db: DatabaseExecutor, ids: string[]): Promise<Map<string, LeadMagnetSettings>> {
  const unique = [...new Set(ids)];
  const snapshots = unique.length
    ? await db.select({ id: leadMagnetVersions.id, settings: leadMagnetVersions.settings }).from(leadMagnetVersions).where(inArray(leadMagnetVersions.id, unique))
    : [];
  return new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.settings]));
}

export interface ProgramReport {
  /** Срок программы по опубликованной версии (иначе по черновику). */
  days: number;
  /** Сколько людей проходят или прошли программу. */
  passages: number;
  /** Сколько людей дошли до дня N или дальше. */
  reachedDay: Array<{ day: number; count: number }>;
  /** Сколько людей дошли до ноды «Продажа» (метка `SALE_TAG`). */
  reachedSale: number;
  outreach: {
    /** Сколько сообщений бот написал первым. */
    messages: number;
    /** На сколько из них человек ответил раньше следующего сообщения первым. */
    messagesAnswered: number;
    /** Скольким людям бот писал первым. */
    people: number;
    /** Сколько из них вернулись и ответили. */
    peopleReturned: number;
    /** Сколько стоили сообщения первым, $: ходы «пишет первым» в журнале SDK (`first_message`). */
    costUsd: number;
  };
  /** Сколько стоил судья сценария (условия выхода словами), $: строка `judge` журнала SDK. */
  judgeCostUsd: number;
  /** Причины отказа в продаже; причины без людей не показываются. */
  refusalReasons: Array<{ reason: SaleReason; count: number }>;
}

const REASON_ORDER: SaleReason[] = ["price", "time", "doubt", "not_interested"];

/** Расход журнала SDK по чатам и строке расхода, $: один запрос на все чаты. */
async function usageCostOf(usage: Pick<ChatStorage, "sumUsageByChat">, chatIds: string[], source: UsageSource): Promise<number> {
  if (chatIds.length === 0) return 0;
  if (!usage.sumUsageByChat) throw new Error("Хранилищу чатов нужен sumUsageByChat (SDK 0.53)");
  const sums = await usage.sumUsageByChat({ chatIds, source });
  return sums.reduce((total, entry) => total + entry.costUsd, 0);
}

/** Отчёт «Программа». `null` — у лидмагнита нет программы (сценария с «Днями и временем»). */
export async function programReport(db: DatabaseExecutor, usage: Pick<ChatStorage, "sumUsageByChat">, leadMagnetId: string): Promise<ProgramReport | null> {
  const [lead] = await db
    .select({ draft: leadMagnets.draft, publishedSnapshotId: leadMagnets.publishedSnapshotId })
    .from(leadMagnets)
    .where(eq(leadMagnets.id, leadMagnetId));
  if (!lead) return null;
  const rows = await db
    .select({
      id: passages.id,
      chatId: passages.chatId,
      snapshotId: passages.snapshotId,
      furthestDay: passages.furthestDay,
      stageHistory: passages.stageHistory,
      saleAnswer: passages.saleAnswer,
    })
    .from(passages)
    .where(and(eq(passages.leadMagnetId, leadMagnetId), isNotNull(passages.programStartDate)));

  const settingsOf = await snapshotSettings(db, [...rows.map((row) => row.snapshotId), ...(lead.publishedSnapshotId ? [lead.publishedSnapshotId] : [])]);
  const current = (lead.publishedSnapshotId && settingsOf.get(lead.publishedSnapshotId)) || lead.draft;
  const plannedDays = current.flow?.schedule?.lengthDays ?? current.program?.days;
  if (plannedDays === undefined && rows.length === 0) return null;
  const days = Math.max(plannedDays ?? 0, ...rows.map((row) => row.furthestDay));

  // Продажа — по метке ноды в снимке прохождения
  const isSaleStep = (snapshotId: string, stageId: string) => stepOf(settingsOf.get(snapshotId), stageId)?.isSale ?? false;
  const reachedSale = rows.filter((row) => row.stageHistory.some((entry) => isSaleStep(row.snapshotId, entry.stageId))).length;

  const reasonCounts = new Map<SaleReason, number>();
  for (const row of rows) if (row.saleAnswer) reasonCounts.set(row.saleAnswer.reason, (reasonCounts.get(row.saleAnswer.reason) ?? 0) + 1);

  const passageIds = rows.map((row) => row.id);
  const chatIds = rows.map((row) => row.chatId);
  const [touchCostUsd, judgeCostUsd] = await Promise.all([usageCostOf(usage, chatIds, "first_message"), usageCostOf(usage, chatIds, "judge")]);
  const [outreach, answers, legacyCosts] = passageIds.length
    ? await Promise.all([
        db
          .select({ passageId: outboundMessages.passageId, createdAt: outboundMessages.createdAt })
          .from(outboundMessages)
          .where(and(inArray(outboundMessages.passageId, passageIds), eq(outboundMessages.kind, "outreach"), eq(outboundMessages.status, "sent")))
          .orderBy(asc(outboundMessages.createdAt)),
        db
          .select({ passageId: inboundMessages.passageId, receivedAt: inboundMessages.receivedAt })
          .from(inboundMessages)
          .where(and(inArray(inboundMessages.passageId, passageIds), eq(inboundMessages.kind, "message"))),
        db
          // Сообщения первым программы до сценариев: свой учёт расхода, в журнале SDK — строкой ответа
          .select({ total: sum(modelUsage.costUsd) })
          .from(modelUsage)
          .where(and(inArray(modelUsage.passageId, passageIds), eq(modelUsage.kind, "program_message"))),
      ])
    : [[], [], [{ total: null }]];

  const sentTimes = new Map<string, number[]>();
  for (const message of outreach) {
    if (!message.passageId) continue;
    sentTimes.set(message.passageId, [...(sentTimes.get(message.passageId) ?? []), message.createdAt.getTime()]);
  }
  const answerTimes = new Map<string, number[]>();
  for (const answer of answers) {
    if (!answer.passageId) continue;
    answerTimes.set(answer.passageId, [...(answerTimes.get(answer.passageId) ?? []), answer.receivedAt.getTime()]);
  }
  let messagesAnswered = 0;
  let peopleReturned = 0;
  for (const [passageId, times] of sentTimes) {
    const replies = answerTimes.get(passageId) ?? [];
    let returned = false;
    times.forEach((sentAt, index) => {
      const nextSentAt = times[index + 1] ?? Infinity;
      if (replies.some((at) => at > sentAt && at < nextSentAt)) {
        messagesAnswered += 1;
        returned = true;
      }
    });
    if (returned) peopleReturned += 1;
  }

  return {
    days,
    passages: rows.length,
    reachedDay: Array.from({ length: days }, (_, index) => ({ day: index + 1, count: rows.filter((row) => row.furthestDay >= index + 1).length })),
    reachedSale,
    outreach: {
      messages: outreach.length,
      messagesAnswered,
      people: sentTimes.size,
      peopleReturned,
      costUsd: touchCostUsd + Number(legacyCosts[0]?.total ?? 0),
    },
    judgeCostUsd,
    refusalReasons: REASON_ORDER.filter((reason) => reasonCounts.has(reason)).map((reason) => ({ reason, count: reasonCounts.get(reason)! })),
  };
}
