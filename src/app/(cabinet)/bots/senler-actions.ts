"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import { createSenlerSettingsFromEnv } from "@/modules/senler";

export interface SenlerFormState {
  error?: string;
  saved?: boolean;
  /** Ключ заменил прежний: группы стоит проверить. */
  replaced?: boolean;
}

/** Поле своей группы лидмагнита: `leadMagnetGroup:<id лидмагнита>`, пусто — «как у бота». */
const LEAD_MAGNET_FIELD = "leadMagnetGroup:";

/** Ключ Senler: проверяется запросом групп и сохраняется зашифрованным. */
export async function connectSenlerAction(botId: string, _previous: SenlerFormState, formData: FormData): Promise<SenlerFormState> {
  await requireUser();
  const apiKey = formData.get("apiKey");
  const senler = createSenlerSettingsFromEnv();
  const replaced = Boolean(await senler.load(botId));
  const result = await senler.connect(botId, typeof apiKey === "string" ? apiKey : "");
  if (!result.ok) return { error: result.error };
  revalidatePath(`/bots/${botId}`);
  return { saved: true, replaced };
}

/** Группа бота и свои группы лидмагнитов. */
export async function saveSenlerGroupsAction(botId: string, _previous: SenlerFormState, formData: FormData): Promise<SenlerFormState> {
  await requireUser();
  const value = (raw: FormDataEntryValue | null) => (typeof raw === "string" && raw ? raw : null);
  const leadMagnetGroups: Record<string, string | null> = {};
  for (const [name, raw] of formData.entries())
    if (name.startsWith(LEAD_MAGNET_FIELD)) leadMagnetGroups[name.slice(LEAD_MAGNET_FIELD.length)] = value(raw);
  const result = await createSenlerSettingsFromEnv().saveGroups(botId, { defaultGroupId: value(formData.get("defaultGroupId")), leadMagnetGroups });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/bots/${botId}`);
  return { saved: true };
}

export async function disconnectSenlerAction(botId: string): Promise<SenlerFormState> {
  await requireUser();
  await createSenlerSettingsFromEnv().disconnect(botId);
  revalidatePath(`/bots/${botId}`);
  return {};
}
