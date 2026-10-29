import { and, desc, eq, inArray } from "drizzle-orm";
import { tagPassageText } from "../purchases/outgoing";
import { bots, enqueueOutbound, findBotWithCredentials, type ChannelAdapters } from "../channels";
import type { AgentFlowHandle, FlowEndInput } from "@ykurilov/agent-chat-flows";
import type { HeadlessConsultant } from "../consultant/headless-turn";
import { loadLeadMagnetFlow } from "../flows/runtime";
import { findEntryLinkByCode, getVersion, type LeadMagnetSettings } from "../lead-magnets";
import { ensurePayloadEntryLink, type EntryLink } from "../lead-magnets/links";
import { ENTRY_LABEL_SEPARATOR, parseLabeledStartPayload, START_PAYLOAD_LIMIT } from "../lead-magnets/start-payload";
import { leadMagnetVersions } from "../lead-magnets/schema";
import { markPersonBlocked, markPersonUnblocked, people, upsertPerson, type Person } from "../people";
import type { Clock } from "../platform/clock";
import type { TokenCipher } from "../platform/crypto";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { readSettings } from "../platform/settings";
import { programStartDate } from "../program";
import { buildMenu, chooseNoCodeReply, codeFromMenuPayload, findPublishedTarget, isPublishedOnBot, type StartTarget } from "./no-code";
import { endActivePassages, type PassageEndStatus } from "./passage-end";
import { loadWithoutCodeHistory, REOPEN_WINDOW_MS, whoWritesWithoutCode } from "./returning";
import { inboundMessages, passages, type InboundRoute, type PassageStatus } from "./schema";

/** Автоответ человеку, который пишет после завершённого лидмагнита. */
export const AUTOREPLY_TEXT = "Спасибо! Сейчас пока не могу говорить, но в ближайшее время я с вами свяжусь!";

export interface RouterDependencies {
  db: Database;
  queue: JobEnqueuer;
  clock: Clock;
  adapters: ChannelAdapters;
  cipher: TokenCipher;
  consultant: Pick<HeadlessConsultant, "startConversation">;
  /**
   * Сценарий разговора: новый разговор закрепляется сразу (`adopt`) — касания идут, даже если человек не ответил на
   * первое сообщение; старый заканчивается снаружи (`end`) — после записи решения, его статус пишет `onFinish`.
   */
  flow: Pick<AgentFlowHandle, "end" | "adopt" | "reopen" | "readRun">;
}

type InboundRow = typeof inboundMessages.$inferSelect;
type PassageRow = typeof passages.$inferSelect;

const BARE_START_COMMAND = /^\/start(?:@\w+)?$/;

/** Строка о политике обработки персональных данных к первому сообщению. */
export function privacyPolicyLine(url: string): string {
  return `Продолжая разговор, вы соглашаетесь с политикой обработки персональных данных: ${url}`;
}

export function firstMessageText(settings: LeadMagnetSettings, privacyPolicyUrl: string | null): string {
  return [settings.firstMessage.trim(), privacyPolicyUrl ? privacyPolicyLine(privacyPolicyUrl) : ""].filter(Boolean).join("\n\n");
}

/**
 * Задача `inbound-route`: куда идёт входящее — в прохождение, во «Входящие» или никуда. Решение записывается
 * в строку входящего вместе со всеми изменениями; действия после (первое сообщение, автоответ, ход) выводятся
 * из записанного и идемпотентны. Повтор задачи решение не меняет, только довыполняет действия.
 */
