// Без серверного кода: адрес фильтра собирает и форма в браузере
import type { PeopleFilter } from "@/modules/people";

/** Пустой фильтр, выбранный явно, — `?all=1`: иначе черновик рассылки принял бы его за первое открытие и взял сохранённый. */
export const ALL_PEOPLE_PARAM = "all";

/** `arrivedLink` у пришедших без ссылки. */
export const ARRIVED_WITHOUT_LINK = "none";

/** Адрес страницы для фильтра; обратное к `filterFromSearchParams`. */
export function searchParamsFromFilter(filter: PeopleFilter, page = 1): URLSearchParams {
  const params = new URLSearchParams();
  for (const id of filter.botIds ?? []) params.append("bot", id);
  for (const id of filter.leadMagnetIds ?? []) params.append("lead", id);
  for (const id of filter.linkIds ?? []) params.append("link", id);
  for (const status of filter.statuses ?? []) params.append("status", status);
  if (filter.fieldConditions?.length) params.set("fields", JSON.stringify(filter.fieldConditions));
  if (filter.arrival) {
    params.set("arrivedLead", filter.arrival.leadMagnetId);
    params.set("arrivedLink", filter.arrival.linkId ?? ARRIVED_WITHOUT_LINK);
    if (filter.arrival.sinceDay) params.set("arrivedSince", filter.arrival.sinceDay);
  }
  if (page > 1) params.set("page", String(page));
  return params;
}
