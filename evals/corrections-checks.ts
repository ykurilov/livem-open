// Проверки кодом разбора правок (вид `corrections`): без слов эксперта в записанном, запись только после согласия, правки разобраны.
import { isSavedEdit } from "@/modules/constructor/save-claim";
import type { LeadMagnetSettings } from "@/modules/lead-magnets";
import type { CheckResult, CheckStatus, ConstructorTurn, ScenarioRun } from "./types";

const SCENARIO = "сценарий";
/** Отрезок из стольких слов подряд из «стало» в записанном — текст эксперта попал в настройки (SC-003). */
const EXPERT_RUN_WORDS = 4;
/** Эти тексты уходят человеку как есть: эксперт вправе вписать в них свои слова. */
const SENT_AS_IS = new Set(["firstMessage", "farewellMessage"]);
const READ_TOOL = "read_answer_corrections";
const EDIT_TOOL = "edit_lead_magnet";

const result = (id: string, title: string, status: CheckStatus, details: string): CheckResult => ({ id, title, subject: SCENARIO, status, details });

const words = (text: string) => text.toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}]+/gu) ?? [];

function runsOf(text: string): Set<string> {
  const list = words(text);
  const runs = new Set<string>();
  for (let index = 0; index + EXPERT_RUN_WORDS <= list.length; index++) runs.add(list.slice(index, index + EXPERT_RUN_WORDS).join(" "));
  return runs;
}

/** Все тексты настроек, кроме первого сообщения и прощания, — с нодами сценария и этапами. */
function settingsTexts(value: unknown, key = ""): string[] {
  if (SENT_AS_IS.has(key)) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => settingsTexts(item));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([name, item]) => settingsTexts(item, name));
  return [];
}

const runsOfSettings = (settings: LeadMagnetSettings) => new Set(settingsTexts(settings).flatMap((text) => [...runsOf(text)]));

function expertWordsCheck(run: ScenarioRun): CheckResult {
  const title = `В записанном нет ${EXPERT_RUN_WORDS} слов подряд из исправленного текста эксперта (SC-003)`;
  if (!run.settings || !run.corrections) return result("corrections_no_expert_words", title, "skip", "черновика нет");
  const before = runsOfSettings(run.corrections.before);
  const written = [...runsOfSettings(run.settings)].filter((piece) => !before.has(piece));
  const problems = (run.scenario.corrections ?? []).flatMap((correction) => {
    const original = runsOf(correction.originalText);
    const expert = runsOf(correction.correctedText);
    const leaked = written.filter((piece) => expert.has(piece) && !original.has(piece));
    return leaked.length ? [`правка «${correction.title}»: ${leaked.slice(0, 5).map((piece) => `«${piece}»`).join(", ")}`] : [];
  });
  return result("corrections_no_expert_words", title, problems.length ? "fail" : "pass", problems.join("\n"));
}

const savedIn = (turn: ConstructorTurn) => turn.tools.some((tool) => tool.name === EDIT_TOOL && !tool.error && isSavedEdit(tool.output));

/**
 * Запись — только после того, как эксперт ответил на предложение: не раньше хода после первого чтения правок.
 * Эксперт отказывается от первого предложения — в ходе с отказом записи нет: новое предложение тоже сначала показать (SC-004).
 * Было ли «да» согласием и не записано ли отвергнутое позже, решает судья.
 */
function consentCheck(run: ScenarioRun): CheckResult {
  const turns = run.building.turns;
  const firstRead = turns.findIndex((turn) => turn.tools.some((tool) => tool.name === READ_TOOL));
  const writes = turns.flatMap((turn, index) => (savedIn(turn) ? [index] : []));
  const at = (indexes: number[]) => indexes.map((index) => `ход ${index + 1}`).join(", ");
  const problems: string[] = [];
  const early = writes.filter((index) => firstRead === -1 || index <= firstRead);
  if (early.length) problems.push(`${firstRead === -1 ? "правки не прочитаны" : `правки прочитаны в ходе ${firstRead + 1}`}, а запись раньше ответа эксперта на предложение: ${at(early)}`);
  const onRefusal = run.scenario.consent === "refuse" && firstRead !== -1 && writes.includes(firstRead + 1);
  if (onRefusal) problems.push(`эксперт отказался от предложения, а настройки записаны в том же ходе: ${at([firstRead + 1])}`);
  return result("corrections_after_consent", "Конструктор записывает только после согласия эксперта (SC-004)", problems.length ? "fail" : "pass", problems.join("\n"));
}

/** Правки отмечены разобранными; эксперт согласен — хотя бы одна учтена. После отказа итог любой: эксперт мог попросить иное. */
function resolvedCheck(run: ScenarioRun): CheckResult {
  const final = run.corrections?.final ?? [];
  const problems: string[] = [];
  const pending = final.filter((correction) => correction.status === "pending").length;
  if (pending) problems.push(`неразобранных правок: ${pending} из ${final.length}`);
  const applied = final.filter((correction) => correction.outcome === "applied").length;
  if (run.scenario.consent === "agree" && !applied) problems.push("эксперт согласился, а ни одна правка не отмечена учтённой");
  const outcomes = final.map((correction) => correction.outcome ?? correction.status).join(", ");
  return result("corrections_resolved", "Правки разобраны, при согласии эксперта учтены", problems.length ? "fail" : "pass", [...problems, `итоги: ${outcomes || "правок нет"}`].join("\n"));
}

export function correctionsChecks(run: ScenarioRun): CheckResult[] {
  if (run.scenario.kind !== "corrections") return [];
  return [expertWordsCheck(run), consentCheck(run), resolvedCheck(run)];
}
