import { describe, expect, it } from "vitest";
import { sourcesHref, sourcesViewFromSearchParams } from "./sources-params";

// 17 ноября, 23:30 по Москве
const NOW = new Date("2026-11-17T20:30:00Z");
const LEAD = "6f1c2b9e-1d3a-4c5b-8e7f-0a1b2c3d4e5f";

describe("адрес «Откуда пришли»", () => {
  it("по умолчанию — 30 дней по всем лидмагнитам", () => {
    expect(sourcesViewFromSearchParams({}, NOW)).toEqual({ period: "30", sinceDay: "2026-10-19" });
  });

  it("период и лидмагнит из адреса; «всё время» — без начала", () => {
    expect(sourcesViewFromSearchParams({ period: "7", lead: LEAD }, NOW)).toEqual({ period: "7", leadMagnetId: LEAD, sinceDay: "2026-11-11" });
    expect(sourcesViewFromSearchParams({ period: "all" }, NOW)).toEqual({ period: "all", sinceDay: null });
  });

  it("дни — календарные по Москве: за полночь по Москве период сдвигается, хотя в UTC ещё вчера", () => {
    // 18 ноября, 00:30 по Москве
    expect(sourcesViewFromSearchParams({ period: "7" }, new Date("2026-11-17T21:30:00Z")).sinceDay).toBe("2026-11-12");
  });

  it("испорченный адрес — значения по умолчанию, без падения", () => {
    expect(sourcesViewFromSearchParams({ period: "1000", lead: "не-id" }, NOW)).toEqual({ period: "30", sinceDay: "2026-10-19" });
    expect(sourcesViewFromSearchParams({ period: ["7", "90"], lead: [LEAD, LEAD] }, NOW)).toMatchObject({ period: "7", leadMagnetId: LEAD });
  });

  it("адрес собирается обратно; значения по умолчанию в адрес не пишутся", () => {
    expect(sourcesHref({ period: "30" })).toBe("/people/sources");
    expect(sourcesHref({ period: "90", leadMagnetId: LEAD })).toBe(`/people/sources?period=90&lead=${LEAD}`);
  });
});
