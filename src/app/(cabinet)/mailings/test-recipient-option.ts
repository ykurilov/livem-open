import { CHANNEL_LABELS } from "@/modules/channels";
import type { TestRecipient } from "@/modules/mailings";

export interface TestRecipientOption {
  id: string;
  label: string;
}

/** Строка выбора «Кому прислать пробу»: имя, мессенджер и бот — чтобы узнать себя. */
export function testRecipientOption(person: TestRecipient): TestRecipientOption {
  return { id: person.id, label: `${person.displayName ?? "Без имени"} — ${CHANNEL_LABELS[person.channel]}, «${person.botTitle}»` };
}
