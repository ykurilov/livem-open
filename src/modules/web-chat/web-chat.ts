import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, gte, inArray, isNull, max, ne, sql, type SQL } from "drizzle-orm";
import { embedUrl, parseVideoUrl } from "@ykurilov/agent-chat-videos";
import type { ChannelEvent } from "../channels/channel";
import { bots, outboundMessages } from "../channels/schema";
import { programEnded, publishedByCode } from "../conversations/router";
import { loadWithoutCodeHistory, whoWritesWithoutCode } from "../conversations/returning";
import { inboundMessages, passages } from "../conversations/schema";
import { acceptChannelEvents } from "../conversations/webhook";
import { afterStartOver } from "../conversations/start-over";
import { findEntryLinkByCode } from "../lead-magnets/links";
import { entryLinks, leadMagnets, leadMagnetVersions } from "../lead-magnets/schema";
import { parseLabeledStartPayload } from "../lead-magnets/start-payload";
import { people } from "../people/schema";
import type { Clock } from "../platform/clock";
import type { TokenCipher } from "../platform/crypto";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { isUuid } from "../platform/uuid";
import { isValidTimeZone } from "../program/calendar";
import type { ShownVideoLink } from "../videos/shown-video";
import { messagesPerAddress, newVisitorsPerAddress, sessionsPerAddress, takeWebChatLimit } from "./limits";
import type { WebPushSubscription } from "./push";
import { webChatTokens, webChatVisitors } from "./schema";

export const MESSAGE_MAX_LENGTH = 2000;
export const MESSAGES_PER_MINUTE = 20;
/** Сообщений одного посетителя за сутки: дальше ответы модели слишком дороги для одного разговора. */
export const MESSAGES_PER_DAY = 300;
/** Первая загрузка ленты — только последние элементы: длинная переписка не грузится целиком. */
export const FEED_FIRST_LOAD_LIMIT = 200;
/** Отметку «страница открыта» пишем не чаще: опрос идёт раз в несколько секунд. */
export const SEEN_WRITE_GAP_MS = 10_000;
/** Не чаще одного сообщения за столько миллисекунд. */
const MIN_MESSAGE_GAP_MS = 1000;
const CODE_MAX_LENGTH = 200;
const CLIENT_ID_MAX_LENGTH = 100;
const SECRET_MAX_LENGTH = 200;

/**
 * Имя посетителя в «Людях», пока консультант не узнал настоящее: с началом id, чтобы гостей можно было различить.
 * Имени из профиля мессенджера у веб-посетителя нет — консультанту оно не передаётся (`profileNameForTail`).
 */
export const webVisitorName = (visitorId: string) => `Гость веб-чата ${visitorId.slice(0, 4).toUpperCase()}`;

export interface WebChatDependencies {
  db: Database;
  queue: JobEnqueuer;
  clock: Clock;
  cipher: TokenCipher;
}

export type WebChatVisitor = typeof webChatVisitors.$inferSelect;

export type WebChatOpened =
  | { kind: "opened"; token: string; issued: boolean; visitorId: string; title: string }
  /** Начало разговора не поставилось в очередь: страница просит обновить. Новый токен всё равно в cookie — повтор того же посетителя. */
  | { kind: "retry"; token: string; issued: boolean; error: string }
  /** Лидмагнит сняли с публикации, а у человека идёт разговор другого: этот чат закончен, `current` — куда вернуться. */
  | ({ kind: "closed"; token: string; issued: boolean } & WebChatElsewhere)
  | { kind: "not_found" }
  | { kind: "limited"; error: string };

export type WebChatElsewhere = { title: string; current: { code: string; title: string } };

export interface WebChatVideo {
  title: string;
  url: string;
  /** Адрес встроенного плеера; площадку не узнали — `null`, ролик показывается ссылкой. */
  embedUrl: string | null;
  startLabel?: string;
}

export interface WebChatItem {
  id: string;
  from: "person" | "bot";
  text: string;
  at: string;
  imageUrl?: string;
  video?: WebChatVideo;
  /** Сообщение человека ушло эксперту во «Входящие» без автоответа: бот на него не ответит, «печатает» не нужно. */
  noReply?: true;
  /** Готовые ответы человека: у последнего элемента ответа консультанта. Страница показывает их, только пока он последний в ленте. */
  quickReplies?: string[];
}

