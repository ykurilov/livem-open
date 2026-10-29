// Сценарий eval: эксперт с целью и клиенты под его нишу. Один файл `scenarios/<id>.md` — один сценарий.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const SCENARIO_KINDS = ["normal", "hard", "provocateur", "program"] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

/** «На рост» — трудные, проходят плохо; «на поломки» — проходят почти всегда, ловят откат; отложенные лежат в `scenarios-holdout/` и не показываются тому, кто правит промпты. */
export const SCENARIO_SETS = ["growth", "regression", "holdout"] as const;
export type ScenarioSet = (typeof SCENARIO_SETS)[number];

const SCENARIOS_FOLDER = "scenarios";
const HOLDOUT_FOLDER = "scenarios-holdout";

const frontmatterSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/, "id — латиница, цифры и дефис"),
  kind: z.enum(SCENARIO_KINDS),
  set: z.enum(SCENARIO_SETS),
  title: z.string().min(1),
  /** Сколько реплик у эксперта с конструктором. Не нужно, если лидмагнит берётся из файла. */
  expertReplies: z.coerce.number().int().min(1).max(40).optional(),
  clientReplies: z.coerce.number().int().min(1).max(40),
  /** Ссылка из карточки эксперта, которую бот должен дать согласившемуся клиенту дословно. */
  expertLink: z.url().optional(),
  /** Программа на столько дней: клиенты могут молчать, часы стенда идут вперёд без ожидания. */
  days: z.coerce.number().int().min(2).max(14).optional(),
  /** JSON лидмагнита в формате scripts/lm.sh (путь от корня проекта): конструктор не участвует. */
  leadMagnet: z.string().min(1).optional(),
});

export interface ClientCard {
  name: string;
  card: string;
  /** Во сколько по Москве клиент пишет первое сообщение, `ЧЧ:ММ`. Не задано — в 12:00. */
  startsAt?: string;
  /** Имя в профиле мессенджера (`people.display_name`); не задано — id клиента, как ник. */
  profileName?: string;
}

type Frontmatter = z.infer<typeof frontmatterSchema>;

export interface Scenario extends Omit<Frontmatter, "leadMagnet" | "set"> {
  /** Набор сценария. Нет у сценариев из папок прогонов, снятых до появления наборов. */
  set?: ScenarioSet;
  expert: { card: string; goal: string };
  clients: ClientCard[];
  /** Лидмагнит из файла и правка поверх него из раздела «# Лидмагнит». */
  leadMagnet?: { file: string; overlay: Record<string, unknown> };
}

const EXPERT_HEADING = "Эксперт";
const GOAL_HEADING = "Цель";
const CLIENT_PREFIX = "Клиент:";
const LEAD_MAGNET_HEADING = "Лидмагнит";
const START_LINE = /^Старт:\s*([01]\d|2[0-3]):([0-5]\d)\s*$/;
const PROFILE_LINE = /^Профиль:\s*(\S.*?)\s*$/;
const JSON_BLOCK = /```json\n([\s\S]*?)\n```/;

function splitByHeading(text: string, marker: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(marker)) sections.push({ heading: line.slice(marker.length).trim(), body: "" });
    else if (sections.length) sections[sections.length - 1]!.body += `${line}\n`;
  }
  return sections.map((section) => ({ ...section, body: section.body.trim() }));
}

function readFrontmatter(markdown: string): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown.replace(/\r\n/g, "\n"));
  if (!match) throw new Error("нет блока --- с полями в начале файла");
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { fields, body: match[2]! };
}

