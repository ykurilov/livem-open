import { describe, expect, it } from "vitest";
import { newLeadMagnetSettings } from "@/modules/lead-magnets/settings";
import { combineUnsavedEdits, rebaseSettingsEdit } from "./unsaved-edits";

const saved = () => structuredClone(newLeadMagnetSettings("Разбор"));

describe("обе правки сразу: «Настройки» и «Сценарий»", () => {
  it("настройки берутся из формы, сценарий — с доски", () => {
    const settings = { ...saved(), firstMessage: "Привет из формы" };
    const board = { ...saved().flow, states: saved().flow.states.slice(1), layout: { a: { x: 1, y: 2 } } };
    const combined = combineUnsavedEdits(saved(), settings, board);
    expect(combined.settings.firstMessage).toBe("Привет из формы");
    expect(combined.flow).toEqual(board);
  });

  it("основную инструкцию меняли только на доске — она остаётся с доски", () => {
    const board = { ...saved().flow, common: "Общее с доски" };
    expect(combineUnsavedEdits(saved(), saved(), board).flow.common).toBe("Общее с доски");
  });

  it("основную инструкцию меняли в «Настройках» — она из формы, остальной сценарий с доски", () => {
    const settings = saved();
    settings.flow = { ...settings.flow, common: "Общее из формы" };
    const board = { ...saved().flow, common: "Общее с доски", layout: { a: { x: 1, y: 2 } } };
    const combined = combineUnsavedEdits(saved(), settings, board);
    expect(combined.flow.common).toBe("Общее из формы");
    expect(combined.flow.layout).toEqual({ a: { x: 1, y: 2 } });
  });
});

describe("правка «Настроек» поверх новой версии черновика", () => {
  it("набранное остаётся, нетронутые поля — из новой версии", () => {
    const base = saved();
    const edited = { ...saved(), cardDescription: "Из формы" };
    const latest = { ...saved(), farewellMessage: "Из новой версии" };
    latest.flow = { ...latest.flow, states: latest.flow.states.slice(1) };
    const rebased = rebaseSettingsEdit(base, edited, latest);
    expect(rebased.settings.cardDescription).toBe("Из формы");
    expect(rebased.settings.farewellMessage).toBe("Из новой версии");
    expect(rebased.settings.flow).toEqual(latest.flow);
    expect(rebased.conflicts).toEqual([]);
  });

  it("основная инструкция из формы ложится на новый сценарий", () => {
    const edited = saved();
    edited.flow = { ...edited.flow, common: "Общее из формы" };
    const latest = saved();
    latest.flow = { ...latest.flow, states: latest.flow.states.slice(1) };
    const rebased = rebaseSettingsEdit(saved(), edited, latest);
    expect(rebased.settings.flow).toEqual({ ...latest.flow, common: "Общее из формы" });
    expect(rebased.conflicts).toEqual([]);
  });

  it("поле поменяли и в форме, и в новой версии — в форме правка эксперта, поле названо", () => {
    const edited = { ...saved(), name: "Из формы" };
    edited.flow = { ...edited.flow, common: "Общее из формы" };
    const latest = { ...saved(), name: "Из новой версии" };
    latest.flow = { ...latest.flow, common: "Общее из новой версии" };
    const rebased = rebaseSettingsEdit(saved(), edited, latest);
    expect(rebased.settings.name).toBe("Из формы");
    expect(rebased.settings.flow.common).toBe("Общее из формы");
    expect(rebased.conflicts.sort()).toEqual(["common", "name"]);
  });

  it("одинаковая правка с обеих сторон — не расхождение", () => {
    const edited = { ...saved(), name: "Одно и то же" };
    const latest = { ...saved(), name: "Одно и то же" };
    expect(rebaseSettingsEdit(saved(), edited, latest).conflicts).toEqual([]);
  });
});