export type WebChatSendResult =
  /** `item` — сообщение человека для ленты: страница показывает его сразу, не дожидаясь опроса. */
  | { ok: true; item: WebChatItem | null }
  | { ok: false; reason: "empty" | "too_long" | "too_fast" | "too_many" | "retry"; error: string }
  /** `current` — разговор, который идёт сейчас: страница предложит перейти в него или вернуться сюда. */
  | { ok: false; reason: "other_chat"; error: string; current: WebChatElsewhere["current"] };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Служебный бот веб-чата: на нём держатся люди веб-чата и их исходящие. Один на приложение, создаётся сам. */
export async function ensureWebChatBot(db: DatabaseExecutor, cipher: TokenCipher): Promise<typeof bots.$inferSelect> {
  const find = () => db.select().from(bots).where(and(eq(bots.channel, "web"), eq(bots.externalId, "web")));
  const [existing] = await find();
  if (existing) return existing;
  await db
    .insert(bots)
    .values({
      channel: "web",
      title: "Веб-чат",
      externalId: "web",
      username: "web",
      tokenEncrypted: cipher.encrypt(randomBytes(16).toString("base64url")),
      webhookSecret: randomBytes(32).toString("base64url"),
    })
    .onConflictDoNothing();
  const [created] = await find();
  if (!created) throw new Error("Бот веб-чата не создался");
  return created;
}

/** Посетитель по токену из cookie; выдуманный или чужой токен — `null`. */
export async function findWebChatVisitor(db: DatabaseExecutor, token: string | null | undefined): Promise<WebChatVisitor | null> {
  if (!token || token.length > SECRET_MAX_LENGTH) return null;
  const [row] = await db
    .select({ visitor: webChatVisitors })
    .from(webChatTokens)
    .innerJoin(webChatVisitors, eq(webChatVisitors.id, webChatTokens.visitorId))
    .where(eq(webChatTokens.tokenHash, hashToken(token)));
  return row?.visitor ?? null;
}

/** Новый токен посетителя для этого браузера или веб-приложения. */
async function issueToken(db: DatabaseExecutor, visitorId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(webChatTokens).values({ tokenHash: hashToken(token), visitorId });
  return token;
}

/**
 * Код входа для веб-приложения с экрана «Домой»: оно начинает без cookie браузера, код в адресе его старта.
 * Пока код не использовали, манифест отдаёт тот же. Использованный код (шифр стёрт) манифест меняет на новый — тогда
 * прежний и гаснет: веб-приложение, получив cookie, сразу перечитывает манифест.
 */
export async function webChatResumeCode(db: DatabaseExecutor, cipher: TokenCipher, visitor: WebChatVisitor): Promise<string> {
  if (visitor.resumeCodeEncrypted) return cipher.decrypt(visitor.resumeCodeEncrypted);
  const code = randomBytes(24).toString("base64url");
  const [saved] = await db
    .update(webChatVisitors)
    .set({ resumeCodeHash: hashToken(code), resumeCodeEncrypted: cipher.encrypt(code) })
    .where(and(eq(webChatVisitors.id, visitor.id), isNull(webChatVisitors.resumeCodeEncrypted)))
    .returning({ id: webChatVisitors.id });
  if (saved) return code;
  // Код только что выдал соседний запрос — отдаём его
  const [current] = await db.select({ encrypted: webChatVisitors.resumeCodeEncrypted }).from(webChatVisitors).where(eq(webChatVisitors.id, visitor.id));
  return current?.encrypted ? cipher.decrypt(current.encrypted) : code;
}

/**
 * Использовать код входа: посетитель — его владелец. Код помечается использованным, но действует, пока манифест не выдал
 * новый: ответ первого запуска мог потеряться по дороге, и повтор не должен заводить нового посетителя. Код неизвестен
 * или погас — `null`.
 */
async function takeResumeCode(db: DatabaseExecutor, code: string): Promise<WebChatVisitor | null> {
  if (code.length > SECRET_MAX_LENGTH) return null;
  const [visitor] = await db
    .update(webChatVisitors)
    .set({ resumeCodeEncrypted: null })
    .where(eq(webChatVisitors.resumeCodeHash, hashToken(code)))
    .returning();
  return visitor ?? null;
}

