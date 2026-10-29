// Модель персонажей eval: своя модель через OpenRouter у одного закреплённого поставщика, одна температура на всех.
import { describe, expect, it } from "vitest";
import { createAppCatalog } from "@/modules/platform/models-catalog";
import { createPersona } from "./persona";
import { findPersonaEndpoint, openPersonaRoute, PERSONA_MODEL_DEFAULTS, personaModelSettings, type PersonaEndpoint } from "./persona-model";

const endpoint = (tag: string, providerName: string, extra: Record<string, unknown> = {}) => ({
  provider_name: providerName,
  tag,
  status: 0,
  uptime_last_1d: 100,
  supported_parameters: ["reasoning", "temperature", "tools", "tool_choice"],
  pricing: { prompt: "0.00000015", completion: "0.0000005", input_cache_read: "0.00000003" },
  ...extra,
});

const endpointsApi =
  (endpoints: unknown[], status = 200) =>
  async (input: RequestInfo | URL): Promise<Response> => {
    expect(String(input)).toContain(`/api/v1/models/${PERSONA_MODEL_DEFAULTS.model}/endpoints`);
    return new Response(JSON.stringify(status === 200 ? { data: { id: PERSONA_MODEL_DEFAULTS.model, endpoints } } : { error: { message: "No model" } }), { status });
  };

describe("personaModelSettings", () => {
  it("по умолчанию — GLM-5.3 Flash у одного поставщика с заданной температурой", () => {
    expect(personaModelSettings({}, {})).toEqual(PERSONA_MODEL_DEFAULTS);
    expect(PERSONA_MODEL_DEFAULTS.model).toBe("z-ai/glm-5.3-flash");
    expect(PERSONA_MODEL_DEFAULTS.model).not.toContain(":nitro");
    expect(typeof PERSONA_MODEL_DEFAULTS.temperature).toBe("number");
  });

  it("переменные окружения меняют умолчания, флаги главнее переменных", () => {
    const env = { EVAL_PERSONA_MODEL: "z-ai/glm-5.3", EVAL_PERSONA_PROVIDER: "together", EVAL_PERSONA_TEMPERATURE: "0.3" };
    expect(personaModelSettings({}, env)).toMatchObject({ model: "z-ai/glm-5.3", provider: "together", temperature: 0.3 });
    expect(personaModelSettings({ provider: "fireworks", temperature: "1" }, env)).toMatchObject({ model: "z-ai/glm-5.3", provider: "fireworks", temperature: 1 });
  });

  it("неверная температура и пустой поставщик — ошибка до прогона", () => {
    expect(() => personaModelSettings({ temperature: "abc" }, {})).toThrow(/температур/i);
    expect(() => personaModelSettings({ temperature: "3" }, {})).toThrow(/температур/i);
    expect(() => personaModelSettings({ provider: " " }, {})).toThrow(/поставщик/i);
    expect(() => personaModelSettings({ model: "z-ai/glm-5.3-flash:nitro" }, {})).toThrow(/nitro/);
  });
});

describe("findPersonaEndpoint", () => {
  it("находит точку поставщика по тегу и берёт её цены за миллион токенов", async () => {
    const found = await findPersonaEndpoint(PERSONA_MODEL_DEFAULTS, { apiKey: "k", fetch: endpointsApi([endpoint("fireworks", "Fireworks"), endpoint("friendli", "Friendli")]) });
    expect(found.providerName).toBe("Friendli");
    expect(found.pricing).toEqual({ inputPerMillion: 0.15, outputPerMillion: 0.5, cachedInputPerMillion: 0.03 });
    expect(found.reasoning).toBe(true);
  });

  it("поставщика нет у модели — ошибка со списком тех, кто есть", async () => {
    await expect(findPersonaEndpoint(PERSONA_MODEL_DEFAULTS, { apiKey: "k", fetch: endpointsApi([endpoint("fireworks", "Fireworks")]) })).rejects.toThrow(/friendli.*fireworks/s);
  });

  it("у поставщика несколько точек — просит точный тег, иначе OpenRouter выберет любую", async () => {
    const settings = { ...PERSONA_MODEL_DEFAULTS, provider: "fireworks" };
    const api = endpointsApi([endpoint("fireworks", "Fireworks"), endpoint("fireworks/us", "Fireworks")]);
    await expect(findPersonaEndpoint({ ...settings, provider: "fire" }, { apiKey: "k", fetch: api })).rejects.toThrow();
    expect((await findPersonaEndpoint(settings, { apiKey: "k", fetch: api })).providerName).toBe("Fireworks");
    const twoVariants = endpointsApi([endpoint("sail-research/us", "Sail Research"), endpoint("sail-research/fp4", "Sail Research")]);
    await expect(findPersonaEndpoint({ ...settings, provider: "sail-research" }, { apiKey: "k", fetch: twoVariants })).rejects.toThrow(/sail-research\/us/);
  });

  it("модели нет в OpenRouter — ошибка", async () => {
    await expect(findPersonaEndpoint(PERSONA_MODEL_DEFAULTS, { apiKey: "k", fetch: endpointsApi([], 404) })).rejects.toThrow(/404/);
  });
});

