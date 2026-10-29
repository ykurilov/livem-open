import { sql } from "drizzle-orm";
import type { AlertService } from "../alerts";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import { modelHealth } from "./schema";

/** После стольких сбоев модели подряд — тревога эксперту. */
export const MODEL_FAILURES_ALERT_AFTER = 3;

/** Человеку, чей ход несколько раз упал: ответ будет, просто позже. */
export const MODEL_DELAY_TEXT = "Извините, мне нужно чуть больше времени на ответ. Скоро напишу.";

/** На каком по счёту сбое хода человеку уходит «отвечу чуть позже». */
export const MODEL_DELAY_AFTER_TURN_FAILURES = 2;

/**
 * Потолок повторов хода при сбоях провайдера. По расписанию пауз ниже 48 попыток — около 21 часа:
 * дольше суток держать человека без ответа незачем, разговор передаётся эксперту во «Входящие».
 */
export const MAX_TURN_PROVIDER_FAILURES = 48;

/** Паузы перед повтором упавшего хода, с: чем дольше лежит модель, тем реже. Дальше — последняя. */
const TURN_RETRY_DELAYS_SECONDS = [30, 60, 120, 300, 600, 1200, 1800];

/** Пауза перед повтором хода, упавшего `failures`-й раз подряд. */
export function turnRetryDelaySeconds(failures: number): number {
  return TURN_RETRY_DELAYS_SECONDS[Math.min(failures, TURN_RETRY_DELAYS_SECONDS.length) - 1]!;
}

export interface ModelFailureTracker {
  /** Ход упал на сбое провайдера. Серия дошла до порога — громкая тревога, одна на серию. */
  recordFailure(reason: string): Promise<void>;
  /** Ход прошёл: серия оборвалась, следующая снова даст тревогу. */
  recordSuccess(): Promise<void>;
}

export interface ModelFailureDependencies {
  db: Database;
  clock: Clock;
  alerts: AlertService;
}

/** Сбои модели подряд по всем людям сразу: модель лежит у всех, а не у одного разговора. */
export function createModelFailureTracker({ db, clock, alerts }: ModelFailureDependencies): ModelFailureTracker {
  return {
    async recordFailure(reason) {
      const now = clock.now();
      const [health] = await db
        .insert(modelHealth)
        .values({ id: 1, consecutiveFailures: 1, lastError: reason, lastFailureAt: now })
        .onConflictDoUpdate({
          target: modelHealth.id,
          set: { consecutiveFailures: sql`${modelHealth.consecutiveFailures} + 1`, lastError: reason, lastFailureAt: now },
        })
        .returning();
      if (health!.consecutiveFailures < MODEL_FAILURES_ALERT_AFTER) return;
      await alerts.raise(
        "model_failures",
        `Модель консультанта не отвечает, сбоев подряд: ${health!.consecutiveFailures}. Люди получают ответы с задержкой, ходы повторяются сами.\nПоследняя ошибка: ${reason}`,
      );
    },

    async recordSuccess() {
      const reset = await db
        .update(modelHealth)
        .set({ consecutiveFailures: 0 })
        .where(sql`${modelHealth.consecutiveFailures} > 0`)
        .returning({ id: modelHealth.id });
      if (reset.length > 0) await alerts.resolve("model_failures");
    },
  };
}

/** Строка SDK о провайдере, отказавшем всем ходам: пустой счёт или непринятый ключ (с 0.58 ходы идут через запасной). */
const PROVIDER_OUTAGE_LINE = /^\[ВНИМАНИЕ провайдер\] ([^:\s]+): (.+)$/;

/**
 * Журнал службы чата: строка «[ВНИМАНИЕ провайдер] deepseek: кончились деньги — …» — ещё и тревога эксперту, раз в сутки
 * на провайдер. Деньги или ключ чинит человек: пока он не узнал, ходы идут дороже через запасной или падают.
 */
export function providerOutageAlerts({ clock, alerts }: Pick<ModelFailureDependencies, "clock" | "alerts">): (line: string) => void {
  return (line) => {
    const outage = line.match(PROVIDER_OUTAGE_LINE);
    if (!outage) return;
    const [, providerId, said] = outage;
    void alerts
      .raise("provider_outage", `Провайдер модели ${providerId}: ${said}.\nПополните счёт или замените ключ.`, `${providerId}:${clock.mskDate()}`)
      .catch((error) => console.error("Тревога о провайдере не отправлена:", error instanceof Error ? error.message : error));
  };
}
