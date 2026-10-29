import type { ModelChoice } from "@ykurilov/agent-chat-core";
import { createAgentFlow, type AgentFlowHandle, type CanWriteNow, type FlowAttachment, type LoadedFlow } from "@ykurilov/agent-chat-flows";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { postgresFlowStore } from "@ykurilov/agent-chat-flows/postgres";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { readPreviewConversation } from "../consultant/preview-store";
import { passages } from "../conversations/schema";
import { getLeadMagnet, getVersion } from "../lead-magnets";
import { getPerson } from "../people";
import { isPreviewOwner } from "../platform/cabinet-owner";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import { AGENT_TIME_ZONE, DEFAULT_MODEL_CHOICE } from "../platform/models-catalog";
import { firstAppConfirmations } from "./first-app-confirmations";
import { leadMagnetClientCard } from "./client-card";
import { leadMagnetFlowEvents } from "./events";
import { createFlowLog } from "./flow-log";
import { readPassagePlacement } from "./passage-placement";
import { leadMagnetPeople } from "./people";
import { withCurrentFlowRules } from "./program-day";
import { STAFF_SILENCE_HOURS } from "./settings-to-flow";

/**
 * Ночь для сообщений первым у лидмагнитов без «Дней и времени» (решение MVP): 22:00–9:00. У сценария с «Днями и
 * временем» ночь своя — от «не позже» (`schedule.nightFrom`) до начала дня, и потолок свой: они главнее этих.
 */
export const FIRST_MESSAGES_QUIET_HOURS = { from: "22:00", to: "09:00" } as const;
/** Не больше стольких сообщений первым за день человека. */
export const FIRST_MESSAGES_PER_DAY = 3;

/** Сценарий в работе. */
export type LeadMagnetFlow = AgentFlowHandle & {
  /** Службы чатов по разговору (снимок лидмагнита или черновик) и наша доставка сообщений первым, если она есть. */
  attachPorts(portFor: FlowAttachment["portFor"]): void;
};

export interface LeadMagnetFlowOptions {
  db: Database;
  /** Пул той же базы: таблицы сценариев SDK (`agent_chat.flow_*`) создаются сами. */
  pool: Pool;
  clock: Clock;
  env?: Record<string, string | undefined>;
  /** Запасной судья — модель каталога, пока decision-1 в предварительной версии. По умолчанию DeepSeek 4.1 Flash. */
  judgeFallback?: ModelChoice;
  /** Аварийная остановка бюджета: пока стоит, агент первым не пишет — касание повторится через час. */
  isEmergencyStopped?: () => Promise<boolean>;
  /**
   * Доставка сообщений первым через наши боты (`createFirstMessageDelivery`). Тестовым чатам «Проверки» такой
   * сценарий первым не пишет: их ведёт сценарий «Проверки». Нет доставки и нет `writesFirstToChat` — первым агент не
   * пишет: таймеры только переводят по нодам и заканчивают разговор («срок вышел», «не завершил»).
   */
  deliver?: FlowAttachment["deliver"];
  /**
   * Агент пишет первым без своей доставки: ответ остаётся в веб-чате («Проверка» эксперта). Без этого флага и без
   * `deliver` человек в мессенджере не получил бы касание, а сценарий счёл бы его отправленным.
   */
  writesFirstToChat?: boolean;
  logError?: (message: string) => void;
}

/** Судья через французский прокси, как и остальные запросы к OpenRouter с московского сервера (`createAppCatalog`). */
function judgeOpenRouter(env: Record<string, string | undefined>) {
  const baseUrl = env.OPENROUTER_BASE_URL?.trim();
  const proxyToken = env.PROXY_TOKEN?.trim();
  return {
    ...(env.OPENROUTER_API_KEY && { apiKey: env.OPENROUTER_API_KEY }),
    ...(baseUrl && { baseUrl }),
    ...(baseUrl && proxyToken && { headers: { "X-Proxy-Token": proxyToken } }),
  };
}

/**
 * Какой сценарий у чата: боевой разговор — сценарий своего снимка (`flowId` — id лидмагнита, `versionId` — id снимка;
 * переопубликация идущие чаты не трогает), тестовый — черновика. Чужой чат (конструктор) — без сценария.
 */
export async function loadLeadMagnetFlow(db: Database, chatId: string): Promise<LoadedFlow | null> {
  const [passage] = await db.select({ leadMagnetId: passages.leadMagnetId, snapshotId: passages.snapshotId }).from(passages).where(eq(passages.chatId, chatId));
  if (passage) {
    const snapshot = await getVersion(db, passage.snapshotId);
    return snapshot ? { flowId: passage.leadMagnetId, versionId: passage.snapshotId, flow: currentRulesOf(snapshot.settings.flow) } : null;
  }
  const preview = await readPreviewConversation(db, chatId);
  const lead = preview && (await getLeadMagnet(db, preview.leadMagnetId));
  return lead ? { flowId: lead.id, versionId: lead.draftVersionId, flow: currentRulesOf(lead.draft.flow) } : null;
}