/**
 * Открыть чат по ссылке. Посетитель — по токену из cookie, иначе по одноразовому коду входа (`resume`, веб-приложение
 * с экрана «Домой»), иначе новый; в двух последних случаях — новый токен (`issued`).
 * Событие «старт с кодом», как `/start <код>` в Telegram, — когда разговора этого лидмагнита ещё не было или сейчас идёт
 * разговор другого: человек перешёл по другой ссылке. Открыть страницу здесь — ещё и нажать на уведомление или значок
 * на экране «Домой», поэтому законченный разговор этого лидмагнита заново не начинается: человек возвращается к переписке.
 * Повтор открытия при том же положении дел второго события не создаёт.
 * Лидмагнит сняли с публикации — свой посетитель, у которого был этот разговор, открывает переписку (без нового начала),
 * остальным чата нет.
 * `address` — адрес посетителя для ограничений; `timeZone` — пояс браузера: им начинается человек, пока консультант не
 * узнал свой.
 */
export async function openWebChat(
  deps: WebChatDependencies,
  input: { token: string | null | undefined; resume?: string | null; code: string; address: string; timeZone?: string | null },
): Promise<WebChatOpened> {
  const now = deps.clock.now();
  if (!(await takeWebChatLimit(deps.db, now, sessionsPerAddress(input.address))))
    return { kind: "limited", error: "Слишком много попыток открыть чат. Подождите минуту и попробуйте снова." };
  const code = input.code.trim();
  if (!code || code.length > CODE_MAX_LENGTH) return { kind: "not_found" };
  const target = await publishedByCode(deps.db, code);

  let visitor = await findWebChatVisitor(deps.db, input.token);
  let issuedToken: string | null = null;
  if (!visitor && input.resume) {
    visitor = await takeResumeCode(deps.db, input.resume);
    if (visitor) issuedToken = await issueToken(deps.db, visitor.id);
  }
  if (!target) {
    const title = visitor && (await ownChatTitle(deps.db, visitor, code));
    if (!visitor || !title) return { kind: "not_found" };
    const elsewhere = await webChatElsewhere(deps.db, code, visitor, now);
    if (elsewhere) return { kind: "closed", token: issuedToken ?? input.token ?? "", issued: issuedToken !== null, ...elsewhere };
    return { kind: "opened", token: issuedToken ?? input.token ?? "", issued: issuedToken !== null, visitorId: visitor.id, title };
  }
  if (!visitor) {
    if (!(await takeWebChatLimit(deps.db, now, newVisitorsPerAddress(input.address))))
      return { kind: "limited", error: "Слишком много новых чатов с вашего адреса. Попробуйте через час." };
    const [created] = await deps.db.insert(webChatVisitors).values({ lastCode: code }).returning();
    if (!created) throw new Error("Посетитель веб-чата не создался");
    visitor = created;
    issuedToken = await issueToken(deps.db, visitor.id);
  }

  const bot = await ensureWebChatBot(deps.db, deps.cipher);
  const person = await findPerson(deps.db, visitor.id);
  const timeZone = input.timeZone?.trim();
  // До начала разговора: дата старта программы и ночь считаются по поясу человека
  if (timeZone && !person?.timeZone && isValidTimeZone(timeZone)) await rememberBrowserTimeZone(deps.db, bot.id, visitor.id, timeZone);
  const history = person ? await passageHistory(deps.db, person, target.leadMagnetId) : null;
  const continuing = person ? await continuingChat(deps.db, person, now) : null;
  const otherContinues = continuing !== null && continuing.leadMagnetId !== target.leadMagnetId;
  const token = issuedToken ?? input.token ?? "";
  // Программа этого лидмагнита закончилась, продолжается другой разговор: заново не начнётся, писать сюда нельзя — чат закончен
  const elsewhere = otherContinues ? await webChatElsewhere(deps.db, code, visitor, now) : null;
  if (elsewhere) return { kind: "closed", token, issued: issuedToken !== null, ...elsewhere };
  if (visitor.lastCode !== code) await deps.db.update(webChatVisitors).set({ lastCode: code }).where(eq(webChatVisitors.id, visitor.id));
  // Продолжается другой разговор (идёт или брошен недавно) — сообщение отсюда ушло бы в него: этот начинается, как по ссылке
  if (!history?.hadThis || otherContinues) {
    // Новое положение дел (другой разговор начался, сброс) — новое событие; то же самое — повтор отсекается
    const latest = history?.latest;
    const start: ChannelEvent = {
      type: "message",
      dedupeKey: `web-start:${visitor.id}:${target.leadMagnetId}:${latest?.id ?? "none"}:${person?.conversationsResetAt?.getTime() ?? 0}`,
      userId: visitor.id,
      userName: webVisitorName(visitor.id),
      text: `/start ${code}`,
      startCode: code,
    };
    if ((await acceptChannelEvents(deps, bot.id, [start], { receivedAt: now })) === "retry")
      return { kind: "retry", token, issued: issuedToken !== null, error: "Не получилось начать разговор. Попробуйте снова через минуту." };
  }
  return {
    kind: "opened",
    token,
    issued: issuedToken !== null,
    visitorId: visitor.id,
    title: await leadMagnetTitle(deps.db, target.leadMagnetId),
  };
}

