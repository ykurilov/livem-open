import { describe, expect, it } from "vitest";
import current from "../../../docs/lead-magnets/first-app.json";
import previous from "../../../docs/lead-magnets/history/first-app-six-states.json";
import { firstAppConfirmations, FIRST_APP_ID, OWN_PUBLISHED, OWN_APP_CRITERION } from "./first-app-confirmations";
import { FIRST_APP_STATE_MAP } from "./first-app-rollout";

const state = (id: string) => current.flow.states.find((s) => s.id === id)!;
const old = (id: string) => previous.flow.states.find((s) => s.id === id)!;

describe("четыре рабочие задачи first-app", () => {
  it("четыре задачи и два окончания; result отделяет новый контракт от legacy", () => {
    expect(current.flow.states.map((s) => [s.id, s.title])).toEqual([
      ["idea", "Идея"], ["build", "Сборка"], ["result", "Результат"], ["course", "Курс"], ["final", "Итог"], ["deadline", "Срок вышел"],
    ]);
    expect(FIRST_APP_STATE_MAP).toEqual({ first_version: "idea", publish: "result", polish: "result" });
    const ids = new Set(current.flow.states.map((s) => s.id));
    for (const s of current.flow.states) for (const exit of "exits" in s ? s.exits ?? [] : []) expect(ids.has(exit.to)).toBe(true);
  });
  it("вне состояний контракт не менялся: общие инструкции, отказ, покупки, тексты, карточка, любые переходы, сроки и касания", () => {
    const { flow, ...settings } = current;
    const { flow: before, ...oldSettings } = previous;
    expect(settings).toEqual(oldSettings);
    const { states: _, ...controls } = flow;
    const { states: __, ...oldControls } = before;
    expect(controls).toEqual(oldControls);
    expect(state("course")).toEqual({ ...old("course"), title: "Курс" });
    expect(state("final")).toEqual(old("final"));
    expect(state("deadline")).toEqual(old("deadline"));
  });
  it("«Идея» передаёт готовый запрос/ссылку; одного выбора вида недостаточно", () => {
    const idea = state("idea");
    expect(idea.instructions).toContain(old("idea").instructions.split("\n")[1]!);
    expect(idea.instructions).toContain(old("first_version").instructions.split("\n")[1]!);
    expect(idea.exits![0]).toMatchObject({ id: "idea_done", to: "build", when: { type: "judge", text: expect.stringMatching(/Одного выбора идеи.*недостаточно/) } });
    expect(idea.exits![0]!.when).toMatchObject({ text: expect.stringContaining("получил ссылку с готовым запросом") });
  });
  it("«Результат» разрешает правки до/после публикации, но успех — только собственное опубликованное приложение", () => {
    const result = state("result");
    expect(result.instructions).toMatch(/Проверка, правки и публикация могут идти в любом естественном порядке/);
    expect(result.instructions).toContain(old("publish").instructions.split("\n")[1]!);
    expect(result.instructions).toMatch(/Собранное превью, адрес редактора, чужое приложение.*не подтверждают/);
    expect(result.instructions).toMatch(/запись «опубликовал» в карточке.*не доказывают принадлежность/);
    expect(result.instructions).toMatch(/не проси ссылку повторно/);
    const gate = result.exits![0]!;
    expect(gate).toMatchObject({ id: "polish_done", to: "course", when: { type: "judge" } });
    expect(gate.when).toEqual(old("polish").exits![0]!.when);
    const registered = firstAppConfirmations();
    expect(registered.confirmations[0]).toMatchObject({ ...OWN_PUBLISHED, states: ["result"], judge: OWN_APP_CRITERION });
    expect(registered.exitGuards).toEqual([{ flowId: FIRST_APP_ID, state: "result", exitId: "polish_done", requires: OWN_PUBLISHED, judgeWindow: "current-human-turn" }]);
    expect(OWN_APP_CRITERION.length).toBeLessThanOrEqual(800);
  });
  it("каждая рабочая нода до курса сохраняет timer третьего дня, общий deadline и потолки касаний прежние", () => {
    for (const id of ["idea", "build", "result"]) {
      expect(state(id).exits!.find((e) => e.id === `${id}_day3`)).toEqual({ ...old(id === "result" ? "publish" : id).exits!.find((e) => e.id === `${id === "result" ? "publish" : id}_day3`), id: `${id}_day3` });
      expect("nudges" in state(id) ? state(id).nudges : undefined).toEqual("nudges" in old(id === "result" ? "publish" : id) ? old(id === "result" ? "publish" : id).nudges : undefined);
    }
    expect(state("build").exits).toEqual(old("build").exits!.map(e => ({ ...e, to: e.to === "publish" ? "result" : e.to })));
    expect(current.flow.schedule).toEqual(previous.flow.schedule);
  });
});
