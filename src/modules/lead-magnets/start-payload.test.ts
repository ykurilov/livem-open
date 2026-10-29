import { describe, expect, it } from "vitest";
import { ENTRY_LABEL_LIMIT, ENTRY_LABEL_SEPARATOR, parseLabeledStartPayload, START_PAYLOAD_LIMIT } from "./start-payload";

const code = "69diuTcj";
const prefix = `${code}${ENTRY_LABEL_SEPARATOR}`;

describe("рекламный стартовый параметр", () => {
  it("фиксированный namespace оставляет 41 символ метки при любой допустимой длине", () => {
    expect(ENTRY_LABEL_SEPARATOR.length).toBe(15);
    for (let length = 1; length <= ENTRY_LABEL_LIMIT; length++) {
      const payload = prefix + "a".repeat(length);
      expect(payload.length).toBeGreaterThan(22);
      expect(payload.length).toBeLessThanOrEqual(START_PAYLOAD_LIMIT);
      expect(parseLabeledStartPayload(payload)).toEqual({ code, label: "a".repeat(length) });
    }
  });

  it("метка из 12 символов допустима, регистр нормализуется, дефис и подчёркивание сохраняются", () => {
    expect(parseLabeledStartPayload(prefix + "Video_01-ABC")).toEqual({ code, label: "video_01-abc" });
    expect(parseLabeledStartPayload(prefix + "a".repeat(12))).toEqual({ code, label: "a".repeat(12) });
  });

  it.each(["", "a".repeat(42), "кириллица", "x y", "x\n", "x\r", "x\t", "x%20", "x?y", "x/y", "x&y", "😀"])(
    "невалидная метка %s сохраняет базовый код без метки", (label) => {
      expect(parseLabeledStartPayload(prefix + label)).toEqual({ code, label: null });
    },
  );

  it("огромный параметр не разбирает за пределами префикса и возвращает базовый код", () => {
    expect(parseLabeledStartPayload(prefix + "a".repeat(100_000))).toEqual({ code, label: null });
  });

  it.each([code, `${code}__video_01`, "1234567__ad_campaign__a", "123456789__ad_campaign__a", "/start " + prefix + "a", "69diuTcj__AD_CAMPAIGN__a", "k3_9Zq-LmP0aXvB7nR2sTw", "Ab3dE5gH__abcdefghijkl"])(
    "не принимает старый короткий формат, команды или чужие коды: %s", (payload) => {
      expect(parseLabeledStartPayload(payload)).toBeNull();
    },
  );
});
