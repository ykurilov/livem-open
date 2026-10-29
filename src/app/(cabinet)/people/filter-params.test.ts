import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PeopleFilter } from "@/modules/people";
import { filterFromSearchParams, pageFromSearchParams, searchParamsFromFilter } from "./filter-params";

describe("фильтр базы в адресе страницы", () => {
  it("туда и обратно без потерь", () => {
    const filter: PeopleFilter = {
      botIds: [randomUUID()],
      leadMagnetIds: [randomUUID()],
      linkIds: [randomUUID()],
      statuses: ["completed"],
      fieldConditions: [{ fieldId: randomUUID(), kind: "number", min: 5 }],
    };
    const params = Object.fromEntries(searchParamsFromFilter(filter, 2));
    expect(filterFromSearchParams(params)).toEqual({ filter });
    expect(pageFromSearchParams(params)).toBe(2);
  });

  it("испорченный адрес — вся база и пояснение", () => {
    expect(filterFromSearchParams({ fields: "{не json" })).toMatchObject({ filter: {}, error: expect.any(String) });
    expect(filterFromSearchParams({ bot: "not-a-uuid" })).toMatchObject({ filter: {}, error: expect.any(String) });
    expect(pageFromSearchParams({ page: "-3" })).toBe(1);
  });
});
