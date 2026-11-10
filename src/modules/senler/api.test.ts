import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSenlerApi, SenlerError, type SenlerApi } from "./api";
import { FAKE_SENLER_KEY, FAKE_SENLER_VK_GROUP, FakeSenlerApi, senlerError } from "./fake-senler-api";

const access = { apiKey: FAKE_SENLER_KEY, vkGroupId: FAKE_SENLER_VK_GROUP };

let fake: FakeSenlerApi;
let api: SenlerApi;

beforeEach(() => {
  fake = new FakeSenlerApi();
  api = createSenlerApi({ fetch: fake.fetch, timeoutMs: 200 });
});

async function failureOf(work: Promise<unknown>): Promise<SenlerError> {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(SenlerError);
  return error as SenlerError;
}

describe("запросы к Senler", () => {
  it("ключ, версия 2 и сообщество ВК — в каждом запросе", async () => {
    await api.listGroups(access);
    expect(fake.requests[0]).toMatchObject({
      method: "subscriptions/get",
      body: { access_token: FAKE_SENLER_KEY, v: 2, vk_group_id: FAKE_SENLER_VK_GROUP },
    });
  });

  it("группы подписчиков — все страницы списка", async () => {
    fake.groups = Array.from({ length: 130 }, (_, index) => ({ id: index + 1, name: `Группа ${index + 1}` }));
    const groups = await api.listGroups(access);
    expect(groups).toHaveLength(130);
    expect(groups[0]).toEqual({ id: "1", name: "Группа 1" });
    expect(fake.callsTo("subscriptions/get").map((call) => call.body.offset)).toEqual([0, 100]);
  });

  it("добавление: человек, группа и метка источника", async () => {
    await api.addSubscriber(access, { vkUserId: "555", groupId: "102", source: "Весенний интенсив" });
    expect(fake.callsTo("subscribers/add")[0]!.body).toMatchObject({ vk_user_id: 555, subscription_id: 102, utm_source: "Весенний интенсив" });
  });

  it("добавление без метки — без utm_source", async () => {
    await api.addSubscriber(access, { vkUserId: "555", groupId: "102", source: null });
    expect(fake.callsTo("subscribers/add")[0]!.body).not.toHaveProperty("utm_source");
  });

  it("подписчик — тот, у кого есть подписка на группу; «без группы» и незнакомый — нет", async () => {
    fake.subscribe("1", [101]);
    fake.subscribe("2", [0]);
    expect(await api.isSubscriber(access, "1")).toBe(true);
    expect(await api.isSubscriber(access, "2")).toBe(false);
    expect(await api.isSubscriber(access, "3")).toBe(false);
    expect(fake.callsTo("subscribers/get")[0]!.body).toMatchObject({ vk_user_id: 1 });
  });
});

