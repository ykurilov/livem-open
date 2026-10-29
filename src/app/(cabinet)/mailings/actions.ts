"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import {
  MailingError,
  MailingImageError,
  cancelMailing,
  launchMailing,
  listTestRecipients,
  parseMskDateTime,
  saveMailingDraft,
  sendMailingTest,
} from "@/modules/mailings";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { getWebQueue } from "@/modules/platform/queue";
import { isUuid } from "@/modules/platform/uuid";
import { testRecipientOption } from "./test-recipient-option";

export interface MailingFormState {
  error?: string;
}

const INTENTS = ["save", "test", "now", "schedule"] as const;
type Intent = (typeof INTENTS)[number];

const FORM_OUTDATED = "Форма устарела — обновите страницу";

/**
 * Черновик рассылки: сохранить, «Отправить себе», отправить сейчас или запланировать.
 * Новая рассылка сначала сохраняется черновиком, потом выполняется выбранное действие.
 */
export async function saveMailingAction(_previous: MailingFormState, formData: FormData): Promise<MailingFormState> {
  await requireUser();
  const intent = formData.get("intent");
  const mailingId = formData.get("mailingId");
  const text = formData.get("text");
  const filterJson = formData.get("filter");
  const testPersonId = formData.get("testPersonId");
  const requestId = formData.get("requestId");
  const image = formData.get("image");
  if (
    typeof intent !== "string" ||
    !INTENTS.includes(intent as Intent) ||
    typeof mailingId !== "string" ||
    (mailingId !== "" && !isUuid(mailingId)) ||
    typeof text !== "string" ||
    typeof filterJson !== "string" ||
    typeof requestId !== "string" ||
    (image !== null && !(image instanceof File))
  ) {
    return { error: FORM_OUTDATED };
  }

  let id = mailingId;
  let created = false;
  try {
    let filter: unknown;
    try {
      filter = JSON.parse(filterJson);
    } catch {
      return { error: FORM_OUTDATED };
    }
    const person = typeof testPersonId === "string" && isUuid(testPersonId) ? testPersonId : null;
    if (intent === "test" && !person) return { error: "Выберите, кому прислать пробу" };

    // Время проверяется до сохранения: ошибка во времени не должна оставлять лишний черновик
    let at: Date | undefined;
    if (intent === "schedule") {
      at = parseMskDateTime(String(formData.get("at") ?? ""));
      if (at.getTime() <= systemClock.now().getTime()) return { error: "Это время уже прошло" };
    }

    const { db } = getDatabase();
    const saved = await saveMailingDraft(db, {
      id: id || null,
      text,
      filter,
      testPersonId: person,
      image: image && image.size > 0 ? { name: image.name, bytes: new Uint8Array(await image.arrayBuffer()) } : null,
      removeImage: formData.get("removeImage") === "on",
    });
    created = !id;
    id = saved.id;

    const deps = { db, queue: await getWebQueue(), clock: systemClock };
    if (intent === "test") await sendMailingTest(deps, id, person!, requestId);
    if (intent === "now") await launchMailing(deps, id);
    if (intent === "schedule") await launchMailing(deps, id, { at });
  } catch (error) {
    if (!(error instanceof MailingError || error instanceof MailingImageError)) throw error;
    // Новый черновик уже сохранён: ошибку показывает его страница, иначе следующая попытка создаст второй
    if (!created) return { error: error.message };
    redirect(`/mailings/${id}?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/mailings");
  redirect(`/mailings/${id}?done=${intent}`);
}

/** Отмена запланированной рассылки до старта. */
export async function cancelMailingAction(formData: FormData): Promise<void> {
  await requireUser();
  const id = formData.get("mailingId");
  if (typeof id !== "string" || !isUuid(id)) redirect("/mailings");
  try {
    await cancelMailing({ db: getDatabase().db }, id);
  } catch (error) {
    if (!(error instanceof MailingError)) throw error;
    // Уже стартовала: страница покажет её настоящее состояние
  }
  revalidatePath("/mailings");
  redirect(`/mailings/${id}`);
}

/** Сколько знаков имени принимает поиск «Кому прислать пробу». */
const TEST_SEARCH_MAX = 100;

/** Поиск себя в базе для «Отправить себе»: по части имени. */
export async function findTestRecipientsAction(query: string): Promise<Array<{ id: string; label: string }>> {
  await requireUser();
  if (typeof query !== "string") return [];
  const people = await listTestRecipients(getDatabase().db, { query: query.slice(0, TEST_SEARCH_MAX) });
  return people.map(testRecipientOption);
}

