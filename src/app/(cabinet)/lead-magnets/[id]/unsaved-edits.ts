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
  return { settings, flow: commonEdited ? { ...board, common: settings.flow.common } : board };
}

/** Поле формы «Настроек»; `common` — основная инструкция, она хранится в сценарии. */
export type SettingsEditKey = Exclude<keyof LeadMagnetSettings, "flow"> | "common";

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
  settings.flow = { ...latest.flow, common: pick("common", base.flow.common, edited.flow.common, latest.flow.common) };
  return { settings: settings as LeadMagnetSettings, conflicts };
}
