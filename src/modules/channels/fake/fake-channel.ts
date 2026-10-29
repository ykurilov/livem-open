import type {
  BotCredentials,
  BotIdentity,
  ChannelAdapter,
  ChannelEvent,
  ChannelKind,
  ConnectionCheck,
  OutgoingMessage,
  ParsedWebhook,
  SendResult,
  WebhookRequest,
} from "../channel";

export const FAKE_SECRET_HEADER = "x-fake-secret";

export interface SentMessage {
  botId: string;
  to: string;
  message: OutgoingMessage;
  externalMessageId: string;
}

export interface FakeChannelOptions {
  kind?: ChannelKind;
  ratePerSecond?: number;
}

/**
 * Подделка мессенджера для тестов: хранит отправленное в памяти и умеет
 * имитировать блокировку, ограничение скорости, временные сбои и повтор вебхука.
 */
export class FakeChannel implements ChannelAdapter {
  readonly kind: ChannelKind;
  readonly ratePerSecond: number;
  readonly sent: SentMessage[] = [];
  readonly attempts: Array<{ botId: string; to: string; idempotencyKey: string; result: SendResult }> = [];
  readonly connectedWebhooks = new Map<string, string>();
  /** Что `findConflict` получил при каждой проверке: токен и наш адрес (`null` — бот ещё не заведён). */
  readonly conflictChecks: Array<{ token: string; ownWebhookUrl: string | null }> = [];
  readonly answeredButtons: string[] = [];

  private readonly blockedUsers = new Set<string>();
  private readonly queuedFailures: Array<Exclude<SendResult, { ok: true }>> = [];
  private occupiedBy: string | null = null;
  private connectionError: { error: string; kind: "invalid_token" | "taken_over" | "temporary" } | null = null;
  private nextMessageNumber = 1;

  constructor(options: FakeChannelOptions = {}) {
    this.kind = options.kind ?? "telegram";
    this.ratePerSecond = options.ratePerSecond ?? 25;
  }

  // --- управление подделкой из тестов ---

  /** Все дальнейшие отправки этому человеку закончатся `blocked`. */
  blockUser(userId: string): void {
    this.blockedUsers.add(userId);
  }

  unblockUser(userId: string): void {
    this.blockedUsers.delete(userId);
  }

  /** Ближайшая отправка закончится этой ошибкой (по одной на отправку, по порядку). */
  failNext(failure: Exclude<SendResult, { ok: true }>): void {
    this.queuedFailures.push(failure);
  }

  /** `checkConnection` будет сообщать об этом сбое, пока не передать `null`. По умолчанию — отозванный токен. */
  breakConnection(error: string | null, kind: "invalid_token" | "taken_over" | "temporary" = "invalid_token"): void {
    this.connectionError = error === null ? null : { error, kind };
  }

  /** Бот «занят другим сервисом»: `findConflict` вернёт это предупреждение, пока не передать `null`. Токены `fake-busy-…` заняты всегда. */
  occupy(warning: string | null): void {
    this.occupiedBy = warning;
  }

  /** Запрос вебхука с событиями; одинаковые `dedupeKey` в двух запросах — это повтор. */
  webhookRequest(bot: BotCredentials, events: ChannelEvent[], secret = bot.webhookSecret): WebhookRequest {
    return { headers: { [FAKE_SECRET_HEADER]: secret }, body: JSON.stringify({ events }) };
  }

  messagesTo(userId: string): SentMessage[] {
    return this.sent.filter((entry) => entry.to === userId);
  }

  // --- интерфейс канала ---

  async verifyToken(token: string): Promise<BotIdentity> {
    if (!token.startsWith("fake-")) throw new Error("Неверный токен бота");
    return { externalId: `ext-${token}`, username: `bot_${token.slice(5)}`, title: `Бот ${token.slice(5)}` };
  }

  async findConflict(token: string, ownWebhookUrl: string | null): Promise<string | null> {
    this.conflictChecks.push({ token, ownWebhookUrl });
    if (this.occupiedBy) return this.occupiedBy;
    return token.startsWith("fake-busy-") ? "Бот сейчас занят другой программой. Если подключить его здесь, она перестанет получать сообщения. Подключить всё равно?" : null;
  }

  async connect(bot: BotCredentials, webhookUrl: string): Promise<void> {
    this.connectedWebhooks.set(bot.id, webhookUrl);
  }

  async disconnect(bot: BotCredentials): Promise<void> {
    this.connectedWebhooks.delete(bot.id);
  }

  async checkConnection(_bot: BotCredentials, _webhookUrl?: string): Promise<ConnectionCheck> {
    return this.connectionError ? { ok: false, ...this.connectionError } : { ok: true };
  }

  async parseWebhook(request: WebhookRequest, bot: BotCredentials): Promise<ParsedWebhook> {
    if (request.headers[FAKE_SECRET_HEADER] !== bot.webhookSecret) return { kind: "rejected" };
    const { events } = JSON.parse(request.body) as { events: ChannelEvent[] };
    return { kind: "events", events, responseBody: "" };
  }

  /**
   * Основной текст (с картинкой и кнопками) и дополнительные сообщения — отдельные части, как в настоящих мессенджерах:
   * каждая ушедшая часть — своя запись в `sent`, повтор продолжает с `sentParts`.
   */
  async send(bot: BotCredentials, to: string, message: OutgoingMessage): Promise<SendResult> {
    const { followUps = [], ...main } = message;
    const parts: OutgoingMessage[] = [
      ...(main.text.trim() || main.imagePath ? [main] : []),
      ...followUps.filter((text) => text.trim()).map((text) => ({ text, idempotencyKey: message.idempotencyKey })),
    ];
    if (parts.length === 0) parts.push(main);
    let result: SendResult = { ok: false, reason: "empty" };
    for (let index = Math.min(message.sentParts ?? 0, parts.length - 1); index < parts.length; index += 1) {
      result = this.decideResult(to);
      this.attempts.push({ botId: bot.id, to, idempotencyKey: message.idempotencyKey, result });
      if (!result.ok) return result.reason === "blocked" || result.reason === "reply_window_closed" || result.sentParts !== undefined ? result : { ...result, sentParts: index };
      this.sent.push({ botId: bot.id, to, message: parts[index]!, externalMessageId: result.externalMessageId });
    }
    return result;
  }

  async answerButton(_bot: BotCredentials, callbackId: string): Promise<void> {
    this.answeredButtons.push(callbackId);
  }

  entryLink(bot: { username: string }, code: string): string {
    return `https://fake.test/${bot.username}?start=${code}`;
  }

  private decideResult(to: string): SendResult {
    if (this.blockedUsers.has(to)) return { ok: false, reason: "blocked" };
    const queued = this.queuedFailures.shift();
    if (queued) return queued;
    return { ok: true, externalMessageId: `fake-${this.nextMessageNumber++}` };
  }
}
