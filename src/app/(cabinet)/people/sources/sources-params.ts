// Без серверного кода: адрес собирает и выбор периода в браузере
import { isUuid } from "@/modules/platform/uuid";

export const SOURCE_PERIODS = ["7", "30", "90", "all"] as const;
export type SourcePeriod = (typeof SOURCE_PERIODS)[number];

export const SOURCE_PERIOD_LABELS: Record<SourcePeriod, string> = { "7": "7 дней", "30": "30 дней", "90": "90 дней", all: "Всё время" };

const DEFAULT_PERIOD: SourcePeriod = "30";
const DAY_MS = 24 * 60 * 60 * 1000;
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

export interface SourcesView {
  period: SourcePeriod;
  leadMagnetId?: string;
  /** Первый день периода по Москве (`YYYY-MM-DD`): «7 дней» — сегодня и шесть дней до него. `null` — всё время. */
  sinceDay: string | null;
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const isPeriod = (value: string | undefined): value is SourcePeriod => SOURCE_PERIODS.includes(value as SourcePeriod);

/** Период и лидмагнит из адреса: `period` (7, 30, 90, all), `lead`. Испорченное — по умолчанию: 30 дней, все лидмагниты. */
export function sourcesViewFromSearchParams(params: Record<string, string | string[] | undefined>, now: Date): SourcesView {
  const asked = first(params.period);
  const period = isPeriod(asked) ? asked : DEFAULT_PERIOD;
  const lead = first(params.lead);
  return {
    period,
    ...(lead && isUuid(lead) && { leadMagnetId: lead }),
    sinceDay: period === "all" ? null : new Date(now.getTime() + MSK_OFFSET_MS - (Number(period) - 1) * DAY_MS).toISOString().slice(0, 10),
  };
}

/** Адрес экрана; обратное к `sourcesViewFromSearchParams`. */
export function sourcesHref(view: { period: SourcePeriod; leadMagnetId?: string }): string {
  const params = new URLSearchParams();
  if (view.period !== DEFAULT_PERIOD) params.set("period", view.period);
  if (view.leadMagnetId) params.set("lead", view.leadMagnetId);
  const query = params.toString();
  return query ? `/people/sources?${query}` : "/people/sources";
}
