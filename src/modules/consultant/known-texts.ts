import type { LeadMagnetSettings } from "../lead-magnets";
import { buildConsultantInstruction } from "./instruction";

/**
 * Все тексты эксперта: наша инструкция, сценарий (общая часть, инструкции нод, условия переходов, первые сообщения нод,
 * попутные задачи, готовые фразы «Дней и времени»), первое сообщение, прощание. По ним ищется домен приложений и
 * проверяет eval. Проверкам ответа SDK тексты сценария добавляет сам — им нужны только наши (`leadMagnetOwnTexts`).
 */
export function leadMagnetKnownTexts(settings: LeadMagnetSettings): string[] {
  const { flow } = settings;
  return [
    buildConsultantInstruction(settings),
    flow.common,
    ...flow.states.flatMap((state) => [
      state.instructions,
      state.firstMessage ?? "",
      ...state.exits.flatMap((exit) => (exit.when.type === "judge" ? [exit.when.text] : [])),
    ]),
    ...(flow.sideTasks ?? []).flatMap((task) => [task.text, task.when ?? ""]),
    flow.schedule?.farewellText ?? "",
    flow.schedule?.dayFrame?.hardText ?? "",
    settings.firstMessage,
    settings.farewellMessage,
    // Старые поля лежат в настройках до среза S10 (откат); их тексты — тоже тексты эксперта
    settings.instruction,
    ...settings.stages.flatMap((stage) => [stage.instruction, stage.transitionCondition]),
    ...(settings.program?.sideTasks.flatMap((task) => [task.task, task.when]) ?? []),
  ].filter((text) => text.trim().length > 0);
}