export function parseScenario(markdown: string, fileName: string): Scenario {
  const fail = (reason: string): never => {
    throw new Error(`Сценарий ${fileName}: ${reason}`);
  };
  const { fields, body } = readFrontmatter(markdown);
  const parsed = frontmatterSchema.safeParse(fields);
  if (!parsed.success) return fail(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  if (`${parsed.data.id}.md` !== fileName) fail(`id «${parsed.data.id}» не совпадает с именем файла`);

  const sections = splitByHeading(body, "# ");
  const expertSection = sections.find((section) => section.heading === EXPERT_HEADING) ?? fail(`нет раздела «# ${EXPERT_HEADING}»`);
  const [card = "", ...rest] = expertSection.body.split(`\n## ${GOAL_HEADING}\n`);
  const goal = rest.join("").trim();
  if (!goal) fail(`нет раздела «## ${GOAL_HEADING}» у эксперта`);

  const clients = sections.filter((section) => section.heading.startsWith(CLIENT_PREFIX)).map((section) => clientCard(section));
  if (clients.length === 0) fail(`нет ни одного раздела «# ${CLIENT_PREFIX} …»`);
  for (const client of clients) if (!client.name || !client.card) fail("у клиента нет имени или карточки");

  const { leadMagnet: file, ...frontmatter } = parsed.data;
  if (!file && frontmatter.expertReplies === undefined) fail("expertReplies: нужно число реплик эксперта, если лидмагнит не из файла (leadMagnet)");
  const overlaySection = sections.find((section) => section.heading === LEAD_MAGNET_HEADING);
  const overlay = overlaySection ? readOverlay(overlaySection.body, fail) : {};
  return { ...frontmatter, expert: { card: card.trim(), goal }, clients, ...(file && { leadMagnet: { file, overlay } }) };
}

/** Карточка клиента; первые строки «Старт: 19:30» — во сколько он пишет первым, «Профиль: Марина» — имя в мессенджере. */
function clientCard(section: { heading: string; body: string }): ClientCard {
  const name = section.heading.slice(CLIENT_PREFIX.length).trim();
  const lines = section.body.split("\n");
  const card: Omit<ClientCard, "card"> = { name };
  while (lines.length > 0) {
    const line = lines[0]!.trim();
    const start = START_LINE.exec(line);
    const profile = PROFILE_LINE.exec(line);
    if (start) card.startsAt = `${start[1]}:${start[2]}`;
    else if (profile) card.profileName = profile[1]!;
    else break;
    lines.shift();
  }
  return { ...card, card: card.startsAt || card.profileName ? lines.join("\n").trim() : section.body };
}

/** Правка лидмагнита — блок ```json с объектом в разделе «# Лидмагнит». */
function readOverlay(body: string, fail: (reason: string) => never): Record<string, unknown> {
  const block = JSON_BLOCK.exec(body);
  if (!block) return fail(`в разделе «# ${LEAD_MAGNET_HEADING}» нет блока \`\`\`json`);
  let value: unknown;
  try {
    value = JSON.parse(block[1]!);
  } catch (error) {
    return fail(`в разделе «# ${LEAD_MAGNET_HEADING}» не JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(`в разделе «# ${LEAD_MAGNET_HEADING}» JSON должен быть объектом`);
  return value as Record<string, unknown>;
}

type StageInput = Record<string, unknown> & { name?: unknown };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Настройки лидмагнита сценария в формате scripts/lm.sh: файл и правка поверх. Ключи правки заменяют ключи файла,
 * кроме этапов — те дополняются по названию, новые встают в конец — и программы: её ключи из файла остаются,
 * срок берётся из сценария, ключи правки — поверх.
 */
export async function leadMagnetInput(scenario: Scenario, root: string): Promise<Record<string, unknown>> {
  if (!scenario.leadMagnet) throw new Error(`Сценарий ${scenario.id}: лидмагнит собирает конструктор, файла нет`);
  const base = JSON.parse(await readFile(path.join(root, scenario.leadMagnet.file), "utf8")) as Record<string, unknown>;
  const { stages, program, ...rest } = scenario.leadMagnet.overlay;
  const merged: Record<string, unknown> = { ...base, ...rest };
  // Лидмагнит со сценарием: срок — в «Дни и время», этапы и программа старого вида к нему не применяются
  if (isObject(merged.flow)) {
    if (stages !== undefined || program !== undefined)
      throw new Error(`Сценарий ${scenario.id}: у лидмагнита ${scenario.leadMagnet.file} сценарий (flow), правьте его, а не stages и program`);
    if (scenario.days !== undefined && isObject(merged.flow.schedule))
      merged.flow = { ...merged.flow, schedule: { ...merged.flow.schedule, lengthDays: scenario.days } };
    return merged;
  }
  if (Array.isArray(stages)) {
    const baseStages = (Array.isArray(base.stages) ? base.stages : []) as StageInput[];
    const patches = stages as StageInput[];
    merged.stages = [
      ...baseStages.map((stage) => ({ ...stage, ...patches.find((patch) => patch.name === stage.name) })),
      ...patches.filter((patch) => !baseStages.some((stage) => stage.name === patch.name)),
    ];
  }
  if (scenario.days !== undefined || program !== undefined)
    merged.program =
      program === null
        ? null
        : { ...(base.program as object | undefined), ...(scenario.days !== undefined && { days: scenario.days }), ...(program as object | undefined) };
  return merged;
}

/** Сценарии папки по алфавиту; с `only` — один сценарий по id. */
export async function loadScenarios(dir: string, only?: string): Promise<Scenario[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".md")).sort();
  const scenarios = await Promise.all(files.map(async (file) => parseScenario(await readFile(path.join(dir, file), "utf8"), file)));
  if (!only) return scenarios;
  // Несколько сценариев — через запятую
  const wanted = only.split(",").map((id) => id.trim()).filter(Boolean);
  const missing = wanted.filter((id) => !scenarios.some((scenario) => scenario.id === id));
  if (missing.length) throw new Error(`Сценария «${missing.join("», «")}» нет. Есть: ${scenarios.map((scenario) => scenario.id).join(", ")}`);
  return scenarios.filter((scenario) => wanted.includes(scenario.id));
}

/**
 * Сценарии набора: без набора — «на рост» и «на поломки» из `scenarios/`, `holdout` — только `scenarios-holdout/`.
 * Сценарий лежит в папке своего набора, иначе ошибка: отложенный не должен попасть в обычный прогон.
 */
export async function loadScenarioSet(evalsDir: string, set?: ScenarioSet, only?: string): Promise<Scenario[]> {
  const holdout = set === "holdout";
  const folder = holdout ? HOLDOUT_FOLDER : SCENARIOS_FOLDER;
  const inFolder = await loadScenarios(path.join(evalsDir, folder));
  for (const scenario of inFolder)
    if ((scenario.set === "holdout") !== holdout)
      throw new Error(`Сценарий ${scenario.id}: набор «${scenario.set}» не лежит в папке ${folder}/ (отложенные — только в ${HOLDOUT_FOLDER}/)`);
  const chosen = inFolder.filter((scenario) => holdout || !set || scenario.set === set);
  if (!only) return chosen;
  const wanted = only.split(",").map((id) => id.trim()).filter(Boolean);
  const missing = wanted.filter((id) => !chosen.some((scenario) => scenario.id === id));
  if (missing.length) throw new Error(`Сценария «${missing.join("», «")}» нет в наборе ${set ?? "growth и regression"}. Есть: ${chosen.map((scenario) => scenario.id).join(", ")}`);
  return chosen.filter((scenario) => wanted.includes(scenario.id));
}