/** Пояс браузера — человеку веб-чата, у которого пояса ещё нет; узнанный консультантом не трогаем. */
async function rememberBrowserTimeZone(db: DatabaseExecutor, botId: string, visitorId: string, timeZone: string): Promise<void> {
  await db
    .insert(people)
    .values({ channel: "web", botId, externalUserId: visitorId, displayName: webVisitorName(visitorId), timeZone })
    .onConflictDoUpdate({ target: [people.botId, people.externalUserId], set: { timeZone: sql`coalesce(${people.timeZone}, excluded.time_zone)` } });
}

/** Разговоры человека после «Начать заново»: был ли этот лидмагнит, какой начался последним. */
async function passageHistory(db: DatabaseExecutor, person: NonNullable<Awaited<ReturnType<typeof findPerson>>>, leadMagnetId: string) {
  const rows = await db
    .select({ id: passages.id, leadMagnetId: passages.leadMagnetId, status: passages.status })
    .from(passages)
    .where(afterStartOver(passages.startedAt, person.conversationsResetAt, eq(passages.personId, person.id)))
    .orderBy(desc(passages.startedAt));
  return {
    hadThis: rows.some((row) => row.leadMagnetId === leadMagnetId),
    latest: rows[0] ?? null,
  };
}

/** Сообщение посетителя: в общий путь входящих, как из мессенджера. Повтор того же `clientId` второго не создаёт. */
export async function sendWebChatMessage(
  deps: WebChatDependencies,
  visitor: WebChatVisitor,
  input: { text: string; clientId: string; address: string; code?: string },
): Promise<WebChatSendResult> {
  const text = input.text.trim();
  if (!text) return { ok: false, reason: "empty", error: "Напишите сообщение" };
  if (text.length > MESSAGE_MAX_LENGTH)
    return { ok: false, reason: "too_long", error: `Сообщение длиннее ${MESSAGE_MAX_LENGTH} знаков: сократите его` };
  const clientId = input.clientId.slice(0, CLIENT_ID_MAX_LENGTH);
  const dedupeKey = `web:${visitor.id}:${clientId}`;
  const repeated = await sentPersonItem(deps.db, dedupeKey);
  if (repeated) return { ok: true, item: repeated };
  const now = deps.clock.now();
  const current = input.code ? await otherContinuingChat(deps.db, visitor, input.code, now) : null;
  if (current) return { ok: false, reason: "other_chat", error: `Сейчас у вас идёт разговор «${current.title}»`, current };

  const bot = await ensureWebChatBot(deps.db, deps.cipher);
  const minuteAgo = new Date(now.getTime() - 60_000);
  const [recent] = await deps.db
    .select({
      today: count(),
      lastMinute: sql<number>`count(*) filter (where ${inboundMessages.receivedAt} > ${minuteAgo})`.mapWith(Number),
      last: max(inboundMessages.receivedAt),
    })
    .from(inboundMessages)
    .where(
      and(
        eq(inboundMessages.botId, bot.id),
        eq(inboundMessages.externalUserId, visitor.id),
        eq(inboundMessages.kind, "message"),
        isNull(inboundMessages.startCode),
        gt(inboundMessages.receivedAt, new Date(now.getTime() - 24 * 60 * 60_000)),
      ),
    );
  if ((recent?.today ?? 0) >= MESSAGES_PER_DAY)
    return { ok: false, reason: "too_many", error: "На сегодня сообщений слишком много. Напишите завтра." };
  const tooFast =
    (recent?.last && now.getTime() - recent.last.getTime() < MIN_MESSAGE_GAP_MS) || (recent?.lastMinute ?? 0) >= MESSAGES_PER_MINUTE;
  if (tooFast || !(await takeWebChatLimit(deps.db, now, messagesPerAddress(input.address))))
    return { ok: false, reason: "too_fast", error: "Слишком часто: подождите немного и отправьте снова" };

  const event: ChannelEvent = { type: "message", dedupeKey, userId: visitor.id, userName: webVisitorName(visitor.id), text };
  if ((await acceptChannelEvents(deps, bot.id, [event], { receivedAt: now })) === "retry")
    return { ok: false, reason: "retry", error: "Не получилось отправить: попробуйте ещё раз" };
  return { ok: true, item: await sentPersonItem(deps.db, dedupeKey) };
}

