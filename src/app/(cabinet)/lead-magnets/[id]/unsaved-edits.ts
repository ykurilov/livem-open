import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import type { LeadMagnetSettings } from "@/modules/lead-magnets";

/**
 * Несохранённые правки обеих вкладок одним сохранением: настройки — из формы, сценарий — с доски. Основную инструкцию
 * правят обе: берётся та, что изменена в «Настройках», иначе — с доски.
 */
export function combineUnsavedEdits(
  saved: LeadMagnetSettings,
  settings: LeadMagnetSettings,
  board: AgentFlow,
): { settings: LeadMagnetSettings; flow: AgentFlow } {
  const commonEdited = settings.flow.common !== saved.flow.common;
  const nudgesEdited = !same(settings.flow.nudges, saved.flow.nudges);
  return {
    settings,
    flow: {
      ...board,
      ...(commonEdited && { common: settings.flow.common }),
      ...(nudgesEdited && settings.flow.nudges && { nudges: settings.flow.nudges }),
    },
  };
}

/**
 * Поле формы «Настроек»; `common` — основная инструкция, `nudges` — «Напоминать» и «Ждать ответа»: они хранятся в
 * сценарии.
 */
export type SettingsEditKey = Exclude<keyof LeadMagnetSettings, "flow"> | "common" | "nudges";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Пока эксперт правил форму, пришла новая версия черновика (`latest`, правка конструктора или другой вкладки). Поля,
 * изменённые в форме относительно `base`, остаются из формы, остальные — из новой версии. `conflicts` — поля, которые
 * изменились и там и там по-разному: в форме вариант эксперта.
 */
export function rebaseSettingsEdit(
  base: LeadMagnetSettings,
  edited: LeadMagnetSettings,
  latest: LeadMagnetSettings,
): { settings: LeadMagnetSettings; conflicts: SettingsEditKey[] } {
  const conflicts: SettingsEditKey[] = [];
  const pick = <T>(key: SettingsEditKey, from: T, form: T, next: T): T => {
    if (same(form, from)) return next;
    if (!same(next, from) && !same(next, form)) conflicts.push(key);
    return form;
  };
  const settings = { ...latest } as Record<string, unknown>;
  const keys = new Set([...Object.keys(edited), ...Object.keys(latest)]) as Set<keyof LeadMagnetSettings>;
  for (const key of keys) {
    if (key !== "flow") settings[key] = pick(key, base[key], edited[key], latest[key]);
  }
  const nudges = pick("nudges", base.flow.nudges, edited.flow.nudges, latest.flow.nudges);
  settings.flow = { ...latest.flow, common: pick("common", base.flow.common, edited.flow.common, latest.flow.common), ...(nudges && { nudges }) };
  return { settings: settings as LeadMagnetSettings, conflicts };
}
