import type { AppSettingsChanges } from "../platform/settings";

type SpendingSettingsChanges = Required<
  Pick<AppSettingsChanges, "dailyLimitUsd" | "monthlyBudgetUsd" | "privacyPolicyUrl" | "alertChatId">
>;

export type ParsedSpendingSettings = { ok: true; changes: SpendingSettingsChanges } | { ok: false; error: string };

interface FormLike {
  get(name: string): unknown;
}

const textOf = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

const MICROS_PER_USD = 1_000_000n;
/** Пределы сумм в настройках: меньше цента лимит бессмыслен, миллион не влезает в `numeric(12,6)`. */
const MIN_USD_MICROS = 10_000n; // $0.01
const MAX_USD_MICROS = 1_000_000n * MICROS_PER_USD; // $1 000 000, не включая

/**
 * Сумма в долларах строкой для `numeric(12,6)`: округление до 6 знаков без плавающей точки, в границах
 * [$0.01; $1 000 000). Не сумма или вне границ — `null`.
 */
function parseUsd(text: string): string | null {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(7, "0");
  const roundUp = Number(fraction[6]) >= 5 ? 1n : 0n;
  const micros = BigInt(match[1]!) * MICROS_PER_USD + BigInt(fraction.slice(0, 6)) + roundUp;
  if (micros < MIN_USD_MICROS || micros >= MAX_USD_MICROS) return null;
  return `${micros / MICROS_PER_USD}.${String(micros % MICROS_PER_USD).padStart(6, "0")}`;
}

const USD_RANGE = "от 0.01 до 1 000 000 (не включая)";

/** Форма экрана «Настройки»: дневной лимит, месячный бюджет, политика, адресат тревог. */
export function parseSpendingSettings(form: FormLike): ParsedSpendingSettings {
  const dailyLimitUsd = parseUsd(textOf(form, "dailyLimitUsd"));
  if (!dailyLimitUsd) return { ok: false, error: `Дневной лимит — сумма в долларах ${USD_RANGE}, например 1 или 0.5` };

  const budgetText = textOf(form, "monthlyBudgetUsd");
  const monthlyBudgetUsd = budgetText ? parseUsd(budgetText) : null;
  if (budgetText && !monthlyBudgetUsd)
    return { ok: false, error: `Месячный бюджет — сумма в долларах ${USD_RANGE} или пусто, если бюджета нет` };

  const privacyPolicyUrl = textOf(form, "privacyPolicyUrl") || null;
  if (privacyPolicyUrl && !/^https?:\/\/\S+$/.test(privacyPolicyUrl))
    return { ok: false, error: "Ссылка на политику — полный адрес, начиная с https://" };

  const alertChatId = textOf(form, "alertChatId") || null;
  if (alertChatId && !/^(-?\d+|@\w{5,})$/.test(alertChatId))
    return { ok: false, error: "Адресат тревог — номер чата Telegram (например, -1001234567890) или @имя канала" };

  return { ok: true, changes: { dailyLimitUsd, monthlyBudgetUsd, privacyPolicyUrl, alertChatId } };
}

/** Доллары для экрана: центы, а у сумм меньше доллара — доли цента. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 1 ? 3 : 2)}`;
}
