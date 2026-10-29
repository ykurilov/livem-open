import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import { readSettings } from "../platform/settings";
import { alerts, type AlertKind } from "./schema";

/** Куда уходят тревоги. В работе — Telegram, в тестах — запись в память. */
export interface AlertNotifier {
  send(chatId: string, text: string): Promise<void>;
}

export type RaiseResult = { status: "sent" } | { status: "suppressed" } | { status: "failed"; error: string };

export interface AlertService {
  /**
   * Сообщает о событии, если об этом ещё не сообщали. `period` отделяет одно событие от другого
   * (id бота; для бюджета по умолчанию — текущий месяц по Москве).
   */
  raise(kind: AlertKind, text: string, period?: string): Promise<RaiseResult>;
  /** Эксперт нажал «вижу»: повторы 100% прекращаются. */
  acknowledge(kind: AlertKind, period?: string): Promise<void>;
  /** Причина ушла (бот снова работает, бюджет поднят): та же тревога может прийти снова. */
  resolve(kind: AlertKind, period?: string): Promise<void>;
}

export interface AlertServiceDependencies {
  db: Database;
  clock: Clock;
  notifier: AlertNotifier;
}

const REPEAT_EVERY_MS = 60 * 60_000;

export function createAlerts({ db, clock, notifier }: AlertServiceDependencies): AlertService {
  const periodFor = (kind: AlertKind, period?: string) =>
    period ?? (kind.startsWith("budget_") ? clock.mskDate().slice(0, 7) : "");

  const keyOf = (kind: AlertKind, period: string) => and(eq(alerts.kind, kind), eq(alerts.period, period));

  return {
    async raise(kind, text, periodOverride) {
      const period = periodFor(kind, periodOverride);
      const now = clock.now();
      const repeatBefore = new Date(now.getTime() - REPEAT_EVERY_MS);

      // Строка занимается атомарно: из двух одновременных проверок шлёт только та, что заняла.
      // Существующую строку можно занять только для разрешённого повтора 100%.
      const [claim] = await db
        .insert(alerts)
        .values({ kind, period, lastSentAt: now })
        .onConflictDoUpdate({
          target: [alerts.kind, alerts.period],
          set: { lastSentAt: now },
          setWhere:
            kind === "budget_100" ? and(isNull(alerts.acknowledgedAt), lte(alerts.lastSentAt, repeatBefore)) : sql`false`,
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (!claim) return { status: "suppressed" };

      try {
        const { alertChatId } = await readSettings(db);
        if (!alertChatId) throw new Error("Не задан чат для тревог (настройка alert_chat_id)");
        await notifier.send(alertChatId, text);
        return { status: "sent" };
      } catch (error) {
        // Не ушла — строка возвращается как была: новая удаляется, у повтора час не сдвигается
        const ours = and(keyOf(kind, period), eq(alerts.lastSentAt, now));
        if (claim.inserted) await db.delete(alerts).where(ours);
        else await db.update(alerts).set({ lastSentAt: repeatBefore }).where(ours);
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Тревога ${kind} не отправлена:`, message);
        return { status: "failed", error: message };
      }
    },

    async acknowledge(kind, periodOverride) {
      await db
        .update(alerts)
        .set({ acknowledgedAt: clock.now() })
        .where(keyOf(kind, periodFor(kind, periodOverride)));
    },

    async resolve(kind, periodOverride) {
      await db.delete(alerts).where(keyOf(kind, periodFor(kind, periodOverride)));
    },
  };
}
