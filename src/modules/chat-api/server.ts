import { voiceConfigured } from "../voice/relay-options";
import { webChatDependencies } from "../web-chat/server";
import { createChatApi, type ChatApi } from "./chat-api";
import { appOriginOf, chatSignaturesFromEnv } from "./env";

/** API для этого запроса (маршруты `/api/v1/…`). */
export async function chatApiFor(request: Request): Promise<ChatApi> {
  return createChatApi({ ...(await webChatDependencies()), appOrigin: appOriginOf(request), signatures: chatSignaturesFromEnv(), voiceConfigured: voiceConfigured() });
}
