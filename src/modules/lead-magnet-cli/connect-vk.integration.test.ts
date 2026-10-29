// `connect-vk`: сообщество ВК подключается тем же путём, что форма «Боты», а ключ приходит только со стандартного ввода.
// Сообщество могут делить несколько серверов: убрать можно только сервер с точным адресом, чужие остаются.
import { standardCatalog } from "@ykurilov/agent-chat-core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createBotService } from "../channels/bots";
import { bots } from "../channels/schema";
import { createVkAdapter } from "../channels/vk/adapter";
import { FakeVkApi, vkError } from "../channels/vk/fake-vk-api";
import { createTokenCipher } from "../platform/crypto";
import { runLeadMagnetCli, type LeadMagnetCliDependencies } from "./run";

const TOKEN = "vk1.a.community-key-from-old-server-0123456789";
const PUBLIC_BASE_URL = "https://livem.test";
const OLD_SERVER = "https://old-server.example.com/api/integrations/vk/callback";
const SENLER = "https://senler.ru/callback/vk/1126713";
const OTHER_SERVICE = "https://other-service.example.com/api/messengers/vk/callback";
/** Похожие на адрес старого сервера, но не он: удалять нельзя. */
const LOOKALIKES = [`${OLD_SERVER}/`, `${OLD_SERVER}?v=2`, OLD_SERVER.replace("https:", "http:")];

const cipher = createTokenCipher(Buffer.alloc(32, 5).toString("base64"));

let database: TestDatabase;
let api: FakeVkApi;
let deps: LeadMagnetCliDependencies;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("delete from app.bots");
  api = new FakeVkApi();
  api.callbackServers = [
    { id: 1, url: OLD_SERVER, title: "Старый сервер" },
    { id: 2, url: SENLER, title: "Senler" },
    { id: 3, url: OTHER_SERVICE, title: "Другой сервис" },
    ...LOOKALIKES.map((url, index) => ({ id: 10 + index, url, title: "Похожий" })),
  ];
  const vk = createVkAdapter({ apiBaseUrl: "https://vk-api.test", fetch: api.fetch });
  const adapters = { vk };
  deps = {
    db: database.db,
    catalog: standardCatalog,
    adapters,
    allowedEmails: new Set(),
    vkConnection: () => ({
      vk,
      cipher,
      publicBaseUrl: PUBLIC_BASE_URL,
      botService: createBotService({
        db: database.db,
        adapters,
        cipher,
        alerts: { resolve: vi.fn() },
        queue: { enqueue: vi.fn() },
        publicBaseUrl: PUBLIC_BASE_URL,
      }),
    }),
  };
});

const run = (args: string[], stdin = TOKEN) => runLeadMagnetCli(["connect-vk", ...args], stdin, deps);
const serverUrls = () => api.callbackServers.map((server) => server.url);

describe("connect-vk", () => {
  it("подключает сообщество как форма «Боты»: права ключа, наш Callback-сервер, бот в базе; вывод — id бота, сообщество, номер сервера", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.output);
    const [row] = await database.db.select().from(bots);
    expect(row).toMatchObject({ channel: "vk", externalId: "222333", title: "Живые лидмагниты", status: "ok" });
    expect(output).toEqual({
      botId: row!.id,
      title: "Живые лидмагниты",
      username: "live_magnet_club",
      groupId: "222333",
      alreadyConnected: false,
      callbackServerId: 77,
      removedCallbackServerIds: [],
    });
    expect(api.callsTo("groups.getTokenPermissions").length).toBeGreaterThan(0);
    expect(api.callbackServers).toContainEqual(expect.objectContaining({ id: 77, url: `${PUBLIC_BASE_URL}/api/webhooks/vk/${row!.id}` }));
    // Чужие серверы на месте
    expect(serverUrls()).toEqual(expect.arrayContaining([OLD_SERVER, SENLER, OTHER_SERVICE, ...LOOKALIKES]));
    expect(api.callsTo("groups.deleteCallbackServer")).toEqual([]);
  });

  it("--remove-callback: после подключения убирает только сервер с точным адресом, Senler, другой сервис и похожие адреса остаются", async () => {
    const result = await run(["--remove-callback", OLD_SERVER]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ callbackServerId: 77, removedCallbackServerIds: [1] });
    expect(api.callsTo("groups.deleteCallbackServer").map((call) => call.params.server_id)).toEqual(["1"]);
    expect(serverUrls()).not.toContain(OLD_SERVER);
    expect(serverUrls()).toEqual(expect.arrayContaining([SENLER, OTHER_SERVICE, ...LOOKALIKES]));
    // Сначала наш сервер, потом удаление: сообщество не остаётся без приёма сообщений
    const methods = api.requests.map((request) => request.method);
    expect(methods.indexOf("groups.setCallbackSettings")).toBeLessThan(methods.indexOf("groups.deleteCallbackServer"));
  });

  it("сообщество уже подключено — второй сервер не добавляется, удаление по адресу работает", async () => {
    await run([]);
    const result = await run(["--remove-callback", OLD_SERVER]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ alreadyConnected: true, callbackServerId: 77, removedCallbackServerIds: [1] });
    expect(api.callsTo("groups.addCallbackServer")).toHaveLength(1);
    expect(await database.db.select().from(bots)).toHaveLength(1);
  });

  it("сервера с таким адресом нет — ничего не удаляется", async () => {
    const result = await run(["--remove-callback", "https://nowhere.test/hook"]);
    expect(JSON.parse(result.output)).toMatchObject({ removedCallbackServerIds: [] });
    expect(api.callsTo("groups.deleteCallbackServer")).toEqual([]);
  });

  it("свой сервер или не https-адрес удалить нельзя: отказ до обращения к ВК", async () => {
    for (const url of ["http://example.test/hook", "не адрес", `${PUBLIC_BASE_URL}/api/webhooks/vk/любой`]) {
      const result = await run(["--remove-callback", url]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toMatch(/^Ошибка: /);
    }
    expect(api.requests).toEqual([]);
  });

  it("ключ только со стандартного ввода: пустой ввод — понятная ошибка", async () => {
    const result = await run([], "  \n");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("стандартный ввод");
    expect(api.requests).toEqual([]);
  });

  it("ключа нет ни в выводе, ни в ошибках — даже когда ВК возвращает его в тексте ошибки", async () => {
    const ok = await run(["--remove-callback", OLD_SERVER]);
    expect(ok.output).not.toContain(TOKEN);

    await database.pool.query("delete from app.bots");
    api.replyOnce("groups.getById", vkError(5, `User authorization failed: invalid access_token ${TOKEN}`));
    const rejected = await run([]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.output).not.toContain(TOKEN);

    api.replyOnce("groups.deleteCallbackServer", vkError(15, `Access denied for ${TOKEN}`));
    const failedRemoval = await run(["--remove-callback", SENLER]);
    expect(failedRemoval.exitCode).toBe(1);
    expect(failedRemoval.output).not.toContain(TOKEN);
  });

  it("у ключа нет права «Управление сообществом» — отказ с названием права, бот не сохраняется", async () => {
    api.replyOnce("groups.getTokenPermissions", { status: 200, body: { response: { mask: 4096 + 4 } } });
    const result = await run(["--remove-callback", OLD_SERVER]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Управление сообществом");
    expect(await database.db.select().from(bots).where(eq(bots.channel, "vk"))).toEqual([]);
    expect(serverUrls()).toContain(OLD_SERVER);
  });
});
