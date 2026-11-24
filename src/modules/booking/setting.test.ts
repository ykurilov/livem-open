import { describe, expect, it } from "vitest";
import { LEAD_MAGNET_EVENTS, leadMagnetFlowCatalog } from "../flows/catalog";
import { leadMagnetSettingsSchema, newLeadMagnetSettings, validateLeadMagnetSettings } from "../lead-magnets/settings";
import { CALL_BOOKED_EVENT, DEFAULT_CALL_BOOKING, callBookingSchema, enabledCallBooking } from "./setting";

const on = { enabled: true, when: "Когда человек готов обсудить работу", about: "", meetingLink: "" };

describe("настройка «Запись на созвон»", () => {
  it("выключена по умолчанию; старые настройки без поля читаются", () => {
    expect(DEFAULT_CALL_BOOKING.enabled).toBe(false);
    const settings = newLeadMagnetSettings("Тест");
    expect(leadMagnetSettingsSchema.parse(settings).callBooking).toBeUndefined();
    expect(enabledCallBooking(settings)).toBeNull();
  });

  it("включённой нужно «когда предложить»; ссылка на встречу — адрес сайта или пусто", () => {
    expect(callBookingSchema.safeParse({ ...on, when: " " }).success).toBe(false);
    expect(callBookingSchema.safeParse({ ...on, meetingLink: "мой зум" }).success).toBe(false);
    expect(callBookingSchema.parse({ ...on, meetingLink: " https://zoom.us/j/1 " }).meetingLink).toBe("https://zoom.us/j/1");
    expect(callBookingSchema.safeParse({ enabled: false, when: "", about: "", meetingLink: "" }).success).toBe(true);
  });

  it("включённая настройка доходит до агента; ошибка — в проверке публикации", () => {
    const settings = { ...newLeadMagnetSettings("Тест"), callBooking: on };
    expect(enabledCallBooking(settings)).toEqual(on);
    expect(() => validateLeadMagnetSettings({ ...settings, callBooking: { ...on, when: "" } })).toThrow(/Запись на созвон/);
  });

  it("событие сценария «Записался на созвон» есть в каталоге", () => {
    expect(CALL_BOOKED_EVENT).toBe(LEAD_MAGNET_EVENTS.callBooked);
    expect(leadMagnetFlowCatalog([]).events).toContainEqual({ name: CALL_BOOKED_EVENT, label: "Записался на созвон" });
  });
});
