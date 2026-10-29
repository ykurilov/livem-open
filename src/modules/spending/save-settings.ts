import { readSettings, updateSettings, type AppSettingsChanges } from "../platform/settings";
import { checkBudget, type BudgetCheckDependencies } from "./budget";
import { resumeDailyLimitedPassages } from "./daily-limit";

/**
 * Эксперт сохранил настройки денег. Поднятый дневной лимит сразу отпускает отложенные до утра разговоры;
 * поднятый бюджет прекращает повтор тревоги и снимает аварийную остановку, не дожидаясь `budget-check`.
 * Ошибка этих шагов не отменяет сохранения: утренняя задача и `budget-check` подберут то же самое позже.
 */
export async function saveSpendingSettings(deps: BudgetCheckDependencies, changes: AppSettingsChanges): Promise<void> {
  const before = await readSettings(deps.db);
  await updateSettings(deps.db, changes);

  const limitRaised = changes.dailyLimitUsd !== undefined && Number(changes.dailyLimitUsd) > Number(before.dailyLimitUsd);
  try {
    if (limitRaised) await resumeDailyLimitedPassages(deps);
    await checkBudget(deps);
  } catch (error) {
    console.error("Шаги после сохранения настроек не удались:", error instanceof Error ? error.message : error);
  }
}
