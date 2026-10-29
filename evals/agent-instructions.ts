// Общие правила агентов, с которыми шёл прогон: судьи сверяются с ними, не читая код. Пишется один раз, когда прогон
// сценария закончился: пересчёт проверок файл не трогает, иначе в старом прогоне оказались бы правила из нового кода.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildConsultantInstruction } from "../src/modules/consultant/instruction";
import { readConstructorPrompt } from "../src/modules/constructor/endpoint";
import type { LeadMagnetSettings } from "../src/modules/lead-magnets";

export const AGENT_INSTRUCTIONS_FILE = "agent-instructions.md";

export function renderAgentInstructions(settings: LeadMagnetSettings | null, constructorPrompt: string): string {
  return [
    "# Общие правила агентов в этом прогоне",
    "",
    "Дословно то, что модели получили как неизменную инструкцию. Инструкция эксперта и карточки состояний — в `lead-magnet.md`; день, рамки, черновик и прочий хвост хода сюда не входят.",
    "",
    "## Консультант",
    "",
    settings ? buildConsultantInstruction(settings) : "_лидмагнит не собран: консультант в прогоне не работал_",
    "",
    "## Конструктор (`prompts/constructor.md`)",
    "",
    constructorPrompt.trim(),
    "",
  ].join("\n");
}

/** Кладёт правила в папку повтора, если их там ещё нет. */
export async function writeAgentInstructions(dir: string, settings: LeadMagnetSettings | null): Promise<void> {
  try {
    await writeFile(path.join(dir, AGENT_INSTRUCTIONS_FILE), renderAgentInstructions(settings, readConstructorPrompt()), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