describe("проверка подписчика", () => {
  it("только активные: отписавшийся (неактивный) — не подписчик", async () => {
    fake.subscribe("1", [101]);
    fake.unsubscribe("1");
    expect(await api.isSubscriber(access, "1")).toBe(false);
    expect(fake.callsTo("subscribers/get")[0]!.body).toMatchObject({ lead_status: 1 });
  });

  it("ответ непонятного вида — отказ, а не «не подписчик»", async () => {
    fake.replyOnce("subscribers/get", { status: 200, body: { success: true, subscribers: [] } });
    expect((await failureOf(api.isSubscriber(access, "1"))).kind).toBe("rejected");
    fake.replyOnce("subscribers/get", { status: 200, body: { success: true, items: [{ vk_user_id: 2 }] } });
    expect((await failureOf(api.isSubscriber(access, "2"))).kind).toBe("rejected");
  });

  it("ответ помнится две минуты: рассылка не упирается в лимит Senler", async () => {
    let now = 0;
    api = createSenlerApi({ fetch: fake.fetch, now: () => now });
    fake.subscribe("1", [101]);
    expect(await api.isSubscriber(access, "1")).toBe(true);
    expect(await api.isSubscriber(access, "1")).toBe(true);
    expect(fake.callsTo("subscribers/get")).toHaveLength(1);
    now += 2 * 60_000 + 1;
    expect(await api.isSubscriber(access, "1")).toBe(true);
    expect(fake.callsTo("subscribers/get")).toHaveLength(2);
  });

  it("сбой не запоминается", async () => {
    fake.replyOnce("subscribers/get", new TypeError("fetch failed"));
    expect((await failureOf(api.isSubscriber(access, "1"))).kind).toBe("unavailable");
    expect(await api.isSubscriber(access, "1")).toBe(false);
  });

  it("ждём ответа «подписчик ли» не дольше 5 секунд, список групп — один срок на все страницы", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    let now = 0;
    const slow: typeof fetch = async (input, init) => {
      now += 6_000;
      return fake.fetch(input, init);
    };
    api = createSenlerApi({ fetch: slow, now: () => now, timeoutMs: 10_000 });
    await api.isSubscriber(access, "1");
    expect(timeouts).toHaveBeenLastCalledWith(5_000);

    timeouts.mockClear();
    fake.groups = Array.from({ length: 450 }, (_, index) => ({ id: index + 1, name: `Группа ${index + 1}` }));
    expect((await failureOf(api.listGroups(access))).kind).toBe("unavailable");
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([10_000, 4_000]);
    timeouts.mockRestore();
  });
});

describe("ошибки Senler — понятным видом", () => {
  it("человек запретил сообщения — отдельный вид отказа", async () => {
    fake.replyOnce("subscribers/add", senlerError(4, "User not allowed messages"));
    expect((await failureOf(api.addSubscriber(access, { vkUserId: "1", groupId: "101", source: null }))).kind).toBe("person_refused");
  });

  it("неверный ключ", async () => {
    const error = await failureOf(api.listGroups({ ...access, apiKey: "wrong" }));
    expect(error.kind).toBe("bad_key");
    expect(error.message).toContain("ключ");
  });

  it("ключ от другого сообщества", async () => {
    const error = await failureOf(api.listGroups({ ...access, vkGroupId: "999" }));
    expect(error.kind).toBe("other_community");
  });

  it("группа удалена", async () => {
    const error = await failureOf(api.addSubscriber(access, { vkUserId: "5", groupId: "404", source: null }));
    expect(error.kind).toBe("group_missing");
    expect(error.message).toContain("удалена");
  });

  it("сбой сети, ответ сервера 502, лимит запросов и неизвестный сбой — «Senler не отвечает»", async () => {
    fake.replyOnce("subscriptions/get", new TypeError("fetch failed"));
    fake.replyOnce("subscriptions/get", { status: 502, body: "Bad gateway" });
    fake.replyOnce("subscriptions/get", senlerError(9, "Too many requests"));
    fake.replyOnce("subscriptions/get", senlerError(0, "Unknown error"));
    for (let attempt = 0; attempt < 4; attempt++) {
      const error = await failureOf(api.listGroups(access));
      expect(error.kind).toBe("unavailable");
      expect(error.message).toContain("Senler не отвечает");
    }
  });

  it("долгий ответ обрывается по сроку", async () => {
    const slow = createSenlerApi({ fetch: (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))), timeoutMs: 20, subscriberTimeoutMs: 20 });
    const error = await failureOf(slow.isSubscriber(access, "1"));
    expect(error.kind).toBe("unavailable");
  });

  it("прочие отказы — текст Senler", async () => {
    fake.replyOnce("subscribers/add", senlerError(12, "Invalid parameter value"));
    const error = await failureOf(api.addSubscriber(access, { vkUserId: "5", groupId: "101", source: null }));
    expect(error.kind).toBe("rejected");
    expect(error.message).toContain("Invalid parameter value");
  });
});