/** Ответ OpenRouter потоком: реплика персонажа от поставщика `servedBy`. */
function openRouterStream(text: string, servedBy: string): Response {
  const chunk = (body: Record<string, unknown>) => `data: ${JSON.stringify({ id: "gen-1", provider: servedBy, model: PERSONA_MODEL_DEFAULTS.model, created: 1, object: "chat.completion.chunk", ...body })}\n\n`;
  const sse =
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) +
    "data: [DONE]\n\n";
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}

describe("openPersonaRoute", () => {
  it("ответ с ошибкой (429) — не «ответил другой поставщик»: его повторяют, а считается удачный ответ", async () => {
    let call = 0;
    const route = openPersonaRoute(PERSONA_MODEL_DEFAULTS, { providerName: "Friendli", pricing: { inputPerMillion: 0.15, outputPerMillion: 0.5 }, reasoning: true }, {
      catalog: createAppCatalog({}),
      env: { OPENROUTER_API_KEY: "k" },
      fetch: async () => ((call += 1) === 1 ? new Response(JSON.stringify({ error: { message: "Rate limit", code: 429 } }), { status: 429 }) : openRouterStream("Ага.", "Friendli")),
    });
    const persona = await createPersona({ model: route, instructions: "Ты клиент.", exitTool: "leave_chat", exitDescription: "Уйти" });
    expect((await persona.reply("Привет")).text).toBe("Ага.");
    expect(await route.report()).toMatchObject({ requests: 2, served: { Friendli: 1 }, offRoute: 0, failed: 1 });
  });

  const found: PersonaEndpoint = { providerName: "Friendli", pricing: { inputPerMillion: 0.15, outputPerMillion: 0.5 }, reasoning: true };

  it("запрос персонажа уходит к закреплённому поставщику без запасных, с заданной температурой; отчёт — кто ответил", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const route = openPersonaRoute(PERSONA_MODEL_DEFAULTS, found, {
      catalog: createAppCatalog({}),
      env: { OPENROUTER_API_KEY: "k" },
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return openRouterStream("Ну, допустим.", bodies.length === 1 ? "Friendli" : "Fireworks");
      },
    });
    const persona = await createPersona({ model: route, instructions: "Ты клиент.", exitTool: "leave_chat", exitDescription: "Уйти" });
    expect((await persona.reply("Привет")).text).toBe("Ну, допустим.");
    await persona.reply("Как дела?");

    expect(bodies[0]).toMatchObject({ model: PERSONA_MODEL_DEFAULTS.model, temperature: PERSONA_MODEL_DEFAULTS.temperature, provider: { order: ["friendli"], allow_fallbacks: false } });
    expect(await route.report()).toEqual({
      model: PERSONA_MODEL_DEFAULTS.model,
      provider: "friendli",
      temperature: PERSONA_MODEL_DEFAULTS.temperature,
      requests: 2,
      served: { Friendli: 1, Fireworks: 1 },
      offRoute: 1,
      failed: 0,
    });
    expect((await persona.usage()).costUsd).toBeGreaterThan(0);
  });
});
