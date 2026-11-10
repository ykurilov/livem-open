import type { ResolvedUser } from "@ykurilov/agent-chat-core/access";

/** Чат расхода у диктовки веб-чата: код ссылки после приставки. Остальные чаты — тестовые чаты «Проверки». */
const WEB_CHAT_PREFIX = "web-"; // без двоеточия: сервер голоса принимает в `chat` только буквы, цифры, «-» и «_»

/** Чат, который веб-чат называет серверу голоса (`?chat=`): по нему сервер узнаёт лидмагнит ссылки. */
export const webChatVoiceChatId = (code: string) => `${WEB_CHAT_PREFIX}${code}`;

/** Откуда допуск к голосу узнаёт человека и включён ли голос у лидмагнита. */
export interface VoiceAccessPorts {
  /** Посетитель веб-чата по cookie запроса; нет — `null`. */
  webChatVisitorId(request: Request): Promise<string | null>;
  /**
   * Кто платит за диктовку посетителя: человек и чат его прохождения по лидмагниту ссылки — те же, на кого пишется
   * переписка с консультантом. Разговор ещё не начался — `null`.
   */
  webChatPayer(visitorId: string, code: string): Promise<{ ownerId: string; chatId: string } | null>;
  /** У опубликованного лидмагнита этой ссылки включён «Голосовой ввод». */
  webChatVoiceEnabled(code: string): Promise<boolean>;
  /** Вошедший в кабинет; нет — `null`. */
  cabinetUser(request: Request): Promise<{ id: string } | null>;
  /** Это тестовый чат «Проверки», и у черновика его лидмагнита включён «Голосовой ввод». */
  previewVoiceEnabled(chatId: string): Promise<boolean>;
}

/** Метка расхода, когда чата у диктовки нет (та же, что у SDK). */
const VOICE_CHAT_FALLBACK = "voice";

const VOICE_OFF: ResolvedUser = { refused: { code: "voice_off", message: "Голосовой ввод выключен" } };

/**
 * Кто может диктовать: посетитель веб-чата — в чате ссылки, кабинет — в «Проверке»; в обоих случаях только при включённом
 * «Голосовом вводе» у лидмагнита. Посетитель и кабинет не подменяют друг друга: у каждого чата свой вход.
 */
export function createVoiceUserResolver(ports: VoiceAccessPorts): (request: Request) => Promise<ResolvedUser> {
  return async (request) => {
    const chat = new URL(request.url).searchParams.get("chat");
    if (!chat) return VOICE_OFF;
    if (chat.startsWith(WEB_CHAT_PREFIX)) {
      const code = chat.slice(WEB_CHAT_PREFIX.length);
      if (!code) return VOICE_OFF;
      const visitorId = await ports.webChatVisitorId(request);
      if (!visitorId) return null;
      if (!(await ports.webChatVoiceEnabled(code))) return VOICE_OFF;
      const payer = await ports.webChatPayer(visitorId, code);
      return { id: payer?.ownerId ?? `web-visitor:${visitorId}` };
    }
    const user = await ports.cabinetUser(request);
    if (!user) return null;
    return (await ports.previewVoiceEnabled(chat)) ? { id: user.id } : VOICE_OFF;
  };
}

/**
 * На какой чат ложится расход диктовки (`spending.chatId` ретранслятора). Веб-чат — чат прохождения, как у переписки:
 * так голос виден в расходе разговора и лидмагнита. «Проверка» — её тестовый чат: допуск его уже проверил.
 */
export function createVoiceSpendingChat(ports: VoiceAccessPorts): (request: Request, user: { id: string }) => Promise<string> {
  return async (request) => {
    const chat = new URL(request.url).searchParams.get("chat") ?? "";
    if (!chat.startsWith(WEB_CHAT_PREFIX)) return chat || VOICE_CHAT_FALLBACK;
    const visitorId = await ports.webChatVisitorId(request);
    const payer = visitorId ? await ports.webChatPayer(visitorId, chat.slice(WEB_CHAT_PREFIX.length)) : null;
    return payer?.chatId ?? VOICE_CHAT_FALLBACK;
  };
}