export async function routeInboundMessage(deps: RouterDependencies, inboundMessageId: string): Promise<void> {
  const appSettings = await readSettings(deps.db);
  // Брошенный разговор открывается заново вызовом сценария, а он — вне транзакции: первый проход только находит
  // кандидата, второй записывает решение с исходом `flow.reopen`
  let reopenOutcome: ReopenOutcome | undefined;
  for (;;) {
    // Концы сценариев — только после записи решения: при откате транзакции прохождение осталось бы активным, а сценарий — законченным
    const flowEnds: FlowEndInput[] = [];
    const result = await deps.db.transaction(async (tx): Promise<{ routed: InboundRow } | { reopen: ReopenCandidate }> => {
      const [inbound] = await tx.select().from(inboundMessages).where(eq(inboundMessages.id, inboundMessageId)).for("update");
      if (!inbound) throw new Error(`Входящее ${inboundMessageId} не найдено`);
      if (inbound.processedAt) return { routed: inbound };

      const [bot] = await tx.select().from(bots).where(eq(bots.id, inbound.botId));
      if (!bot) throw new Error(`Бот ${inbound.botId} не найден`);
      const now = deps.clock.now();
      const person = await upsertPerson(tx, {
        channel: bot.channel,
        botId: bot.id,
        externalUserId: inbound.externalUserId,
        displayName: inbound.userName,
        at: now,
      });

      const decision = await decide(tx, deps, {
        inbound,
        person,
        bot,
        now,
        privacyPolicyUrl: appSettings.privacyPolicyUrl,
        reopenOutcome,
        endFlow: (input) => void flowEnds.push(input),
      });
      if ("reopen" in decision) return decision;
      const [updated] = await tx
        .update(inboundMessages)
        .set({ personId: person.id, processedAt: now, ...decision })
        .where(eq(inboundMessages.id, inbound.id))
        .returning();
      return { routed: updated! };
    });

    if ("reopen" in result) {
      reopenOutcome = await reopenConversation(deps, result.reopen);
      continue;
    }
    for (const end of flowEnds) await deps.flow.end(end);
    if (reopenOutcome) await closeUnusedReopen(deps, reopenOutcome, result.routed);
    await followUp(deps, result.routed, appSettings.privacyPolicyUrl);
    return;
  }
}

/** Брошенный разговор, который можно продолжить: сценарий его чата открывается заново. */
interface ReopenCandidate {
  passageId: string;
  ownerId: string;
  chatId: string;
  now: Date;
}

interface ReopenOutcome {
  passageId: string;
  ownerId: string;
  chatId: string;
  reopened: boolean;
  /** Чем разговор кончился до открытия: с этой причиной он закрывается обратно, если не пригодился. */
  endReason: string;
}

/**
 * Открыть сценарий брошенного разговора. Давность проверяем и сами (`whoWritesWithoutCode`), и в SDK (`endedAfter`).
 * «Не закончен» — сценарий уже открыт: этим же вызовом до сбоя или соседней копией; разговор продолжается.
 */
async function reopenConversation(deps: RouterDependencies, candidate: ReopenCandidate): Promise<ReopenOutcome> {
  const before = await deps.flow.readRun(candidate.ownerId, candidate.chatId);
  const result = await deps.flow.reopen({
    ownerId: candidate.ownerId,
    chatId: candidate.chatId,
    reason: "person_returned",
    endedAfter: new Date(candidate.now.getTime() - REOPEN_WINDOW_MS),
  });
  return {
    passageId: candidate.passageId,
    ownerId: candidate.ownerId,
    chatId: candidate.chatId,
    reopened: result.reopened || result.reason === "not_ended",
    endReason: before?.endReason ?? "abandoned",
  };
}

/** Сценарий разговора открыт: не закончен или открыт заново после конца. */
async function flowIsOpen(deps: RouterDependencies, ownerId: string, chatId: string): Promise<boolean> {
  const run = await deps.flow.readRun(ownerId, chatId);
  return Boolean(run) && (run!.endedAt === undefined || (run!.reopenedAt ?? 0) > run!.endedAt);
}

/**
 * Между проходами человек начал другой разговор (ссылка, соседняя копия): открытый сценарий брошенного разговора не
 * пригодился — закрываем его обратно с прежней причиной. Прохождение, которое всё же «идёт», не трогаем.
 * Проверка и закрытие — под блокировкой строки человека: маршрутизация его входящих держит её всю транзакцию, поэтому
 * соседняя копия либо уже записала «идёт» (не закрываем), либо после нас увидит закрытый сценарий (`flowIsOpen`) и в разговор не пойдёт.
 */
