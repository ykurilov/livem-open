import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_TIME_ZONE,
  DEFAULT_MODEL_CHOICE,
  PROVIDER_FALLBACK,
  STUB_MODEL_CHOICE,
  createAppCatalog,
  createStubModelCatalog,
} from "./models-catalog";

function recordedFetch() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ error: { message: "stop" } }), { status: 400, headers: { "content-type": "application/json" } });
  });
  return { calls, fetch: fetchStub as unknown as typeof globalThis.fetch };
}

// Модели SDK в тестах вызываем напрямую, как это делает ядро
type CallableModel = { doGenerate(options: unknown): Promise<{ content: unknown[] }> };

async function callProvider(catalog: ReturnType<typeof createAppCatalog>, providerId: string, fetch: typeof globalThis.fetch) {
  const provider = catalog.providers.find((candidate) => candidate.id === providerId)!;
  const model = catalog.models.find((candidate) => candidate.id === DEFAULT_MODEL_CHOICE.modelId)!;
  const language = provider.createLanguageModel(model.providerModelIds[providerId]!, `${providerId}-key`, { fetch }) as unknown as CallableModel;
  await language
    .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "привет" }] }] })
    .catch(() => undefined);
}

describe("каталог моделей приложения", () => {
  it("по умолчанию — DeepSeek 4.1 Flash у самого DeepSeek; запасные — Together, потом OpenRouter", () => {
    expect(DEFAULT_MODEL_CHOICE).toEqual({ providerId: "deepseek", modelId: "deepseek-4.1-flash" });
    expect(PROVIDER_FALLBACK).toEqual({ byModel: { "deepseek-4.1-flash": ["together", "openrouter"] } });
    const catalog = createAppCatalog({});
    const model = catalog.models.find((candidate) => candidate.id === "deepseek-4.1-flash");
    expect(model?.providerModelIds.deepseek).toBe("deepseek-flash");
    // Снимок страницы модель видит у запасных провайдеров
    expect(model?.toolResultImageProviders).toEqual(expect.arrayContaining(["deepseek", "openrouter"]));
  });

  it("часовой пояс агента — Москва", () => {
    expect(AGENT_TIME_ZONE).toBe("Europe/Moscow");
  });

  it("с TOGETHER_BASE_URL запросы идут на этот адрес с заголовком X-Proxy-Token", async () => {
    const { calls, fetch } = recordedFetch();
    const catalog = createAppCatalog({
      TOGETHER_BASE_URL: "https://proxy.example.test/together/v1",
      PROXY_TOKEN: "secret-proxy-token",
    });
    await callProvider(catalog, "together", fetch);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.startsWith("https://proxy.example.test/together/v1/")).toBe(true);
    expect(calls[0]!.headers.get("x-proxy-token")).toBe("secret-proxy-token");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer together-key");
  });

  it("без TOGETHER_BASE_URL запросы идут напрямую на api.together.xyz без заголовка прокси", async () => {
    const { calls, fetch } = recordedFetch();
    await callProvider(createAppCatalog({ PROXY_TOKEN: "secret-proxy-token" }), "together", fetch);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("api.together.xyz");
    expect(calls[0]!.headers.get("x-proxy-token")).toBeNull();
  });

  it("TOGETHER_BASE_URL без PROXY_TOKEN — ошибка настройки, а не тихий запрос без токена", () => {
    expect(() => createAppCatalog({ TOGETHER_BASE_URL: "https://proxy.example.test/together/v1" })).toThrow(/PROXY_TOKEN/);
  });

  it("тестовый провайдер отдаёт подставленную модель", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "готово" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    const catalog = createStubModelCatalog(createAppCatalog({}), model);
    const provider = catalog.providers.find((candidate) => candidate.id === STUB_MODEL_CHOICE.providerId)!;
    const language = provider.createLanguageModel("stub-v1", "не-важно") as unknown as CallableModel;
    const result = await language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "привет" }] }] });
    expect(result.content[0]).toMatchObject({ type: "text", text: "готово" });
  });
});
