// Модель персонажей eval — эксперта и клиентов. Одно место настроек: модель, поставщик, температура, рассуждения.
// Персонажи идут на другой модели, чем агенты приложения, через OpenRouter у одного закреплённого поставщика без запасных:
// так ответы персонажей не скачут от поставщика к поставщику между прогонами и повторами.
import { createOpenRouterProvider, extendCatalog, type ModelCatalog, type ModelChoice, type ModelPriceRates, type ModelProfile } from "@ykurilov/agent-chat-core";

type Environment = Record<string, string | undefined>;

export interface PersonaModelSettings {
  /** Id модели в OpenRouter. */
  model: string;
  /** Тег точки поставщика в OpenRouter (`provider.order`), например `friendli` или `fireworks/us`. */
  provider: string;
  temperature: number;
  /** Уровень рассуждений, если модель их умеет. */
  reasoning: "low" | "medium" | "high";
}

/**
 * GLM-5.3 Flash у Friendli (замер `/endpoints` 2026-10-25): одна точка у поставщика, доступность 100 % за сутки,
 * задержка p50 0,6 с, p99 4 с, скорость ~130 ток/с, полная цена 0,15/0,5 $ за миллион — как у остальных.
 */
export const PERSONA_MODEL_DEFAULTS: PersonaModelSettings = { model: "z-ai/glm-5.3-flash", provider: "friendli", temperature: 0.7, reasoning: "low" };

const REASONING_LEVELS = ["low", "medium", "high"] as const;

/** Настройки персонажей: флаги запуска главнее переменных `EVAL_PERSONA_*`, те главнее умолчаний. */
export function personaModelSettings(flags: { model?: string; provider?: string; temperature?: string; reasoning?: string }, env: Environment): PersonaModelSettings {
  const pick = (flag: string | undefined, variable: string) => flag ?? env[variable];
  const model = (pick(flags.model, "EVAL_PERSONA_MODEL") ?? PERSONA_MODEL_DEFAULTS.model).trim();
  const provider = (pick(flags.provider, "EVAL_PERSONA_PROVIDER") ?? PERSONA_MODEL_DEFAULTS.provider).trim();
  const temperatureText = pick(flags.temperature, "EVAL_PERSONA_TEMPERATURE");
  const temperature = temperatureText === undefined ? PERSONA_MODEL_DEFAULTS.temperature : Number(temperatureText);
  const reasoning = pick(flags.reasoning, "EVAL_PERSONA_REASONING") ?? PERSONA_MODEL_DEFAULTS.reasoning;
  if (!model) throw new Error("Модель персонажей: пустой id модели OpenRouter");
  if (model.includes(":")) throw new Error(`Модель персонажей ${model}: без вариантов вроде :nitro — поставщик закрепляется отдельно`);
  if (!provider) throw new Error("Поставщик персонажей: пустой тег точки OpenRouter");
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error(`Температура персонажей: число от 0 до 2, получено «${temperatureText}»`);
  if (!REASONING_LEVELS.includes(reasoning as PersonaModelSettings["reasoning"])) throw new Error(`Рассуждения персонажей: ${REASONING_LEVELS.join(", ")}`);
  return { model, provider, temperature, reasoning: reasoning as PersonaModelSettings["reasoning"] };
}

/** Точка поставщика в OpenRouter: имя в ответах (`provider`), цены, умеет ли рассуждения. */
export interface PersonaEndpoint {
  providerName: string;
  pricing: ModelPriceRates;
  reasoning: boolean;
}

interface OpenRouterEndpoint {
  provider_name: string;
  tag: string;
  supported_parameters?: string[];
  pricing: { prompt: string; completion: string; input_cache_read?: string };
}

const perMillion = (price: string) => Math.round(Number(price) * 1e6 * 1e6) / 1e6;

