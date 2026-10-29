import type { ModelCatalog } from "@ykurilov/agent-chat-core";
import { listLiveBots } from "../channels/bots";
import type { ChannelAdapters, ChannelKind } from "../channels/channel";
import { saveEditBesideConstructor } from "../constructor/manual-edits";
import {
  createLeadMagnet,
  describePublication,
  EntryLinkError,
  getLeadMagnet,
  InvalidLeadMagnetSettingsError,
  LeadMagnetNotFoundError,
  listLabeledLinks,
  listLeadMagnetCards,
  lockLeadMagnet,
  newLeadMagnetSettings,
  PublishError,
  publishWithBots,
  saveDraft,
  type LeadMagnetSettings,
} from "../lead-magnets";
import { InvalidFieldError } from "../people";
import type { Database } from "../platform/db";
import { describeInvalidModelChoice } from "../platform/model-choice";
import { isUuid } from "../platform/uuid";
import { listVideos } from "../videos";
import { connectMax } from "./connect-max";
import { connectVk, type VkConnectionDependencies } from "./connect-vk";
import { applyAgentInput, CliInputError, parseAgentInput, toAgentSettings, type AgentInput } from "./agent-settings";

export interface LeadMagnetCliDependencies {
  db: Database;
  catalog: ModelCatalog;
  adapters: ChannelAdapters;
  /** Почты экспертов, которым открыт кабинет (ALLOWED_EMAILS). */
  allowedEmails: Set<string>;
  /** Для `connect-vk`: собирается только этой командой (шифр ключей, сервис ботов). */
  vkConnection?: () => VkConnectionDependencies;
}

export interface CliResult {
  /** JSON при успехе, понятный текст ошибки при неудаче. */
  output: string;
  exitCode: number;
}

const CHANNELS: ChannelKind[] = ["telegram", "vk", "max"];

export const USAGE = `Команды:
  experts                         эксперты, которым открыт кабинет
  list [--expert <почта>]         лидмагниты
  show <id>                       настройки лидмагнита (поля и ролики по названиям)
  create --expert <почта> < json  новый лидмагнит из JSON настроек
  update <id> < json              правка: только меняемые ключи, сценарий (flow) — целиком
  videos                          ролики архива
  bots                            подключённые боты
  links <id>                      ссылки запуска в ботах
  publish <id> [--telegram <botId|none>] [--vk ...] [--max ...]
                                  опубликовать текущий черновик в привязанных ботах
  connect-vk [--remove-callback <https-адрес>] < ключ
                                  подключить сообщество ВК ключом со стандартного ввода, как форма «Боты»;
                                  затем убрать чужой Callback-сервер с точно таким адресом
  connect-max < токен             подключить бота Max токеном со стандартного ввода, как форма «Боты»`;

/** Разбор аргументов: позиционные и `--ключ значение`. */
function parseArgs(args: string[]): { positional: string[]; options: Map<string, string> } {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliInputError(`После ${arg} нужно значение`);
    options.set(arg.slice(2), value);
    index++;
  }
  return { positional, options };
}

function requireId(positional: string[], command: string): string {
  const id = positional[1];
  if (!id) throw new CliInputError(`Укажите id лидмагнита: ${command} <id>`);
  if (!isUuid(id)) throw new LeadMagnetNotFoundError(id);
  return id;
}

function checkExpert(deps: LeadMagnetCliDependencies, email: string | undefined, required: boolean): void {
  if (email === undefined) {
    if (required) throw new CliInputError("Укажите эксперта: --expert <почта>. Список — команда experts");
    return;
  }
  if (!deps.allowedEmails.has(email.trim().toLowerCase()))
    throw new CliInputError(`Почты ${email} нет в списке экспертов кабинета. Список — команда experts`);
}

function checkModel(deps: LeadMagnetCliDependencies, input: AgentInput, settings: LeadMagnetSettings): void {
  if (input.providerId === undefined && input.modelId === undefined && input.reasoning === undefined) return;
  const invalid = describeInvalidModelChoice(deps.catalog, settings);
  if (invalid) throw new CliInputError(invalid);
}

async function show(deps: LeadMagnetCliDependencies, id: string) {
  const lead = await getLeadMagnet(deps.db, id);
  if (!lead) throw new LeadMagnetNotFoundError(id);
  return {
    id: lead.id,
    published: lead.publishedSnapshotId !== null,
    hasUnpublishedChanges: lead.publishedSnapshotId !== null && lead.publishedSnapshotId !== lead.draftVersionId,
    versionId: lead.draftVersionId,
    updatedAt: lead.updatedAt,
    settings: await toAgentSettings(deps.db, lead.draft),
  };
}