/**
 * Сообщение написано во вкладке лидмагнита `code`, а продолжится им разговор другого: человек открыл другую ссылку
 * в соседней вкладке, или тот разговор брошен недавно. Такое сообщение ушло бы не тому консультанту.
 */
async function otherContinuingChat(
  db: DatabaseExecutor,
  visitor: WebChatVisitor,
  code: string,
  now: Date,
): Promise<WebChatElsewhere["current"] | null> {
  const leadMagnetId = await leadMagnetIdByCode(db, code);
  const person = leadMagnetId && (await findPerson(db, visitor.id));
  const continuing = person ? await continuingChat(db, person, now) : null;
  return continuing && continuing.leadMagnetId !== leadMagnetId ? continuing.current : null;
}

type ContinuingChat = { leadMagnetId: string; current: WebChatElsewhere["current"] };

/**
 * Разговор, который продолжит сообщение без кода: идущий, а нет его — брошенный недавно (разбор входящих откроет его
 * заново, `whoWritesWithoutCode`). Лидмагнит и адрес его чата; иначе `null`.
 */
async function continuingChat(
  db: DatabaseExecutor,
  person: Pick<typeof people.$inferSelect, "id" | "conversationsResetAt">,
  now: Date,
): Promise<ContinuingChat | null> {
  const active = await passageChat(db, and(eq(passages.personId, person.id), eq(passages.status, "active"))!);
  if (active) return active;
  const writer = whoWritesWithoutCode({ ...(await loadWithoutCodeHistory(db, person.id, person.conversationsResetAt)), now });
  return writer.kind === "reopen" ? passageChat(db, eq(passages.id, writer.passageId)) : null;
}

async function passageChat(db: DatabaseExecutor, where: SQL): Promise<ContinuingChat | null> {
  const [row] = await db
    .select({ leadMagnetId: passages.leadMagnetId, settings: leadMagnetVersions.settings, code: entryLinks.code })
    .from(passages)
    .innerJoin(leadMagnetVersions, eq(leadMagnetVersions.id, passages.snapshotId))
    .innerJoin(entryLinks, and(eq(entryLinks.leadMagnetId, passages.leadMagnetId), isNull(entryLinks.label)))
    .where(where);
  return row ? { leadMagnetId: row.leadMagnetId, current: { code: row.code, title: row.settings.name.trim() || "Чат" } } : null;
}

/** Принятое сообщение человека по ключу повтора; куда его отправит разбор, станет известно позже — это покажет опрос. */
async function sentPersonItem(db: DatabaseExecutor, dedupeKey: string): Promise<WebChatItem | null> {
  const [row] = await db
    .select({ id: inboundMessages.id, text: inboundMessages.text, at: inboundMessages.receivedAt })
    .from(inboundMessages)
    .where(eq(inboundMessages.dedupeKey, dedupeKey));
  return row ? { id: row.id, from: "person", text: row.text ?? "", at: row.at.toISOString() } : null;
}

