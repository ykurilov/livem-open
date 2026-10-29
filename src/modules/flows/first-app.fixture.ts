import firstApp from "./first-app.legacy.json";
import { newLeadMagnetSettings, type LeadMagnetSettings } from "../lead-magnets/settings";
import type { FieldDefinition } from "../people";

/** Поля «Твоего первого приложения» в словаре: id выдуманы, остальное — как в first-app.legacy.json (вид до перевода на сценарии). */
export const FIRST_APP_FIELDS: FieldDefinition[] = firstApp.fields.map((field, index) => ({
  id: `00000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, "0")}`,
  name: field.name,
  type: field.type as FieldDefinition["type"],
  options: "options" in field ? (field.options ?? []) : [],
  description: field.description,
}));

const fieldIdByName = (name: string) => FIRST_APP_FIELDS.find((field) => field.name === name)!.id;

/** Настройки «Твоего первого приложения» в старом виде (этапы и программа), как они лежат в базе до перевода. */
export function firstAppSettings(): LeadMagnetSettings {
  const { program } = firstApp;
  return {
    ...newLeadMagnetSettings(firstApp.name, firstApp.cardDescription),
    instruction: firstApp.instruction,
    firstMessage: firstApp.firstMessage,
    endCondition: firstApp.endCondition,
    farewellMessage: firstApp.farewellMessage,
    maxPersonMessages: firstApp.maxPersonMessages,
    viewsLinks: firstApp.viewsLinks,
    fieldIds: FIRST_APP_FIELDS.map((field) => field.id),
    stages: firstApp.stages.map((stage, index) => ({ id: `stage-${index + 1}`, ...stage })),
    program: {
      days: program.days,
      softDailyMessages: program.softDailyMessages,
      hardDailyMessages: program.hardDailyMessages,
      outreach: program.outreach,
      sideTasks: program.sideTasks.map((task, index) => ({
        id: `task-${index + 1}`,
        task: task.task,
        fieldId: fieldIdByName(task.field),
        when: task.when,
      })),
    },
  };
}
