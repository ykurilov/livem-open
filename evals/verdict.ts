// Итог прогона и повторов. Успех — ни одного ❌ в проверках кодом. Сломанный стенд (провайдер, база, маршрут персонажей)
// и сбой персонажа — не про агента: такие повторы показываются отдельно и в знаменатель k/N не идут.
import { SCENARIO_KINDS, SCENARIO_SETS, type ScenarioKind, type ScenarioSet } from "./scenario";
import type { CheckResult, ScenarioOutcome, ScenarioRun } from "./types";

/** `persona` — персонаж вышел из роли, `stand` — сломан стенд. */
export type RunVerdict = "pass" | "fail" | "persona" | "stand";

/** Ответ провайдера, а не ошибка запроса агента: деньги, лимиты, перегрузка, сеть, ключ. */
const PROVIDER_FAILURE = /credit|insufficient|balance|quota|rate.?limit|too many requests|\b(?:401|402|429|500|502|503|504)\b|overloaded|unavailable|timed? ?out|timeout|ECONN\w*|fetch failed|socket|invalid.?(?:api.?)?key|unauthori[sz]ed/i;
/** Персонаж не ответил — сбой модели персонажей; ошибки вида запроса SDK, которые не про агента. */
const PERSONA_OR_PROVIDER_ERROR = /Персонаж не ответил|\((?:overloaded|rate_limited|insufficient_funds|invalid_key)\)/;
/** После разговора: на ход и оценку не влияет. */
const AFTER_RUN = /^Удаление базы:/;

export function standCheck(run: ScenarioRun): CheckResult {
  const problems = [
    ...run.runnerErrors.filter((line) => !AFTER_RUN.test(line)).map((line) => `прогон: ${line}`),
    ...run.agentLogErrors.filter((line) => line.startsWith("модель ") && PROVIDER_FAILURE.test(line)).map((line) => `провайдер без запасного пути: ${line}`),
    ...(run.building.error && PERSONA_OR_PROVIDER_ERROR.test(run.building.error) ? [`эксперт: ${run.building.error}`] : []),
    ...run.clients.filter((client) => client.error && PERSONA_OR_PROVIDER_ERROR.test(client.error)).map((client) => `клиент ${client.index}: ${client.error}`),
  ];
  const route = run.personaRoute;
  if (route && route.offRoute > 0)
    problems.push(`персонажам отвечал не только ${route.provider}: ${Object.entries(route.served).map(([name, count]) => `${name} ${count}`).join(", ")}`);
  return { id: "stand_ok", title: "Стенд работал", subject: "сценарий", status: problems.length ? "stand_broke" : "pass", details: problems.join("\n") };
}

export function verdictOf(checks: CheckResult[]): RunVerdict {
  const has = (status: CheckResult["status"]) => checks.some((check) => check.status === status);
  return has("stand_broke") ? "stand" : has("persona_broke") ? "persona" : has("fail") ? "fail" : "pass";
}

/** Повтор, который упал целиком и не дал результата. */
export interface CrashedRepeat {
  id: string;
  kind?: ScenarioKind;
  set?: ScenarioSet;
  repeat?: number;
  error: string;
}

export interface ScenarioTally {
  id: string;
  kind: ScenarioKind | "—";
  set: ScenarioSet | "—";
  /** Успешных из засчитанных. */
  passed: number;
  /** Засчитанных: без сломанного стенда и сбоя персонажа. */
  counted: number;
  persona: number;
  stand: number;
  /** pass^N: все N повторов засчитаны и успешны. `null` — засчитано меньше N без провала: не известно. */
  passAll: boolean | null;
  verdicts: Array<{ repeat: number; verdict: RunVerdict }>;
}

export interface KindTally {
  kind: ScenarioKind | "—";
  scenarios: number;
  passed: number;
  counted: number;
  persona: number;
  stand: number;
  /** Сценариев, прошедших все N раз, из тех, где это известно. */
  passAll: number;
  passAllKnown: number;
}

export interface SetTally extends Omit<KindTally, "kind"> {
  set: ScenarioSet | "—";
}

export function tallyRepeats(outcomes: ScenarioOutcome[], crashed: CrashedRepeat[], repeats: number): { scenarios: ScenarioTally[]; kinds: KindTally[]; sets: SetTally[] } {
  const byId = new Map<string, ScenarioTally>();
  const entry = (id: string, kind: ScenarioKind | undefined, set: ScenarioSet | undefined) => {
    const found = byId.get(id) ?? { id, kind: kind ?? "—", set: set ?? "—", passed: 0, counted: 0, persona: 0, stand: 0, passAll: null, verdicts: [] };
    byId.set(id, found);
    return found;
  };
  const add = (tally: ScenarioTally, repeat: number, verdict: RunVerdict) => {
    tally.verdicts.push({ repeat, verdict });
    if (verdict === "stand") tally.stand += 1;
    else if (verdict === "persona") tally.persona += 1;
    else {
      tally.counted += 1;
      if (verdict === "pass") tally.passed += 1;
    }
  };
  for (const outcome of outcomes) add(entry(outcome.run.scenario.id, outcome.run.scenario.kind, outcome.run.scenario.set), outcome.repeat ?? 1, verdictOf(outcome.checks));
  for (const crash of crashed) add(entry(crash.id, crash.kind, crash.set), crash.repeat ?? 1, "stand");

  const scenarios = [...byId.values()];
  for (const tally of scenarios) {
    tally.verdicts.sort((a, b) => a.repeat - b.repeat);
    tally.passAll = tally.passed < tally.counted ? false : tally.counted >= repeats ? true : null;
  }
  const order = <T extends string>(known: readonly T[]) => (key: T | "—") => (key === "—" ? known.length : known.indexOf(key));
  const kindOrder = order(SCENARIO_KINDS);
  const setOrder = order(SCENARIO_SETS);
  const kinds = rollUp(scenarios, (tally) => tally.kind).map(({ key, ...sums }): KindTally => ({ kind: key, ...sums }));
  const sets = rollUp(scenarios, (tally) => tally.set).map(({ key, ...sums }): SetTally => ({ set: key, ...sums }));
  return { scenarios, kinds: kinds.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind)), sets: sets.sort((a, b) => setOrder(a.set) - setOrder(b.set)) };
}

/** Суммы k/n и pass^N по группам сценариев: уровень или набор. */
function rollUp<K extends string>(scenarios: ScenarioTally[], keyOf: (tally: ScenarioTally) => K) {
  const groups = new Map<K, { key: K; scenarios: number; passed: number; counted: number; persona: number; stand: number; passAll: number; passAllKnown: number }>();
  for (const tally of scenarios) {
    const key = keyOf(tally);
    const group = groups.get(key) ?? { key, scenarios: 0, passed: 0, counted: 0, persona: 0, stand: 0, passAll: 0, passAllKnown: 0 };
    groups.set(key, group);
    group.scenarios += 1;
    group.passed += tally.passed;
    group.counted += tally.counted;
    group.persona += tally.persona;
    group.stand += tally.stand;
    if (tally.passAll !== null) group.passAllKnown += 1;
    if (tally.passAll) group.passAll += 1;
  }
  return [...groups.values()];
}
