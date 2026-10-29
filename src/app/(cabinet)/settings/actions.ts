"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import { createAlertsFromEnv } from "@/modules/alerts";
import { getChatStorage } from "@/modules/platform/chat-storage";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { requireEnv } from "@/modules/platform/env";
import { getWebQueue } from "@/modules/platform/queue";
import { acknowledgeBudgetOverrun, parseSpendingSettings, saveSpendingSettings } from "@/modules/spending";

export interface SettingsFormState {
  error?: string;
  saved?: boolean;
}

export async function saveSettingsAction(_previous: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  await requireUser();
  const parsed = parseSpendingSettings(formData);
  if (!parsed.ok) return { error: parsed.error };

  const { db } = getDatabase();
  try {
    await saveSpendingSettings(
      {
        db,
        clock: systemClock,
        alerts: createAlertsFromEnv(db),
        queue: await getWebQueue(),
        chatStorage: await getChatStorage(requireEnv("DATABASE_URL")),
      },
      parsed.changes,
    );
  } catch (error) {
    console.error("Настройки не сохранились:", error instanceof Error ? error.message : error);
    return { error: "Не удалось сохранить настройки. Проверьте значения и попробуйте ещё раз." };
  }

  revalidatePath("/settings");
  return { saved: true };
}

export async function acknowledgeOverrunAction(): Promise<void> {
  await requireUser();
  await acknowledgeBudgetOverrun(createAlertsFromEnv(getDatabase().db));
  revalidatePath("/settings");
}