/**
 * Лента чата: сообщения посетителя и всё, что ему ушло (ответы, напоминания, рассылки, ответы эксперта), по времени.
 * Без `since` — последние `FEED_FIRST_LOAD_LIMIT` элементов, с `since` — всё новее. Страница при этом считается открытой.
 */
export async function readWebChat(
  db: DatabaseExecutor,
  clock: Clock,
  visitor: WebChatVisitor,
  options: { since?: Date } = {},
): Promise<WebChatItem[]> {
  const now = clock.now();
  if (!visitor.lastSeenAt || now.getTime() - visitor.lastSeenAt.getTime() >= SEEN_WRITE_GAP_MS)
    await db.update(webChatVisitors).set({ lastSeenAt: now }).where(eq(webChatVisitors.id, visitor.id));
  const person = await findPerson(db, visitor.id);
  if (!person) return [];
  const since = options.since;
  const limit = since ? undefined : FEED_FIRST_LOAD_LIMIT;

  const inboundQuery = db
    .select({
      id: inboundMessages.id,
      text: inboundMessages.text,
      at: inboundMessages.receivedAt,
      route: inboundMessages.route,
      autoreply: inboundMessages.autoreply,
      menu: inboundMessages.menu,
    })
    .from(inboundMessages)
    .where(
      and(
        eq(inboundMessages.botId, person.botId),
        eq(inboundMessages.externalUserId, visitor.id),
        eq(inboundMessages.kind, "message"),
        isNull(inboundMessages.startCode),
        since ? gte(inboundMessages.receivedAt, since) : undefined,
      ),
    )
    .orderBy(desc(inboundMessages.receivedAt));
  const outboundQuery = db
    .select()
    .from(outboundMessages)
    .where(and(eq(outboundMessages.personId, person.id), eq(outboundMessages.status, "sent"), since ? gte(outboundMessages.sentAt, since) : undefined))
    .orderBy(desc(outboundMessages.sentAt), desc(outboundMessages.createdAt));
  // Выборка с конца, чтобы взять последние; дальше — снова по времени: сортировка ниже устойчива при равном времени
  const [inbound, outbound] = (limit ? [await inboundQuery.limit(limit), await outboundQuery.limit(limit)] : [await inboundQuery, await outboundQuery]).map(
    (rows) => rows.reverse(),
  ) as [Awaited<typeof inboundQuery>, Awaited<typeof outboundQuery>];

  const entries: Array<{ at: Date; order: number; items: WebChatItem[] }> = [
    // При равном времени ответ бота раньше: человек отвечает на то, что уже видел
    ...outbound.map((row) => ({ at: row.sentAt ?? row.createdAt, order: 0, items: botItems(row) })),
    ...inbound.map((row) => ({
      at: row.at,
      order: 1,
      items: [
        {
          id: row.id,
          from: "person" as const,
          text: row.text ?? "",
          at: row.at.toISOString(),
          ...((row.route === "inbox" || row.route === "ignored") && !row.autoreply && !row.menu && { noReply: true as const }),
        },
      ],
    })),
  ];
  const items = entries.sort((a, b) => a.at.getTime() - b.at.getTime() || a.order - b.order).flatMap((entry) => entry.items);
  return limit ? items.slice(-limit) : items;
}

/** Страница скрыта (телефон заблокирован, другое приложение): ответ теперь придёт уведомлением. */
export async function markWebChatAway(db: DatabaseExecutor, visitor: WebChatVisitor): Promise<void> {
  await db.update(webChatVisitors).set({ lastSeenAt: null }).where(eq(webChatVisitors.id, visitor.id));
}

/** Картинка из исходящего — только тому посетителю, кому оно ушло. Иначе `null`. */
export async function webChatImagePath(db: DatabaseExecutor, visitor: WebChatVisitor, messageId: string): Promise<string | null> {
  if (!isUuid(messageId)) return null;
  const [row] = await db
    .select({ imagePath: outboundMessages.imagePath })
    .from(outboundMessages)
    .innerJoin(people, eq(people.id, outboundMessages.personId))
    .where(and(eq(outboundMessages.id, messageId), eq(people.channel, "web"), eq(people.externalUserId, visitor.id)));
  return row?.imagePath ?? null;
}