async function closeUnusedReopen(deps: RouterDependencies, outcome: ReopenOutcome, routed: InboundRow): Promise<void> {
  if (!outcome.reopened || routed.passageId === outcome.passageId) return;
  await deps.db.transaction(async (tx) => {
    await tx.select({ id: people.id }).from(people).where(eq(people.id, outcome.ownerId)).for("update");
    const [passage] = await tx.select({ status: passages.status }).from(passages).where(eq(passages.id, outcome.passageId));
    if (passage?.status === "active") return;
    await deps.flow.end({ ownerId: outcome.ownerId, chatId: outcome.chatId, reason: outcome.endReason });
  });
}

interface Decision {
  route: InboundRoute;
  passageId?: string;
  startedPassage?: boolean;
  autoreply?: boolean;
  menu?: boolean;
  answeredAt?: Date;
}

async function decide(
  tx: DatabaseExecutor,
  deps: RouterDependencies,
  input: {
    inbound: InboundRow;
    person: Person;
    bot: typeof bots.$inferSelect;
    now: Date;
    privacyPolicyUrl: string | null;
    /** Исход `flow.reopen` на втором проходе. */
    reopenOutcome?: ReopenOutcome;
    /** Закончить сценарий разговора после записи решения. */
    endFlow(input: FlowEndInput): void;
  },
): Promise<Decision | { reopen: ReopenCandidate }> {
  const { inbound, person, bot, now } = input;

  if (inbound.kind === "blocked") {
    await markPersonBlocked(tx, person.id, now);
    const [blocked] = await tx
      .select({ chatId: passages.chatId })
      .from(passages)
      .where(and(eq(passages.personId, person.id), eq(passages.status, "active")));
    await endActivePassages(tx, eq(passages.personId, person.id), "blocked", now);
    if (blocked) input.endFlow({ ownerId: person.id, chatId: blocked.chatId, reason: "blocked" });
    return { route: "ignored" };
  }
  if (inbound.kind === "unblocked") {
    await markPersonUnblocked(tx, person.id);
    return { route: "ignored" };
  }
  if (inbound.kind === "contact") {
    // Человек написал боту ради другого сервиса — отвечает тот. Нам он контакт, которому можно
    // писать: в «Базе» с источником, в рассылках. Источник — только у того, кто ещё не приходил через лидмагнит
    if (person.blockedAt) await markPersonUnblocked(tx, person.id);
    if (!person.source && inbound.contactSource) {
      const [passage] = await tx.select({ id: passages.id }).from(passages).where(eq(passages.personId, person.id)).limit(1);
      if (!passage) await tx.update(people).set({ source: inbound.contactSource }).where(eq(people.id, person.id));
    }
    return { route: "ignored" };
  }
  // Кнопка меню — как переход по основной ссылке выбранного лидмагнита; нажатие подтверждаем мессенджеру после записи
  const isButton = inbound.kind === "button";
  const startCode = isButton ? codeFromMenuPayload(inbound.buttonPayload) : inbound.startCode;
  if (isButton && !startCode) return { route: "ignored" };

  // Написал — значит, бот не заблокирован (мессенджер мог не прислать отдельное событие)
  if (person.blockedAt) await markPersonUnblocked(tx, person.id);

  const [active] = await tx
    .select()
    .from(passages)
    .where(and(eq(passages.personId, person.id), eq(passages.status, "active")))
    .for("update");

  const start = async (target: PayloadStartTarget) => {
    let entryLinkId = target.entryLinkId;
    if (target.payloadMain) {
      // Повторный старт того же лидмагнита сохраняет исходную атрибуцию, даже если обычный диалог начинается заново.
      const [previous] = await tx.select({ entryLinkId: passages.entryLinkId }).from(passages)
        .where(and(eq(passages.personId, person.id), eq(passages.leadMagnetId, target.leadMagnetId)))
        .orderBy(passages.startedAt, passages.id).limit(1);
      if (previous) entryLinkId = previous.entryLinkId ?? undefined;
      else if (target.payloadLabel) entryLinkId = (await ensurePayloadEntryLink(tx, target.payloadMain, target.payloadLabel)).id;
    }
    return startPassage(tx, deps, { person, now, privacyPolicyUrl: input.privacyPolicyUrl, ...target, entryLinkId });
  };

  const withoutCode = async (quiet: boolean): Promise<Decision> => {
    const reply = await chooseNoCodeReply(tx, bot);
    if (reply.kind === "start") return start(reply.target);
    if (reply.kind === "menu") return { route: quiet ? "ignored" : "inbox", menu: true };
    return { route: isButton ? "ignored" : "inbox" };
  };

  const found = startCode ? await publishedByCode(tx, startCode) : null;
  // Кнопка запускает только лидмагнит, опубликованный на этом боте
  const target = found && isButton && !(await isPublishedOnBot(tx, bot.id, found.leadMagnetId)) ? null : found;
  if (target) {
    // Та же ссылка посреди разговора — разговор продолжается
    if (active?.leadMagnetId === target.leadMagnetId) return { route: "ignored" };
    // Программа этого лидмагнита у человека уже закончилась: заново не начинаем, сообщение уходит эксперту
    if (await programEnded(tx, person.id, target.leadMagnetId)) return { route: "inbox" };
    if (active) {
      await endPassage(tx, active, "not_completed", now);
      // Ссылка другого лидмагнита: старый разговор сценария закончен, касаний и сроков у него больше нет
      input.endFlow({ ownerId: person.id, chatId: active.chatId, reason: "switched", outcome: `перешёл на лидмагнит ${target.leadMagnetId}` });
    }
    return start(target);
  }

  // Лидмагнит кнопки сняли с публикации, пока меню висело в переписке: посреди разговора — ничего, иначе — как сообщение
  // без кода (новичок, брошенный разговор, «Входящие»), только кнопка — не реплика: в разговор её не передаём
  if (isButton && active) return { route: "ignored" };

  const isStartCommand = !isButton && (Boolean(startCode) || BARE_START_COMMAND.test(inbound.text.trim()));
  if (active) {
    if (isStartCommand) return { route: "ignored" };
    await tx.update(passages).set({ lastPersonMessageAt: now }).where(eq(passages.id, active.id));
    return { route: "passage", passageId: active.id };
  }

  // Режим бота «без кода» — только для новичка. Вернувшийся через месяцы с вопросом про другой курс или с ответом на рассылку
  // не должен попасть во вступление лидмагнита по умолчанию: он во «Входящих» с автоответом раз в день
  const writer = whoWritesWithoutCode({ ...(await loadWithoutCodeHistory(tx, person.id)), now });
  if (writer.kind === "newcomer") return withoutCode(isButton || isStartCommand);
  // Брошенный недавно разговор продолжается тем же чатом. Голый /start — не реплика разговора. Сценарий не открылся
  // (срок программы вышел и др.) — как у остальных, «Входящие»
  if (writer.kind === "reopen" && !isStartCommand) {
    const outcome = input.reopenOutcome;
    if (!outcome) {
      const [ended] = await tx.select({ chatId: passages.chatId }).from(passages).where(eq(passages.id, writer.passageId));
      return { reopen: { passageId: writer.passageId, ownerId: person.id, chatId: ended!.chatId, now } };
    }
    // Сценарий проверяем ещё раз под блокировкой человека (upsertPerson): соседняя копия могла закрыть его обратно
    if (outcome.passageId === writer.passageId && outcome.reopened && (await flowIsOpen(deps, person.id, outcome.chatId))) {
      await tx
        .update(passages)
        .set({ status: "active", endedAt: null, ...(!isButton && { lastPersonMessageAt: now }) })
        .where(eq(passages.id, writer.passageId));
      // Нажатие не уходит в ход: разговор снова идёт, касания сценария — с первого шага
      return isButton ? { route: "ignored", passageId: writer.passageId } : { route: "passage", passageId: writer.passageId };
    }
  }

  // Голый /start — человек сам просит начать: меню бота, если оно есть, без автоответа
  if (isStartCommand && (await chooseNoCodeReply(tx, bot)).kind === "menu") return { route: "ignored", menu: true };
  const today = deps.clock.mskDate(now);
  const autoreply = person.lastAutoreplyOn !== today && person.lastManualReplyOn !== today;
  if (autoreply) await tx.update(people).set({ lastAutoreplyOn: today }).where(eq(people.id, person.id));
  return { route: "inbox", autoreply };
}

