// Запросы к API Senler v2: POST https://senler.ru/api/<метод>, JSON с ключом, версией и сообществом ВК.
// Вместо внутреннего номера канала Senler принимает `vk_group_id` — id сообщества, который у бота ВК уже есть.

/**
 * `bad_key` — ключ не найден или отозван; `other_community` — ключ выдан для другого сообщества; `group_missing` — группы
 * подписчиков нет; `unavailable` — Senler не ответил или перегружен (стоит повторить); `person_refused` — человек
 * запретил сообществу сообщения (его выбор, не ошибка настройки); `rejected` — прочие отказы и ответ непонятного вида.
 */
export type SenlerFailureKind = "bad_key" | "other_community" | "group_missing" | "unavailable" | "person_refused" | "rejected";

export class SenlerError extends Error {
  constructor(
    readonly kind: SenlerFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "SenlerError";
  }
}

export interface SenlerAccess {
  apiKey: string;
  /** Id сообщества ВК, к которому подключён Senler. */
  vkGroupId: string;
}

export interface SenlerGroup {
  id: string;
  name: string;
}

export interface SenlerApi {
  /** Группы подписчиков канала. Заодно проверяет ключ. */
  listGroups(access: SenlerAccess): Promise<SenlerGroup[]>;
  /** Добавить человека в группу; `source` — метка источника (`utm_source`). */
  addSubscriber(access: SenlerAccess, input: { vkUserId: string; groupId: string; source: string | null }): Promise<void>;
  /** Активный подписчик хотя бы одной группы («без группы», неактивные и чёрный список не считаются). Ответ кэшируется. */
  isSubscriber(access: SenlerAccess, vkUserId: string): Promise<boolean>;
}

export interface SenlerApiConfig {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Сколько ждать ответа, мс; по умолчанию 10 секунд. Для списка групп — на все страницы вместе. */
  timeoutMs?: number;
  /** Сколько ждать ответа «подписчик ли»: он держит разбор входящего. По умолчанию 5 секунд. */
  subscriberTimeoutMs?: number;
  /** Сколько помнить ответ «подписчик ли»: рассылка Senler даёт сотни ответов подряд, лимит Senler — 20 запросов в секунду. */
  subscriberCacheMs?: number;
  /** Часы для кэша. */
  now?: () => number;
}

const DEFAULT_BASE_URL = "https://senler.ru/api";
const API_VERSION = 2;
const REQUEST_TIMEOUT_MS = 10_000;
const SUBSCRIBER_TIMEOUT_MS = 5_000;
const SUBSCRIBER_CACHE_MS = 2 * 60_000;
/** Senler отдаёт не больше 100 групп за запрос. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/** `lead_status` подписчика: 1 — активный, 2 — неактивный (отписался), 3 — чёрный список. */
const ACTIVE_LEAD = 1;

// Коды ошибок Senler (help.senler.ru → «Возвращаемые ошибки»). Кода «уже подписан» там нет.
const PERSON_REFUSED = 4;
const NO_COMMUNITY = 6;
const NO_GROUP = 7;
const TOO_MANY_REQUESTS = 9;
const UNKNOWN_FAILURE = 0;
const KEY_CODES = new Set([2, 3, 13, 14]);

const MESSAGES: Record<Exclude<SenlerFailureKind, "rejected">, string> = {
  person_refused: "Человек запретил сообществу присылать ему сообщения",
  bad_key: "Senler не принял ключ. Создайте ключ в Senler: «Настройки» → «Работа с API» — и вставьте его заново",
  other_community: "Ключ Senler выдан для другого сообщества ВК или сообщество не подключено к Senler",
  group_missing: "Группа подписчиков удалена в Senler: выберите другую",
  unavailable: "Senler не отвечает, попробуйте чуть позже",
};

const failure = (kind: Exclude<SenlerFailureKind, "rejected">) => new SenlerError(kind, MESSAGES[kind]);

interface SenlerReply {
  success?: boolean;
  error_code?: number;
  error_message?: string;
  [field: string]: unknown;
}

