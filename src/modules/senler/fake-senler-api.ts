// Подделка сервера Senler для тестов: подставляется вместо `fetch`, в сеть ничего не уходит.
// Как настоящий: JSON в теле POST, ответ `{ success, ... }` или `{ success: false, error_code, error_message }`.

export interface SenlerRequest {
  method: string;
  /** Всё тело запроса, включая `access_token`, `v` и `vk_group_id`. */
  body: Record<string, unknown>;
}

export interface SenlerReply {
  status: number;
  body: unknown;
}

export const senlerError = (code: number, message: string): SenlerReply => ({
  status: 200,
  body: { success: false, error_code: code, error_message: message },
});

export interface FakeSenlerGroup {
  id: number;
  name: string;
}

interface FakeSubscriber {
  /** 1 — активный, 2 — неактивный (отписался), 3 — чёрный список. */
  leadStatus: number;
  subscriptions: Array<{ subscription_id: number; source: string }>;
  utms: Array<{ utm_source?: string }>;
}

/** Ключ, который подделка принимает, и сообщество, к которому он выдан. Остальные ключи — ошибка 14. */
export const FAKE_SENLER_KEY = "senler-key-ok";
export const FAKE_SENLER_VK_GROUP = "222333";

export class FakeSenlerApi {
  readonly requests: SenlerRequest[] = [];
  groups: FakeSenlerGroup[] = [
    { id: 101, name: "Подписчики марафона" },
    { id: 102, name: "Весенний интенсив" },
  ];
  /** Ключи и сообщества, к которым они выданы. */
  readonly keys = new Map<string, string>([[FAKE_SENLER_KEY, FAKE_SENLER_VK_GROUP]]);
  /** Принятый ключ годится для любого сообщества: сквозные проверки заводят ботов с разными id. */
  acceptAnyCommunity = false;
  /** Подписчики по id ВК. */
  readonly subscribers = new Map<string, FakeSubscriber>();
  private readonly scripted = new Map<string, Array<SenlerReply | Error>>();

  /** Следующий вызов метода получит этот ответ (или упадёт этой ошибкой сети). Ответы выдаются по очереди. */
  replyOnce(method: string, reply: SenlerReply | Error): void {
    this.scripted.set(method, [...(this.scripted.get(method) ?? []), reply]);
  }

  callsTo(method: string): SenlerRequest[] {
    return this.requests.filter((request) => request.method === method);
  }

  /** Человек подписан на группы Senler (`0` — «без группы»). */
  subscribe(vkUserId: string, groupIds: number[]): void {
    this.subscribers.set(vkUserId, { leadStatus: 1, subscriptions: groupIds.map((id) => ({ subscription_id: id, source: "keyword" })), utms: [] });
  }

  /** Человек отписался от сообщества: запись и подписки в Senler остаются, статус — неактивный. */
  unsubscribe(vkUserId: string): void {
    const subscriber = this.subscribers.get(vkUserId);
    if (subscriber) subscriber.leadStatus = 2;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = url.pathname.replace(/^\/api\//, "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    this.requests.push({ method, body });
    const next = this.scripted.get(method)?.shift();
    if (next instanceof Error) throw next;
    const reply = next ?? this.answer(method, body);
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };

  private answer(method: string, body: Record<string, unknown>): SenlerReply {
    const ok = (data: Record<string, unknown>): SenlerReply => ({ status: 200, body: { success: true, ...data } });
    if (!body.group_id && !body.vk_group_id) return senlerError(1, "Missing group_id, vk_group_id, tg_bot_id or max_bot_id");
    const keyGroup = this.keys.get(String(body.access_token ?? ""));
    if (!keyGroup) return senlerError(14, "Token access denied");
    if (!this.acceptAnyCommunity && String(body.vk_group_id) !== keyGroup) return senlerError(6, "Group not found");

    if (method === "subscriptions/get") {
      const offset = Number(body.offset ?? 0);
      const count = Math.min(Number(body.count ?? 100), 100);
      const items = this.groups.slice(offset, offset + count).map((group) => ({ subscription_id: group.id, name: group.name }));
      return ok({ count: this.groups.length, items });
    }
    if (method === "subscribers/add") {
      const groupId = Number(body.subscription_id);
      if (groupId !== 0 && !this.groups.some((group) => group.id === groupId)) return senlerError(7, "Subscription not found");
      const vkUserId = String(body.vk_user_id);
      const subscriber = this.subscribers.get(vkUserId) ?? { leadStatus: 1, subscriptions: [], utms: [] };
      if (!subscriber.subscriptions.some((entry) => entry.subscription_id === groupId))
        subscriber.subscriptions.push({ subscription_id: groupId, source: "api" });
      if (typeof body.utm_source === "string") subscriber.utms.push({ utm_source: body.utm_source });
      this.subscribers.set(vkUserId, subscriber);
      return ok({});
    }
    if (method === "subscribers/get") {
      const found = this.subscribers.get(String(body.vk_user_id));
      const subscriber = found && (body.lead_status === undefined || Number(body.lead_status) === found.leadStatus) ? found : undefined;
      const items = subscriber ? [{ vk_user_id: Number(body.vk_user_id), subscriptions: subscriber.subscriptions, utms: subscriber.utms }] : [];
      return ok({ items, offset_id: "" });
    }
    return senlerError(0, `Unknown method ${method}`);
  }
}