/** Программа, брошенная ради другого лидмагнита («не завершил»), не закончилась: возврат по ссылке начинает её заново. */
const PROGRAM_END_STATUSES: PassageStatus[] = ["completed", "term_ended", "blocked"];

/** У человека было прохождение этого лидмагнита на снимке с программой, и оно закончилось: согласием, сроком или блокировкой. */
async function programEnded(tx: DatabaseExecutor, personId: string, leadMagnetId: string): Promise<boolean> {
  const ended = await tx
    .select({ settings: leadMagnetVersions.settings })
    .from(passages)
    .innerJoin(leadMagnetVersions, eq(leadMagnetVersions.id, passages.snapshotId))
    .where(and(eq(passages.personId, personId), eq(passages.leadMagnetId, leadMagnetId), inArray(passages.status, PROGRAM_END_STATUSES)));
  return ended.some((row) => row.settings.flow?.schedule ?? row.settings.program);
}

interface PayloadStartTarget extends StartTarget {
  payloadMain?: EntryLink;
  payloadLabel?: string | null;
}

async function publishedByCode(tx: DatabaseExecutor, code: string): Promise<PayloadStartTarget | null> {
  // Старые коды, включая архивные ссылки, имеют приоритет. Огромные строки в запрос не передаём.
  const exact = code.length <= START_PAYLOAD_LIMIT ? await findEntryLinkByCode(tx, code) : null;
  const parsed = parseLabeledStartPayload(code);
  const main = !exact && parsed ? await findEntryLinkByCode(tx, parsed.code) : null;
  const link = exact ?? (main?.label === null ? main : null);
  if (!link) return null;
  const published = await findPublishedTarget(tx, link.leadMagnetId);
  if (!published) return null;
  // Даже если канонический составной код уже записан, метку разрешаем только в момент старта:
  // повторные /start не меняют источник и не создают пустые строки отчёта.
  if (parsed && (main || (parsed.label && exact?.code === `${parsed.code}${ENTRY_LABEL_SEPARATOR}${parsed.label}`))) {
    const base = main ?? await findEntryLinkByCode(tx, parsed.code);
    if (base?.label === null && base.leadMagnetId === link.leadMagnetId)
      return { ...published, entryLinkId: base.id, payloadMain: base, payloadLabel: parsed.label };
  }
  return { ...published, entryLinkId: link.id };
}

