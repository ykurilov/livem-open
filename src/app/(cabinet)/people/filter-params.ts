import { InvalidPeopleFilterError, parsePeopleFilter, type PeopleFilter } from "@/modules/people";

export { searchParamsFromFilter } from "./filter-url";

export type SearchParams = Record<string, string | string[] | undefined>;

const list = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Фильтр базы из адреса страницы: `bot`, `lead`, `link`, `status`, `fields` (условия по полям в JSON). */
export function filterFromSearchParams(params: SearchParams): { filter: PeopleFilter; error?: string } {
  try {
    const fields = list(params.fields)[0];
    const filter = parsePeopleFilter({
      botIds: list(params.bot),
      leadMagnetIds: list(params.lead),
      linkIds: list(params.link),
      statuses: list(params.status),
      ...(fields && { fieldConditions: JSON.parse(fields) }),
    });
    return { filter };
  } catch (error) {
    if (error instanceof InvalidPeopleFilterError || error instanceof SyntaxError)
      return { filter: {}, error: "Фильтр в адресе испорчен — показана вся база." };
    throw error;
  }
}

/** Дальше страниц не бывает: 50 × 100 000 = 5 млн человек. */
const MAX_PAGE = 100_000;

export function pageFromSearchParams(params: SearchParams): number {
  const page = Number(list(params.page)[0]);
  return Number.isSafeInteger(page) && page > 1 ? Math.min(page, MAX_PAGE) : 1;
}