/**
 * Снимок, опубликованный до правил 14.10, — по нынешним (`withCurrentFlowRules`). Версия, уже закреплённая за чатами,
 * так и идёт по сохранённому в SDK: под тем же номером другой сценарий SDK не примет.
 */
export const currentRulesOf = (flow: unknown): unknown => {
  const agentFlow = agentFlowOf(flow);
  return agentFlow ? withCurrentFlowRules(agentFlow) : flow;
};

/** Сценарий как объект: в снимке старой версии без перевода его нет. */
export const agentFlowOf = (value: unknown): AgentFlow | null =>
  typeof value === "object" && value !== null && Array.isArray((value as AgentFlow).states) ? (value as AgentFlow) : null;

/**
 * Сценарий чата для SDK: у прохождения — с его местом (нода, начало, реплики, счёт дня; plan.md 3.3). Новый разговор
 * закрепляется при входе (`adopt` в `router.ts`), идущий чат старой версии — скриптом переноса; если человек напишет
 * раньше, чем дошёл перенос, первый ход закрепит чат на том же месте, а не на старте сценария.
 */
async function loadPlacedFlow(db: Database, chatId: string, now: Date): Promise<LoadedFlow | null> {
  const loaded = await loadLeadMagnetFlow(db, chatId);
  const flow = loaded && agentFlowOf(loaded.flow);
  if (!flow) return loaded;
  const [passage] = await db.select().from(passages).where(eq(passages.chatId, chatId));
  if (!passage) return loaded;
  const { placement } = await readPassagePlacement(db, passage, flow, now);
  return { ...loaded, ...placement };
}

/**
 * Сценарии лидмагнитов (plan.md, разделы 2–3): ноды, переходы, дни, касания, рамки дня, пауза сотрудника. Карточка
 * клиента и пояс — в «Базе», переходы и концы — в прохождениях. Службы чатов подключает приложение (`flow.attach`).
 */
export function createLeadMagnetFlow(options: LeadMagnetFlowOptions): LeadMagnetFlow {
  const { db, clock } = options;
  const env = options.env ?? process.env;
  const events = leadMagnetFlowEvents(db, { log: createFlowLog(db, (chatId) => loadLeadMagnetFlow(db, chatId)) });
  const { deliver } = options;

  /**
   * Писать ли первым сейчас. «Никогда» (до сообщения человека) — некуда или незачем: нет доставки, тестовый чат
   * «Проверки» у боевого сценария, человек заблокировал бота. «Не сейчас» — аварийная остановка бюджета: касание
   * повторится через час. Конец разговора и переходы по сроку от ответа не зависят.
   */
  async function canWriteFirst(ownerId: string): Promise<CanWriteNow> {
    if (deliver ? isPreviewOwner(ownerId) : options.writesFirstToChat !== true) return "never";
    if (deliver && (await getPerson(db, ownerId))?.blockedAt) return "never";
    return !(await options.isEmergencyStopped?.());
  }

  const flow = createAgentFlow({
    ...firstAppConfirmations(),
    loadFlow: ({ chat }) => loadPlacedFlow(db, chat.id, clock.now()),
    store: postgresFlowStore(options.pool),
    judge: { fallback: options.judgeFallback ?? DEFAULT_MODEL_CHOICE, openrouter: judgeOpenRouter(env) },
    firstMessages: {
      quietHours: FIRST_MESSAGES_QUIET_HOURS,
      maxPerDay: FIRST_MESSAGES_PER_DAY,
      canWriteNow: ({ ownerId }) => canWriteFirst(ownerId),
    },
    onTransition: (event) => events.onTransition(event),
    onFinish: (event) => events.onFinish(event),
    clientCard: leadMagnetClientCard(db),
    clientFacts: true,
    people: leadMagnetPeople(db),
    pause: { staffSilenceHours: STAFF_SILENCE_HOURS },
    // Пояс человека ещё неизвестен (закрепление при входе по ссылке, до первого хода) — день считается по Москве
    defaultTimeZone: AGENT_TIME_ZONE,
    now: () => clock.now(),
    ...(options.logError && { logError: options.logError }),
  });
  return Object.assign(flow, { attachPorts: (portFor: FlowAttachment["portFor"]) => flow.attach({ portFor, ...(deliver && { deliver }) }) });
}