async function startPassage(
  tx: DatabaseExecutor,
  deps: RouterDependencies,
  input: StartTarget & { person: Person; now: Date; privacyPolicyUrl: string | null },
): Promise<Decision> {
  const snapshot = await getVersion(tx, input.snapshotId);
  if (!snapshot) throw new Error(`Снимок ${input.snapshotId} не найден`);
  const chatId = await deps.consultant.startConversation({
    ownerId: input.person.id,
    settings: snapshot.settings,
    firstMessage: firstMessageText(snapshot.settings, input.privacyPolicyUrl),
  });
  const { program, flow } = snapshot.settings;
  const [passage] = await tx
    .insert(passages)
    .values({
      personId: input.person.id,
      leadMagnetId: input.leadMagnetId,
      snapshotId: input.snapshotId,
      entryLinkId: input.entryLinkId ?? null,
      chatId,
      lastPersonMessageAt: input.now,
      // Отметка программы для отчёта «Программа»; дни, касания и ночь ведёт сценарий SDK
      ...((flow?.schedule ?? program) && { programStartDate: programStartDate(input.now, input.person.timeZone) }),
    })
    .returning({ id: passages.id });
  // Ссылку «/start» отвечает первое сообщение, консультанту она не нужна
  return { route: "passage", passageId: passage!.id, startedPassage: true, answeredAt: input.now };
}