export function createSenlerApi(config: SenlerApiConfig = {}): SenlerApi {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const subscriberTimeoutMs = config.subscriberTimeoutMs ?? SUBSCRIBER_TIMEOUT_MS;
  const subscriberCacheMs = config.subscriberCacheMs ?? SUBSCRIBER_CACHE_MS;
  const now = config.now ?? Date.now;
  const subscriberCache = new Map<string, { subscriber: boolean; until: number }>();

  async function call(access: SenlerAccess, method: string, params: Record<string, unknown>, waitMs = timeoutMs): Promise<SenlerReply> {
    if (waitMs <= 0) throw failure("unavailable");
    let response: Response;
    let reply: SenlerReply;
    try {
      response = await doFetch(`${baseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_token: access.apiKey, v: API_VERSION, vk_group_id: access.vkGroupId, ...params }),
        signal: AbortSignal.timeout(waitMs),
      });
      reply = (await response.json()) as SenlerReply;
    } catch {
      throw failure("unavailable");
    }
    if (reply.success === true) return reply;
    if (!response.ok || typeof reply.error_code !== "number") throw failure("unavailable");
    const code = reply.error_code;
    if (KEY_CODES.has(code)) throw failure("bad_key");
    if (code === PERSON_REFUSED) throw failure("person_refused");
    if (code === NO_COMMUNITY) throw failure("other_community");
    if (code === NO_GROUP) throw failure("group_missing");
    if (code === TOO_MANY_REQUESTS || code === UNKNOWN_FAILURE) throw failure("unavailable");
    throw new SenlerError("rejected", `Senler отказал: ${reply.error_message ?? `ошибка ${code}`}`);
  }

  return {
    async listGroups(access) {
      const groups: SenlerGroup[] = [];
      // Один срок на весь список: медленный Senler не держит страницу кабинета минутами
      const deadline = now() + timeoutMs;
      for (let page = 0; page < MAX_PAGES; page++) {
        const reply = await call(access, "subscriptions/get", { count: PAGE_SIZE, offset: page * PAGE_SIZE }, deadline - now());
        const items = Array.isArray(reply.items) ? (reply.items as Array<{ subscription_id: unknown; name: unknown }>) : [];
        groups.push(...items.map((item) => ({ id: String(item.subscription_id), name: String(item.name ?? "") })));
        const total = typeof reply.count === "number" ? reply.count : 0;
        if (items.length < PAGE_SIZE || groups.length >= total) break;
      }
      return groups;
    },

    async addSubscriber(access, input) {
      await call(access, "subscribers/add", {
        vk_user_id: Number(input.vkUserId),
        subscription_id: Number(input.groupId),
        ...(input.source && { utm_source: input.source }),
      });
    },

    async isSubscriber(access, vkUserId) {
      const key = `${access.vkGroupId}:${access.apiKey}:${vkUserId}`;
      const cached = subscriberCache.get(key);
      if (cached && cached.until > now()) return cached.subscriber;
      const reply = await call(access, "subscribers/get", { vk_user_id: Number(vkUserId), lead_status: ACTIVE_LEAD, count: 1 }, subscriberTimeoutMs);
      const subscriber = activeSubscription(reply);
      if (subscriberCache.size > 10_000) subscriberCache.clear();
      subscriberCache.set(key, { subscriber, until: now() + subscriberCacheMs });
      return subscriber;
    },
  };
}

/**
 * Есть ли у человека подписка на группу. Пустой `items` — подписчика нет; ответ без `items[].subscriptions[]` — непонятного
 * вида: отказ, а не «не подписчик», иначе смена формата ответа молча включила бы бота поверх Senler.
 */
function activeSubscription(reply: SenlerReply): boolean {
  const malformed = () => new SenlerError("rejected", "Senler прислал ответ непонятного вида: проверить подписчика не удалось");
  if (!Array.isArray(reply.items)) throw malformed();
  return reply.items.some((item: unknown) => {
    const subscriptions = (item as { subscriptions?: unknown } | null)?.subscriptions;
    if (!Array.isArray(subscriptions)) throw malformed();
    return subscriptions.some((entry: { subscription_id?: unknown } | null) => entry != null && Number(entry.subscription_id) !== 0);
  });
}
