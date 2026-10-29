import type { FlowConfirmationSpec, FlowExitGuard } from "@ykurilov/agent-chat-flows";

export const FIRST_APP_ID = "6c1e0b37-1381-4f47-89f4-d624853586da";
export const OWN_PUBLISHED = { key: "ownPublished", revision: "own-app-v1" } as const;
/** Оценка диалога, не доказательство владения аккаунтом/доменом. Никогда не берётся из карточки модели. */
export const OWN_APP_CRITERION = "Человек прислал ссылку на apps.example.com на то самое приложение, которое человек собирал в этом разговоре. Помощник посмотрел приложение по ссылке и подтвердил соответствие обсуждавшемуся приложению. Если помощник сомневается, что это его приложение, или сказал, что по ссылке не то, условие не выполнено. Один URL, слова «опубликовал», карточка, превью или адрес редактора без проверки своего опубликованного приложения недостаточны.";

export function firstAppConfirmations(): {
  confirmations: FlowConfirmationSpec[]; exitGuards: FlowExitGuard[];
} {
  return {
    confirmations: [{ flowId: FIRST_APP_ID, ...OWN_PUBLISHED, states: ["result"], judge: OWN_APP_CRITERION }],
    exitGuards: [{ flowId: FIRST_APP_ID, state: "result", exitId: "polish_done", requires: OWN_PUBLISHED, judgeWindow: "current-human-turn" }],
  };
}
