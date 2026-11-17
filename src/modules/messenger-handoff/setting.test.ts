import { describe, expect, it } from "vitest";
import { leadMagnetSettingsSchema, newLeadMagnetSettings, validateLeadMagnetSettings } from "../lead-magnets/settings";
import { DEFAULT_MESSENGER_HANDOFF, enabledMessengerHandoff, messengerHandoffSchema } from "./setting";

describe("настройка «Переход в мессенджер»", () => {
  it("выключена по умолчанию; старые настройки без поля читаются", () => {
    expect(DEFAULT_MESSENGER_HANDOFF.enabled).toBe(false);
    const settings = newLeadMagnetSettings("Тест");
    expect(leadMagnetSettingsSchema.parse(settings).messengerHandoff).toBeUndefined();
    expect(enabledMessengerHandoff(settings)).toBeNull();
  });

  it("включённой нужны «когда предложить» и хотя бы один мессенджер", () => {
    expect(messengerHandoffSchema.safeParse({ enabled: true, when: " ", channels: ["telegram"] }).success).toBe(false);
    expect(messengerHandoffSchema.safeParse({ enabled: true, when: "После знакомства", channels: [] }).success).toBe(false);
    expect(messengerHandoffSchema.safeParse({ enabled: false, when: "", channels: [] }).success).toBe(true);
  });

  it("мессенджеры — по порядку списка, без повторов и без веб-чата", () => {
    expect(messengerHandoffSchema.parse({ enabled: true, when: "Когда согласился", channels: ["vk", "telegram"] }).channels).toEqual(["telegram", "vk"]);
    expect(messengerHandoffSchema.safeParse({ enabled: true, when: "Когда согласился", channels: ["web"] }).success).toBe(false);
  });

  it("включённая настройка доходит до агента; ошибка — в проверке публикации", () => {
    const settings = { ...newLeadMagnetSettings("Тест"), messengerHandoff: { enabled: true, when: "Когда согласился", channels: ["telegram" as const] } };
    expect(enabledMessengerHandoff(settings)).toEqual(settings.messengerHandoff);
    const broken = { ...settings, messengerHandoff: { enabled: true, when: "", channels: ["telegram" as const] } };
    expect(() => validateLeadMagnetSettings(broken)).toThrow(/Переход в мессенджер/);
  });
});