/**
 * Подписка на уведомления; `null` — отписка. Подписка — это браузер: за другим посетителем того же браузера (cookie
 * стёрли, воркер остался) она снимается, и уведомления прежнего новому человеку не показываются.
 */
export async function saveWebChatSubscription(
  db: DatabaseExecutor,
  visitor: WebChatVisitor,
  subscription: WebPushSubscription | null,
): Promise<void> {
  if (subscription)
    await db
      .update(webChatVisitors)
      .set({ pushSubscription: null })
      .where(and(sql`${webChatVisitors.pushSubscription}->>'endpoint' = ${subscription.endpoint}`, ne(webChatVisitors.id, visitor.id)));
  await db.update(webChatVisitors).set({ pushSubscription: subscription }).where(eq(webChatVisitors.id, visitor.id));
}

/** Подписка больше не действует: снимается, только если у посетителя всё ещё она, а не сохранённая позже. */
export async function forgetWebChatSubscription(db: DatabaseExecutor, visitorId: string, endpoint: string): Promise<void> {
  await db
    .update(webChatVisitors)
    .set({ pushSubscription: null })
    .where(and(eq(webChatVisitors.id, visitorId), sql`${webChatVisitors.pushSubscription}->>'endpoint' = ${endpoint}`));
}

/**
 * Название чата по коду ссылки (заголовок страницы, манифеста и уведомления): опубликованного лидмагнита — всем;
 * снятого с публикации — только посетителю, у которого был этот разговор. Иначе `null`.
 */
export async function webChatTitle(db: DatabaseExecutor, code: string, visitor: WebChatVisitor | null): Promise<string | null> {
  if (!code || code.length > CODE_MAX_LENGTH) return null;
  const target = await publishedByCode(db, code);
  if (target) return leadMagnetTitle(db, target.leadMagnetId);
  return visitor ? ownChatTitle(db, visitor, code) : null;
}

/**
 * Разговор лидмагнита ссылки у посетителя был, продолжается разговор другого (идёт или брошен недавно), а этот по ссылке
 * не начнётся: лидмагнит снят с публикации или его программа у человека закончилась. Писать сюда нельзя (ушло бы не тому
 * консультанту), а лента общая и под этим названием читалась бы как чужая. Тогда — название этого чата и адрес того
 * разговора; иначе `null`.
 */
export async function webChatElsewhere(db: DatabaseExecutor, code: string, visitor: WebChatVisitor, now: Date): Promise<WebChatElsewhere | null> {
  if (!code || code.length > CODE_MAX_LENGTH) return null;
  const published = await publishedByCode(db, code);
  const leadMagnetId = await leadMagnetIdByCode(db, code);
  const title = leadMagnetId ? await ownChatTitle(db, visitor, code) : null;
  const person = title ? await findPerson(db, visitor.id) : null;
  if (!title || !person) return null;
  const continuing = await continuingChat(db, person, now);
  if (!continuing || continuing.leadMagnetId === leadMagnetId) return null;
  // Опубликованный по ссылке начинается заново, бросая текущий, — кроме законченной программы
  if (published && !(await programEnded(db, person, published.leadMagnetId))) return null;
  return { title, current: continuing.current };
}

/** Разговор лидмагнита этой ссылки у посетителя был — название из снимка последнего; не было — `null`. */
async function ownChatTitle(db: DatabaseExecutor, visitor: WebChatVisitor, code: string): Promise<string | null> {
  const leadMagnetId = await leadMagnetIdByCode(db, code);
  const person = leadMagnetId && (await findPerson(db, visitor.id));
  if (!leadMagnetId || !person) return null;
  const [row] = await db
    .select({ settings: leadMagnetVersions.settings })
    .from(passages)
    .innerJoin(leadMagnetVersions, eq(leadMagnetVersions.id, passages.snapshotId))
    .where(and(eq(passages.personId, person.id), eq(passages.leadMagnetId, leadMagnetId)))
    .orderBy(desc(passages.startedAt))
    .limit(1);
  return row ? row.settings.name.trim() || "Чат" : null;
}