/** Точка закреплённого поставщика по `/models/<id>/endpoints`: проверка до прогона и цены для предела расхода. */
export async function findPersonaEndpoint(settings: PersonaModelSettings, api: { apiKey: string; fetch?: typeof fetch }): Promise<PersonaEndpoint> {
  const response = await (api.fetch ?? fetch)(`https://openrouter.ai/api/v1/models/${settings.model}/endpoints`, { headers: { authorization: `Bearer ${api.apiKey}` } });
  if (!response.ok) throw new Error(`Модель персонажей ${settings.model}: OpenRouter ответил HTTP ${response.status}`);
  const endpoints = ((await response.json()) as { data: { endpoints: OpenRouterEndpoint[] } }).data.endpoints;
  const exact = endpoints.filter((item) => item.tag === settings.provider);
  const sameProvider = endpoints.filter((item) => item.tag.split("/")[0] === settings.provider);
  const matches = exact.length ? exact : sameProvider;
  if (matches.length === 0)
    throw new Error(`Поставщика ${settings.provider} нет у ${settings.model}. Есть: ${endpoints.map((item) => item.tag).join(", ")}`);
  // По имени поставщика OpenRouter выбирает любую его точку: закрепить можно только одну
  if (matches.length > 1) throw new Error(`У ${settings.provider} несколько точек ${settings.model}: укажите одну из ${matches.map((item) => item.tag).join(", ")}`);
  const [found] = matches as [OpenRouterEndpoint];
  return {
    providerName: found.provider_name,
    pricing: {
      inputPerMillion: perMillion(found.pricing.prompt),
      outputPerMillion: perMillion(found.pricing.completion),
      ...(found.pricing.input_cache_read && { cachedInputPerMillion: perMillion(found.pricing.input_cache_read) }),
    },
    reasoning: found.supported_parameters?.includes("reasoning") ?? false,
  };
}

/** Каталог и выбор модели персонажа — всё, что нужно `createPersona`. */
export interface PersonaModel {
  catalog: ModelCatalog;
  choice: ModelChoice;
  env: Environment;
}

/** Кто на деле ответил персонажам за прогон сценария. `offRoute` — удачные ответы не от закреплённого поставщика. */
export interface PersonaRouteReport {
  model: string;
  provider: string;
  temperature: number;
  requests: number;
  served: Record<string, number>;
  offRoute: number;
  /** Ответы с ошибкой (429, 5xx): SDK их повторяет, поставщика в них нет. */
  failed: number;
}

export interface PersonaRoute extends PersonaModel {
  report(): Promise<PersonaRouteReport>;
}

const ROUTE_ID = "eval-persona";
const MODEL_ID = "eval-persona-model";

/**
 * Маршрут персонажей одного прогона сценария. Каждый запрос к OpenRouter записывается: ушёл ли он с закреплённым
 * поставщиком и кто ответил (поле `provider` в ответе).
 */
export function openPersonaRoute(
  settings: PersonaModelSettings,
  endpoint: PersonaEndpoint,
  base: { catalog: ModelCatalog; env: Environment; fetch?: typeof fetch },
): PersonaRoute {
  const served: Record<string, number> = {};
  const reading = new Set<Promise<void>>();
  let requests = 0;
  let failed = 0;
  const send = base.fetch ?? fetch;
  const recording: typeof fetch = async (input, init) => {
    const response = await send(input, init);
    if (!String(input instanceof Request ? input.url : input).includes("/chat/completions")) return response;
    requests += 1;
    if (!response.ok) {
      failed += 1;
      return response;
    }
    const read = response
      .clone()
      .text()
      .then((text) => {
        const name = /"provider"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? "нет в ответе";
        served[name] = (served[name] ?? 0) + 1;
      })
      .catch(() => {});
    reading.add(read);
    return response;
  };

  const route = createOpenRouterProvider({ id: ROUTE_ID, displayName: "Персонажи eval", order: [settings.provider], allowFallbacks: false });
  const recordingRoute = { ...route, createLanguageModel: (id: string, key: string, options?: { fetch?: typeof fetch }) => route.createLanguageModel(id, key, { ...options, fetch: recording }) };
  const profile: ModelProfile = {
    id: MODEL_ID,
    displayName: `Персонажи eval: ${settings.model}`,
    contextWindowTokens: 200_000,
    acceptsImages: false,
    reasoning: endpoint.reasoning ? { replayPastTurns: true, levels: [...REASONING_LEVELS], defaultLevel: settings.reasoning } : { replayPastTurns: true },
    // Температура уходит в тело запроса OpenRouter: у SDK отдельного параметра нет
    providerOptions: { openrouter: { temperature: settings.temperature } },
    providerModelIds: { [ROUTE_ID]: settings.model },
    pricing: { [ROUTE_ID]: endpoint.pricing },
  };

  return {
    catalog: extendCatalog(base.catalog, { addProviders: [recordingRoute], addModels: [profile] }),
    choice: { providerId: ROUTE_ID, modelId: MODEL_ID, ...(endpoint.reasoning && { reasoning: settings.reasoning }) },
    env: base.env,
    async report() {
      await Promise.all(reading);
      const offRoute = Object.entries(served).reduce((sum, [name, count]) => (name === endpoint.providerName ? sum : sum + count), 0);
      return { model: settings.model, provider: settings.provider, temperature: settings.temperature, requests, served: { ...served }, offRoute, failed };
    },
  };
}
