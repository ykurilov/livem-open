import { describe, expect, it } from "vitest";
import previous from "../../../docs/lead-magnets/history/first-app-six-states.json";
import { FIRST_APP_FIELDS, firstAppSettings } from "./first-app.fixture";
import { completeFlowJson } from "./flow-settings";
import { leadMagnetToFlow } from "./settings-to-flow";
import { historicalPublicationProof } from "./first-app-rollout";

const flow = completeFlowJson({ ...previous.flow, clientCard: [], sideTasks: [] }, leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS));
const start = { at: 1000, state: "idea", from: null, exitId: null, decidedBy: "start" };
const checked = { at: 2000, state: "polish", from: "publish", exitId: "publish_done", decidedBy: "judge" };
const run = { startedAt: 1000, state: "polish", path: [start, checked] };
describe("инвентаризация исторического proof: не импортировать имя ноды или карточку модели", () => {
  it.each(["judge", "claim"])("checked publish_done %s без versionId перехода остаётся неоднозначным кандидатом", (decidedBy) => {
    expect(historicalPublicationProof({ ...run, path: [start, { ...checked, decidedBy }] }, flow, 500)).toEqual({ kind: "ambiguous", reason: "unversioned_checked_publish_done" });
  });
  it.each(["timer", "event", "tool", "data", "migrate"])("не доверяет обходу %s", (decidedBy) => {
    expect(historicalPublicationProof({ ...run, path: [start, { ...checked, decidedBy }] }, flow, 500).kind).toBe("ambiguous");
  });
  it("имя polish, карточка опубликовал, обрезанный path или путь с предыдущей миграцией не доказательство", () => {
    for (const candidate of [
      { state: "polish", card: { outcome: "опубликовал" } },
      { ...run, path: [checked] },
      { ...run, path: [start, checked, { ...checked, decidedBy: "migrate", exitId: null }] },
      { ...run, path: [start, { ...checked, from: "build" }] },
    ]) expect(historicalPublicationProof(candidate, flow, 500).kind).toBe("ambiguous");
    expect(historicalPublicationProof(run, flow, 1500).kind).toBe("ambiguous");
  });
  it("тот же exitId в другой версии/с другим условием не доказательство", () => {
    const changed = structuredClone(flow) as { states: Array<{ id: string; exits: Array<{ id: string; when: unknown }> }> };
    changed.states.find((s) => s.id === "publish")!.exits[0]!.when = { type: "judge", text: "Прислал любую ссылку" };
    expect(historicalPublicationProof(run, changed, 500).kind).toBe("ambiguous");
  });
});