/** Лидмагнит ссылки — опубликован он или нет; разбор кода как у `publishedByCode`. */
/** У опубликованного лидмагнита ссылки включён «Голосовой ввод». Снятый с публикации или чужой код — нет. */
export async function webChatVoiceInput(db: DatabaseExecutor, code: string): Promise<boolean> {
  const leadMagnetId = await leadMagnetIdByCode(db, code);
  if (!leadMagnetId) return false;
  const [row] = await db
    .select({ settings: leadMagnetVersions.settings })
    .from(leadMagnets)
    .innerJoin(leadMagnetVersions, eq(leadMagnetVersions.id, leadMagnets.publishedSnapshotId))
    .where(eq(leadMagnets.id, leadMagnetId));
  return row?.settings.voiceInput === true;
}

/**
 * Кто платит за диктовку посетителя: человек и чат его последнего прохождения по лидмагниту ссылки — на них же пишется
 * переписка с консультантом. Разговора ещё нет — `null`.
 */
export async function webChatVoicePayer(db: DatabaseExecutor, visitorId: string, code: string): Promise<{ ownerId: string; chatId: string } | null> {
  const [leadMagnetId, person] = await Promise.all([leadMagnetIdByCode(db, code), findPerson(db, visitorId)]);
  if (!leadMagnetId || !person) return null;
  const [passage] = await db
    .select({ chatId: passages.chatId })
    .from(passages)
    .where(and(eq(passages.personId, person.id), eq(passages.leadMagnetId, leadMagnetId)))
    .orderBy(desc(passages.startedAt))
    .limit(1);
  return passage ? { ownerId: person.id, chatId: passage.chatId } : null;
}

async function leadMagnetIdByCode(db: DatabaseExecutor, code: string): Promise<string | null> {
  if (!code || code.length > CODE_MAX_LENGTH) return null;
  const exact = await findEntryLinkByCode(db, code);
  if (exact) return exact.leadMagnetId;
  const parsed = parseLabeledStartPayload(code);
  const main = parsed ? await findEntryLinkByCode(db, parsed.code) : null;
  return main?.label === null ? main.leadMagnetId : null;
}

async function leadMagnetTitle(db: DatabaseExecutor, leadMagnetId: string): Promise<string> {
  const [row] = await db
    .select({ settings: leadMagnetVersions.settings })
    .from(leadMagnets)
    .innerJoin(leadMagnetVersions, eq(leadMagnetVersions.id, leadMagnets.publishedSnapshotId))
    .where(eq(leadMagnets.id, leadMagnetId));
  return row?.settings.name.trim() || "Чат";
}

async function findPerson(db: DatabaseExecutor, visitorId: string) {
  const webBots = db.select({ id: bots.id }).from(bots).where(eq(bots.channel, "web"));
  const [person] = await db
    .select()
    .from(people)
    .where(and(inArray(people.botId, webBots), eq(people.externalUserId, visitorId)))
    .orderBy(desc(people.createdAt))
    .limit(1);
  return person ?? null;
}

function botItems(row: typeof outboundMessages.$inferSelect): WebChatItem[] {
  const at = (row.sentAt ?? row.createdAt).toISOString();
  const items: WebChatItem[] = [];
  if (row.text.trim() || row.imagePath)
    items.push({ id: row.id, from: "bot", text: row.text, at, ...(row.imagePath && { imageUrl: `/api/web-chat/images/${row.id}` }) });
  if (row.video) items.push({ id: `${row.id}:video`, from: "bot", text: "", at, video: webChatVideo(row.video) });
  row.followUps.forEach((text, index) => {
    if (text.trim()) items.push({ id: `${row.id}:${index}`, from: "bot", text, at });
  });
  const last = items.at(-1);
  if (last && row.quickReplies?.length) items[items.length - 1] = { ...last, quickReplies: row.quickReplies };
  return items;
}

function webChatVideo(video: ShownVideoLink): WebChatVideo {
  const address = parseVideoUrl(video.url);
  return {
    title: video.title,
    url: video.url,
    embedUrl: address ? embedUrl(address, startSeconds(video.startLabel)) : null,
    ...(video.startLabel && { startLabel: video.startLabel }),
  };
}

/** «3:20» → 200 секунд; без отметки — с начала. */
function startSeconds(label: string | undefined): number | undefined {
  if (!label || !/^\d+(:\d{1,2}){0,2}$/.test(label)) return undefined;
  return label.split(":").reduce((total, part) => total * 60 + Number(part), 0) || undefined;
}
