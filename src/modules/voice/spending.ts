import { SpendingLimitReachedError, type ChatService } from "@ykurilov/agent-chat-core";

/** Что ретранслятору голоса нужно от службы чата: лимит, запись расхода, проверка чата и модель для чистки. */
export type VoiceChargeService = Pick<ChatService, "assertWithinLimit" | "recordUsage" | "assertOwnChat" | "askModel">;

export interface VoiceSpendingRoutes {
  /** Служба боевых разговоров: дневной лимит человека, как у консультанта. */
  live: VoiceChargeService;
  /** Служба без лимитов: тестовый разговор «Проверки» идёт без лимитов. */
  preview: VoiceChargeService;
  /** Чат — прохождение человека (боевой разговор). */
  isLiveChat(chatId: string): Promise<boolean>;
  /** Аварийная остановка по месячному бюджету: консультант людям не отвечает. */
  emergencyStopped(): Promise<boolean>;
}

/**
 * Расход диктовки по тем же правилам, что у переписки: боевой чат — дневной лимит человека и аварийная остановка,
 * «Проверка» — без лимитов. Журнал расхода один на всех: голос виден в расходе разговора, лидмагнита и месяца.
 */
export function createVoiceSpendingService(routes: VoiceSpendingRoutes): VoiceChargeService {
  async function serviceFor(chatId: string): Promise<VoiceChargeService> {
    if (!(await routes.isLiveChat(chatId))) return routes.preview;
    if (await routes.emergencyStopped()) throw new SpendingLimitReachedError({ scope: "service", period: "month", resetsAt: null });
    return routes.live;
  }
  return {
    assertWithinLimit: async (ownerId, chatId) => (await serviceFor(chatId)).assertWithinLimit(ownerId, chatId),
    // Запись — без проверки остановки: потраченное должно попасть в журнал
    recordUsage: async (input) => ((await routes.isLiveChat(input.chatId)) ? routes.live : routes.preview).recordUsage(input),
    assertOwnChat: (userId, chatId) => routes.preview.assertOwnChat(userId, chatId),
    askModel: async (input) => (await serviceFor(input.chatId)).askModel(input),
  };
}
