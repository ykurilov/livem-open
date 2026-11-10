// «Автоответ» в тестовом разговоре: модель в роли клиента пишет ему следующую реплику, она сразу уходит в разговор, эксперт может потом её исправить.
import type { StoredMessage } from "@ykurilov/agent-chat-core";
import { generateText, type ModelMessage } from "ai";
import { CLIENT_PLAY_RULES, clientRoleIntro } from "./client-role";
import { OUTREACH_REQUEST_TEXT } from "./outreach-request";
import { lastReplyParts } from "./single-reply";
import type { DirectModel } from "../platform/direct-model";

const textOf = (parts: StoredMessage["parts"]) =>
  parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();

/** Инструкция роли: тема — название и описание лидмагнита; кто клиент, видно из его прошлых реплик. */
export function autoreplyInstructions(lead: { name: string; cardDescription: string }): string {
  const topic = lead.cardDescription.trim() ? `${lead.name} (${lead.cardDescription.trim()})` : lead.name;
  return `${clientRoleIntro(topic)}

${CLIENT_PLAY_RULES}
- Кто ты, видно из твоих прошлых реплик: держись их. Разговор только начался — придумай себе правдоподобную ситуацию по теме бота.
- Ответь на последнее сообщение бота так, как ответил бы такой человек. Напиши только текст реплики.`;
}

/** Переписка глазами клиента: бот — собеседник, свои реплики — ответы модели. Служебная просьба «напиши первым» не видна. */
export function clientView(branch: readonly StoredMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const message of branch) {
    const text = textOf(message.role === "assistant" ? lastReplyParts(message.parts) : message.parts);
    if (!text || text === OUTREACH_REQUEST_TEXT) continue;
    messages.push(message.role === "assistant" ? { role: "user", content: text } : { role: "assistant", content: text });
  }
  // Модель отвечает на сообщение собеседника: если последней писала она сама, просим продолжить
  if (messages.at(-1)?.role !== "user") messages.push({ role: "user", content: "[Бот молчит. Напиши ему следующее сообщение.]" });
  return messages;
}

export async function suggestClientReply(input: {
  direct: DirectModel;
  lead: { name: string; cardDescription: string };
  branch: readonly StoredMessage[];
}): Promise<string> {
  const { direct } = input;
  const result = await generateText({
    model: direct.model,
    system: autoreplyInstructions(input.lead),
    messages: clientView(input.branch),
    providerOptions: direct.providerOptions,
    ...(direct.headers && { headers: direct.headers }),
    abortSignal: AbortSignal.timeout(60_000),
  });
  const text = result.text.trim();
  // Пустая реплика ничего не отправила бы, а кнопка погасла бы как после успеха
  if (!text) throw new Error("Модель вернула пустую реплику");
  return text;
}
