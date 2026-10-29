import type { ChatStorage } from "@ykurilov/agent-chat-core";
import { and, count, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import type { AlertKind, AlertService } from "../alerts";
import { alerts } from "../alerts/schema";
import { passages } from "../conversations/schema";
import type { Clock } from "../platform/clock";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { readSettings } from "../platform/settings";
import { resumeBudgetPausedPassages } from "./emergency-stop";
import { modelUsage, type ModelUsageKind } from "./schema";

/** Раз в 5 минут (cron, UTC): пороги бюджета и возобновление после аварийной остановки. */
export const BUDGET_CHECK_CRON = "*/5 * * * *";
/** С этой доли месячного бюджета консультант не вызывается. */
export const EMERGENCY_STOP_SHARE = 2;

export interface BudgetStatus {
  /** Расход месяца по Москве, $: журнал SDK (с тестовыми разговорами) и запросы мимо SDK. */
  spentUsd: number;
  /** `null` — бюджет не задан: ни тревог, ни остановки. */
  budgetUsd: number | null;
  share: number | null;
  emergencyStopped: boolean;
}

export interface BudgetDependencies {
  db: Database;
  chatStorage: ChatStorage;
  clock: Clock;
}

export interface BudgetCheckDependencies extends BudgetDependencies {
  alerts: AlertService;
  queue: JobEnqueuer;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;
const spentOf = ({ spentUsd, budgetUsd }: BudgetStatus) => `${money(spentUsd)} из ${money(budgetUsd!)}`;

/** Пороги от старшего к младшему: тревога приходит только о старшем достигнутом. */
const THRESHOLDS: { share: number; kind: AlertKind; text(status: BudgetStatus): string }[] = [
  {
    share: EMERGENCY_STOP_SHARE,
    kind: "budget_200",
    text: (status) =>
      `Аварийная остановка: расход за месяц достиг 200% бюджета (${spentOf(status)}). Консультант не отвечает людям, пока вы не поднимете бюджет в настройках. Тем, кто написал за это время, бот ответит сам.`,
  },
  {
    share: 1,
    kind: "budget_100",
    text: (status) =>
      `Месячный бюджет израсходован на 100% (${spentOf(status)}). Бот продолжает отвечать. Тревога повторяется раз в час, пока вы не нажмёте «Вижу» в настройках.`,
  },
  { share: 0.8, kind: "budget_80", text: (status) => `Израсходовано 80% месячного бюджета (${spentOf(status)}).` },
  { share: 0.5, kind: "budget_50", text: (status) => `Израсходовано 50% месячного бюджета (${spentOf(status)}).` },
];

/** Начало текущего месяца по Москве. */
function mskMonthStart(clock: Clock): Date {
  return new Date(`${clock.mskDate().slice(0, 7)}-01T00:00:00+03:00`);
}

/** Расход на запрос к модели мимо сервиса SDK (тексты напоминаний). */
export async function recordModelUsage(
  db: DatabaseExecutor,
  input: { kind: ModelUsageKind; passageId: string | null; costUsd: number; at: Date },
): Promise<void> {
  await db.insert(modelUsage).values({
    kind: input.kind,
    passageId: input.passageId,
    costUsd: input.costUsd.toFixed(6),
    createdAt: input.at,
  });
}

/**
 * Расход на тексты старых напоминаний по прохождению, $: его нет в журнале SDK, поэтому к цене разговора он
 * прибавляется отдельно. Новые не пишутся — сообщения первым ведёт сценарий SDK (`first_message` в журнале); строка до
 * уборки старых колонок (S10).
 */
export async function reminderCostOf(db: DatabaseExecutor, passageId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${modelUsage.costUsd}), 0)` })
    .from(modelUsage)
    .where(and(eq(modelUsage.passageId, passageId), eq(modelUsage.kind, "reminder_text")));
  return Number(row?.total ?? 0);
}

/** Расход месяца и доля бюджета, без тревог: для экрана настроек и проверки перед ходом. */
export async function readBudgetStatus(deps: BudgetDependencies): Promise<BudgetStatus> {
  const since = mskMonthStart(deps.clock);
  const [sums, [direct], settings] = await Promise.all([
    deps.chatStorage.sumUsage({ since: since.toISOString() }),
    deps.db
      .select({ total: sql<string>`coalesce(sum(${modelUsage.costUsd}), 0)` })
      .from(modelUsage)
      // Сообщения первым в программе уже в журнале SDK: их запись — только для отчёта
      .where(and(gte(modelUsage.createdAt, since), ne(modelUsage.kind, "program_message"))),
    readSettings(deps.db),
  ]);
  const spentUsd = sums.reduce((total, sum) => total + sum.costUsd, 0) + Number(direct!.total);
  const budgetUsd = settings.monthlyBudgetUsd === null ? null : Number(settings.monthlyBudgetUsd);
  const share = budgetUsd === null ? null : budgetUsd > 0 ? spentUsd / budgetUsd : Infinity;
  return { spentUsd, budgetUsd, share, emergencyStopped: share !== null && share >= EMERGENCY_STOP_SHARE };
}

/**
 * Задача `budget-check` и проверка после каждого хода: тревога о старшем достигнутом пороге,
 * снятие тревог выше расхода (бюджет подняли, начался месяц), возобновление остановленных разговоров.
 */
export async function checkBudget(deps: BudgetCheckDependencies): Promise<BudgetStatus> {
  const status = await readBudgetStatus(deps);
  const share = status.share ?? 0;
  const reached = status.share === null ? undefined : THRESHOLDS.find((threshold) => share >= threshold.share);
  for (const threshold of THRESHOLDS) {
    if (threshold === reached) await deps.alerts.raise(threshold.kind, threshold.text(status));
    else if (share < threshold.share) await deps.alerts.resolve(threshold.kind);
  }
  if (!status.emergencyStopped) await resumeBudgetPausedPassages(deps);
  return status;
}

export interface SpendingOverview extends BudgetStatus {
  /** Разговоры, ждущие подъёма бюджета после аварийной остановки. */
  pausedPassages: number;
  /** Достигнуты именно 100% (не 200%): тревога этого месяца повторяется раз в час, «вижу» ещё не нажато. */
  overrunAwaitingAck: boolean;
}

/** Расход и состояние бюджета для экрана «Настройки». */
export async function readSpendingOverview(deps: BudgetDependencies): Promise<SpendingOverview> {
  const [status, [paused], [overrun]] = await Promise.all([
    readBudgetStatus(deps),
    deps.db
      .select({ total: count() })
      .from(passages)
      .where(and(isNotNull(passages.budgetPausedAt), eq(passages.status, "active"))),
    deps.db
      .select({ acknowledgedAt: alerts.acknowledgedAt })
      .from(alerts)
      .where(and(eq(alerts.kind, "budget_100"), eq(alerts.period, deps.clock.mskDate().slice(0, 7)))),
  ]);
  const repeatsHourly = status.share !== null && status.share >= 1 && !status.emergencyStopped;
  return {
    ...status,
    pausedPassages: paused!.total,
    overrunAwaitingAck: repeatsHourly && overrun !== undefined && !overrun.acknowledgedAt,
  };
}

/** Эксперт нажал «вижу»: тревога 100% больше не повторяется в этом месяце. */
export async function acknowledgeBudgetOverrun(alerts: AlertService): Promise<void> {
  await alerts.acknowledge("budget_100");
}
