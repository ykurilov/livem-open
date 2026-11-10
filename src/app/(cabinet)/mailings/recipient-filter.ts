import { parsePeopleFilter, type PeopleFilter } from "@/modules/people";
import { filterFromSearchParams, type SearchParams } from "../people/filter-params";
import { ALL_PEOPLE_PARAM } from "../people/filter-url";

const FILTER_KEYS = ["bot", "lead", "link", "status", "fields", ALL_PEOPLE_PARAM];

const BROKEN_FILTER = "Фильтр в адресе испорчен — выберите получателей заново и нажмите «Показать». Пока отправить нельзя.";

/**
 * Получатели черновика: фильтр в адресе — то, что эксперт только что выбрал; без него — сохранённый в черновике.
 * Испорченный фильтр в адресе — `broken`: остаётся сохранённый, а не вся база, и отправка закрыта, пока эксперт не выберет заново.
 */
export function recipientFilter(params: SearchParams, saved: unknown | null): { filter: PeopleFilter; error?: string; broken: boolean } {
  const fromUrl = FILTER_KEYS.some((key) => params[key] !== undefined);
  const savedFilter = saved === null ? {} : parsePeopleFilter(saved);
  if (!fromUrl) return { filter: savedFilter, broken: false };
  const { filter, error } = filterFromSearchParams(params);
  return error ? { filter: savedFilter, error: BROKEN_FILTER, broken: true } : { filter, broken: false };
}
