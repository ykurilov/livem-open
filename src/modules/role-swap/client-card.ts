// Карточка клиента «Поменяемся ролями»: один вызов модели при старте разговора, дальше карточка не меняется.
import { generateText } from "ai";
import type { DirectModel } from "../platform/direct-model";

/** Срок придумывания клиента: эксперт ждёт его на экране старта. */
export const CLIENT_CARD_TIMEOUT_MS = 30_000;

const CARD_INSTRUCTIONS = `Ты придумываешь одного клиента эксперта для тренировочного разговора. Эксперт будет отвечать ему за своего бота-консультанта, а другая модель сыграет этого клиента по твоей карточке.

Что нужно:
- Человек из аудитории этого лидмагнита: его беда и ситуация связаны с темой бота, он пришёл по ссылке эксперта.
- Живой и конкретный: кто он, что у него сейчас происходит, чего он хочет, что его останавливает, в чём сомневается, как пишет в мессенджере.
- Опиши его словами, от третьего лица. Не пиши фраз, которые он скажет, и не пиши, как должен пойти разговор.
- Если эксперт описал клиента — держись этого описания и додумай остальное. Если описал своих клиентов в целом — держись и этого.
- Не повторяй прошлых клиентов: другой человек, другая ситуация, другая манера.
- До 120 слов. Напиши только карточку, без заголовков и пояснений.`;

export interface ClientCardInput {
  direct: DirectModel;
  lead: { name: string; cardDescription: string; clientPortrait: string };
  /** Поле «Кто клиент»; пустое — модель придумывает сама. */
  brief: string | null;
  /** Карточки прошлых разговоров лидмагнита, новые первыми. */
  previousCards: readonly string[];
}

/** Что известно о лидмагните и клиенте: только непустые части. */
function cardRequest({ lead, brief, previousCards }: Omit<ClientCardInput, "direct">): string {
  const section = (title: string, text: string | null | undefined) => (text?.trim() ? `${title}:\n${text.trim()}` : null);
  const previous = previousCards.map((card) => card.trim()).filter(Boolean);
  return [
    section("Лидмагнит", lead.name),
    section("Описание лидмагнита", lead.cardDescription),
    section("Клиенты эксперта", lead.clientPortrait),
    section("Каким эксперт хочет видеть этого клиента", brief),
    section("Прошлые клиенты", previous.map((card) => `- ${card.replace(/\s*\n\s*/g, " ")}`).join("\n")),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

export async function inventClientCard(input: ClientCardInput): Promise<string> {
  const { direct } = input;
  const result = await generateText({
    model: direct.model,
    system: CARD_INSTRUCTIONS,
    messages: [{ role: "user", content: cardRequest(input) }],
    providerOptions: direct.providerOptions,
    ...(direct.headers && { headers: direct.headers }),
    abortSignal: AbortSignal.timeout(CLIENT_CARD_TIMEOUT_MS),
  });
  const card = result.text.trim();
  if (!card) throw new Error("Модель вернула пустую карточку клиента");
  return card;
}