/** Новый лидмагнит целиком в одной транзакции: ошибка — ни лидмагнита, ни новых полей. */
async function create(deps: LeadMagnetCliDependencies, input: AgentInput) {
  if (!input.name?.trim()) throw new CliInputError("У нового лидмагнита должно быть название: ключ name");
  const id = await deps.db.transaction(async (tx) => {
    const settings = await applyAgentInput(tx, newLeadMagnetSettings(input.name!), input, { creating: true });
    checkModel(deps, input, settings);
    const lead = await createLeadMagnet(tx, { name: settings.name, cardDescription: settings.cardDescription });
    await saveDraft(tx, lead.id, settings, "agent");
    return lead.id;
  });
  return show(deps, id);
}

/** Правка поверх текущего черновика под блокировкой: одна версия «agent» и заметка конструктору. */
async function update(deps: LeadMagnetCliDependencies, id: string, input: AgentInput) {
  if (Object.keys(input).length === 0) throw new CliInputError("Пустая правка: передайте хотя бы один ключ настроек");
  await deps.db.transaction(async (tx) => {
    const lead = await lockLeadMagnet(tx, id);
    const settings = await applyAgentInput(tx, lead.draft, input, { creating: false });
    checkModel(deps, input, settings);
    await saveEditBesideConstructor(tx, lead, settings, "agent");
  });
  return show(deps, id);
}

async function links(deps: LeadMagnetCliDependencies, id: string) {
  if (!(await getLeadMagnet(deps.db, id))) throw new LeadMagnetNotFoundError(id);
  const publication = await describePublication(deps.db, deps.adapters, id);
  const labeled = await listLabeledLinks(deps.db, deps.adapters, id);
  return {
    published: publication.snapshotId !== null,
    main: publication.bots.flatMap((bot) =>
      bot.link ? [{ channel: bot.channel, bot: bot.username, botId: bot.botId, url: bot.link }] : [],
    ),
    attachedBots: publication.bots.map((bot) => ({ channel: bot.channel, botId: bot.botId, title: bot.title, username: bot.username })),
    labeled: labeled.map((link) => ({ label: link.label, urls: link.urls })),
  };
}

async function publish(deps: LeadMagnetCliDependencies, id: string, options: Map<string, string>) {
  const choices: Partial<Record<ChannelKind, string | null>> = {};
  for (const channel of CHANNELS) {
    const value = options.get(channel);
    if (value !== undefined) choices[channel] = value === "none" ? null : value;
  }
  await publishWithBots(deps.db, id, choices);
  return links(deps, id);
}

async function execute(deps: LeadMagnetCliDependencies, args: string[], stdin: string): Promise<unknown> {
  const { positional, options } = parseArgs(args);
  const command = positional[0];
  switch (command) {
    case "experts":
      return [...deps.allowedEmails].map((email) => ({ email }));
    case "list":
      checkExpert(deps, options.get("expert"), false);
      return (await listLeadMagnetCards(deps.db)).map(({ id, name, cardDescription, published, updatedAt }) => ({
        id,
        name,
        cardDescription,
        published,
        updatedAt,
      }));
    case "show":
      return show(deps, requireId(positional, "show"));
    case "create":
      checkExpert(deps, options.get("expert"), true);
      return create(deps, parseAgentInput(stdin));
    case "update": {
      const id = requireId(positional, "update");
      return update(deps, id, parseAgentInput(stdin));
    }
    case "videos":
      return (await listVideos(deps.db)).map(({ title, url, description }) => ({ title, url, description }));
    case "bots":
      return (await listLiveBots(deps.db)).map(({ id, channel, title, username, status }) => ({ id, channel, title, username, status }));
    case "links":
      return links(deps, requireId(positional, "links"));
    case "publish":
      return publish(deps, requireId(positional, "publish"), options);
    case "connect-max":
      if (!deps.vkConnection) throw new CliInputError("connect-max здесь недоступна");
      return connectMax(deps.vkConnection().botService, stdin);
    case "connect-vk":
      if (!deps.vkConnection) throw new CliInputError("connect-vk здесь недоступна");
      return connectVk(deps.db, deps.vkConnection(), stdin, options.get("remove-callback"));
    default:
      throw new CliInputError(command ? `Неизвестная команда «${command}».\n${USAGE}` : USAGE);
  }
}

const EXPECTED_ERRORS = [CliInputError, InvalidLeadMagnetSettingsError, LeadMagnetNotFoundError, InvalidFieldError, PublishError, EntryLinkError];

/** Выполняет команду. Ожидаемые ошибки — текстом и кодом 1; сбой базы или кода пробрасывается. */
export async function runLeadMagnetCli(args: string[], stdin: string, deps: LeadMagnetCliDependencies): Promise<CliResult> {
  try {
    const result = await execute(deps, args, stdin);
    return { output: JSON.stringify(result, null, 2), exitCode: 0 };
  } catch (error) {
    if (EXPECTED_ERRORS.some((kind) => error instanceof kind)) return { output: `Ошибка: ${(error as Error).message}`, exitCode: 1 };
    throw error;
  }
}
