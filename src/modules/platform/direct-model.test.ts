import { generateText } from "ai";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withDirectModel } from "./direct-model";
import { createAppCatalog, DEFAULT_MODEL_CHOICE } from "./models-catalog";

/** Together, DeepSeek и OpenRouter на одном локальном сервере: кто «лежит» и с каким кодом, задаёт тест. */
let server: Server;
let base: string;
let failures: Record<string, number> = {};
let calls: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const provider = request.url!.split("/")[1]!;
    calls.push(provider);
    request.resume();
    const status = failures[provider];
    if (status) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "nope" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "gen-1",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: `ответ ${provider}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  failures = {};
  calls = [];
});

function deps() {
  const env = {
    DEEPSEEK_BASE_URL: `${base}/deepseek`,
    OPENROUTER_BASE_URL: `${base}/openrouter`,
    TOGETHER_BASE_URL: `${base}/together`,
    PROXY_TOKEN: "test-proxy-token",
    DEEPSEEK_API_KEY: "k1",
    OPENROUTER_API_KEY: "k2",
    TOGETHER_API_KEY: "k3",
  };
  return { catalog: createAppCatalog(env), env };
}

const ask = () =>
  withDirectModel(deps(), DEFAULT_MODEL_CHOICE, "chat-1", async (direct) => ({
    text: (await generateText({ model: direct.model, prompt: "привет", maxRetries: 0 })).text,
    providerId: direct.providerId,
    price: direct.price,
  }));

describe("вызов модели мимо SDK с запасными провайдерами", () => {
  it("DeepSeek отвечает — запасные не зовутся", async () => {
    expect(await ask()).toMatchObject({ text: "ответ deepseek", providerId: "deepseek" });
    expect(calls).toEqual(["deepseek"]);
  });

  it.each([503, 429])("DeepSeek отвечает %i — вызов уходит на Together по его цене, OpenRouter не трогается", async (status) => {
    failures.deepseek = status;
    const answer = await ask();
    expect(answer).toMatchObject({ text: "ответ together", providerId: "together" });
    expect(answer.price).toEqual(deps().catalog.models.find((model) => model.id === DEFAULT_MODEL_CHOICE.modelId)!.pricing!.together);
    expect(calls).toEqual(["deepseek", "together"]);
  });

  it("лежат DeepSeek и Together — вызов уходит на OpenRouter", async () => {
    failures.deepseek = 503;
    failures.together = 503;
    expect(await ask()).toMatchObject({ text: "ответ openrouter", providerId: "openrouter" });
    expect(calls).toEqual(["deepseek", "together", "openrouter"]);
  });

  it("неверный ключ — не перегрузка: ошибка, без запасного", async () => {
    failures.deepseek = 401;
    await expect(ask()).rejects.toThrow();
    expect(calls).toEqual(["deepseek"]);
  });

  it("упали все — ошибка последнего запасного", async () => {
    failures.deepseek = 503;
    failures.together = 503;
    failures.openrouter = 503;
    await expect(ask()).rejects.toThrow();
    expect(calls).toEqual(["deepseek", "together", "openrouter"]);
  });
});