export async function endPassage(tx: DatabaseExecutor, passage: Pick<PassageRow, "id">, status: PassageEndStatus, at: Date): Promise<void> {
  await endActivePassages(tx, eq(passages.id, passage.id), status, at);
}

/** Действия после записи решения. Каждое идемпотентно: повтор задачи не пошлёт второго сообщения. */
async function followUp(deps: RouterDependencies, inbound: InboundRow, privacyPolicyUrl: string | null): Promise<void> {
  if (inbound.kind === "button") await answerButton(deps, inbound);
  if (!inbound.personId) return;

  if (inbound.startedPassage && inbound.passageId) {
    const [passage] = await deps.db.select().from(passages).where(eq(passages.id, inbound.passageId));
    const snapshot = passage && (await getVersion(deps.db, passage.snapshotId));
    const text = snapshot ? firstMessageText(snapshot.settings, privacyPolicyUrl) : "";
    if (text)
      await enqueueOutbound(deps, {
        botId: inbound.botId,
        personId: inbound.personId,
        kind: "consultant",
        passageId: inbound.passageId,
        text: await tagPassageText(deps.db, inbound.passageId, text),
        idempotencyKey: `first:${inbound.passageId}`,
      });
    if (passage) await pinConversation(deps, passage);
    return;
  }

  if (inbound.menu) {
    const menu = await buildMenu(deps.db, inbound.botId);
    if (menu)
      await enqueueOutbound(deps, {
        botId: inbound.botId,
        personId: inbound.personId,
        kind: "menu",
        ...menu,
        idempotencyKey: `menu:${inbound.id}`,
      });
    return;
  }

  if (inbound.autoreply) {
    await enqueueOutbound(deps, {
      botId: inbound.botId,
      personId: inbound.personId,
      kind: "autoreply",
      text: AUTOREPLY_TEXT,
      idempotencyKey: `autoreply:${inbound.id}`,
    });
    return;
  }

  // Сообщение — консультанту сразу: окно тишины пачки SDK склеит его с соседними в один ход
  if (inbound.route === "passage" && inbound.passageId && !inbound.answeredAt)
    await deps.queue.enqueue("inbound-turn", { passageId: inbound.passageId }, { singletonKey: inbound.passageId });
}

/**
 * Разговор — за сценарием своего снимка с первой минуты: тишина считается от первого сообщения. Время — по часам
 * приложения (время записи прохождения в базе — настоящее, а часы подменяют тесты и eval). Повтор ничего не меняет.
 */
async function pinConversation(deps: RouterDependencies, passage: PassageRow): Promise<void> {
  const loaded = await loadLeadMagnetFlow(deps.db, passage.chatId);
  if (!loaded) return;
  const now = deps.clock.now();
  try {
    await deps.flow.adopt({ ownerId: passage.personId, chatId: passage.chatId, ...loaded, startedAt: now, lastAgentAt: now });
  } catch (error) {
    // Сценарий снимка с ошибкой: разговор идёт без сценария, первый ход попробует закрепить его снова
    console.error(`Разговор ${passage.id} не закреплён за сценарием:`, error instanceof Error ? error.message : error);
  }
}

async function answerButton(deps: RouterDependencies, inbound: InboundRow): Promise<void> {
  if (!inbound.callbackId) return;
  const found = await findBotWithCredentials(deps.db, deps.cipher, inbound.botId);
  const adapter = found && deps.adapters[found.bot.channel];
  try {
    if (found && adapter?.answerButton) await adapter.answerButton(found.credentials, inbound.callbackId);
  } catch (error) {
    // Не подтвердили нажатие — у человека покрутятся «часики»; разговор от этого не страдает
    console.error("Не удалось подтвердить нажатие кнопки:", error instanceof Error ? error.message : error);
  }
}
