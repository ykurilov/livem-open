"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Badge, Button } from "@/ui/primitives";
import type { AgentLogTurn, ChatMigrationEntry, FirstMessageEntry, FlowTransitionEntry, LoggedMessage, ModelCallEntry, ToolCallEntry } from "@/modules/agent-log";
import { firstMessageLines, migrationText, transitionText } from "@/modules/agent-log/flow-text";
import { shownVideoOf } from "@/modules/videos/shown-video";
import { VideoLink } from "@/ui/video-link";
import { loadAgentLogAction } from "./log-actions";

const timeFormat = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Moscow" });
const clockFormat = new Intl.DateTimeFormat("ru-RU", { timeStyle: "medium", timeZone: "Europe/Moscow" });

const roleLabel: Record<LoggedMessage["role"], string> = {
  user: "Собеседник",
  assistant: "Агент",
  tool: "Инструменты",
  system: "Инструкция",
};

function isFlowTurn(turn: AgentLogTurn): boolean {
  return turn.entries.length > 0 && turn.entries.every((entry) => entry.kind === "transition" || entry.kind === "first-message" || entry.kind === "migration");
}

const isMigrationTurn = (turn: AgentLogTurn) => turn.entries.length > 0 && turn.entries.every((entry) => entry.kind === "migration");

function whoLabel(turn: AgentLogTurn): string {
  if (isMigrationTurn(turn)) return "Эксперт";
  if (isFlowTurn(turn)) return turn.source === "preview" ? "Сценарий · Проверка" : "Сценарий";
  if (turn.agent === "constructor") return "Конструктор";
  if (turn.source === "preview") return "Консультант · Проверка";
  return `Консультант · ${turn.channel ?? "мессенджер"}${turn.personLabel ? `: ${turn.personLabel}` : ""}`;
}

function json(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function shorten(text: string, length = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length)}…` : line;
}

function tokensLabel(entry: ModelCallEntry): string | null {
  const usage = entry.usage;
  if (!usage) return null;
  const cache = usage.cacheRead ? ` (из кэша ${usage.cacheRead})` : "";
  return `вход ${usage.input ?? "?"}${cache} · выход ${usage.output ?? "?"}`;
}

function turnTotals(turn: AgentLogTurn) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  for (const entry of turn.entries) {
    if (entry.kind !== "model" || !entry.usage) continue;
    input += entry.usage.input ?? 0;
    output += entry.usage.output ?? 0;
    cacheRead += entry.usage.cacheRead ?? 0;
  }
  return { input, output, cacheRead };
}

function Block({ title, children }: { title: string; children: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[length:var(--yk-text-small-size)] font-semibold text-[var(--yk-muted)]">{title}</span>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[var(--yk-radius-md)] bg-[var(--yk-surface-2)] p-2 text-[length:var(--yk-text-small-size)]">
        {children}
      </pre>
    </div>
  );
}

function Messages({ messages }: { messages: LoggedMessage[] }) {
  return (
    <>
      {messages.map((message, index) =>
        message.parts.map((part, partIndex) => {
          const key = `${index}-${partIndex}`;
          const role = roleLabel[message.role];
          switch (part.type) {
            case "text":
              return <Block key={key} title={role}>{part.text}</Block>;
            case "reasoning":
              return <Block key={key} title={`${role} · рассуждения`}>{part.text}</Block>;
            case "file":
              return <Block key={key} title={role}>{`Файл ${part.mediaType}`}</Block>;
            case "tool-call":
              return <Block key={key} title={`${role} · вызов ${part.name}`}>{json(part.input)}</Block>;
            case "tool-result":
              return <Block key={key} title={`Результат ${part.name}`}>{json(part.output)}</Block>;
          }
        }),
      )}
    </>
  );
}

function ModelCall({ entry }: { entry: ModelCallEntry }) {
  const tokens = tokensLabel(entry);
  const outcome = entry.error
    ? `ошибка: ${shorten(entry.error)}`
    : entry.response.toolCalls.length
      ? `вызывает ${entry.response.toolCalls.map((call) => call.name).join(", ")}`
      : shorten(entry.response.text) || "пустой ответ";
  return (
    <details className="rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] p-2">
      <summary className="cursor-pointer text-[length:var(--yk-text-small-size)]">
        <span className="font-semibold">Модель</span> · {entry.modelId} · {entry.durationMs} мс{tokens ? ` · ${tokens}` : ""}
        <span className="block text-[var(--yk-muted)]">→ {outcome}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          {clockFormat.format(new Date(entry.at))} · {entry.providerId}
          {entry.response.finishReason ? ` · конец: ${entry.response.finishReason}` : ""}
          {entry.usage?.cacheWrite ? ` · записано в кэш ${entry.usage.cacheWrite}` : ""}
          {entry.usage?.reasoning ? ` · рассуждения ${entry.usage.reasoning}` : ""}
        </span>
        {entry.request.instructions !== undefined ? (
          <details>
            <summary className="cursor-pointer text-[length:var(--yk-text-small-size)] font-semibold">Инструкция ({entry.request.instructions.length} знаков)</summary>
            <Block title="Инструкция">{entry.request.instructions}</Block>
          </details>
        ) : null}
        <span className="text-[length:var(--yk-text-small-size)] font-semibold">
          Ушло в модель{entry.request.earlierMessages ? ` (ещё ${entry.request.earlierMessages} сообщ. раньше — не показаны)` : ""}
        </span>
        <Messages messages={entry.request.messages} />
        <span className="text-[length:var(--yk-text-small-size)] font-semibold">Ответ модели</span>
        {entry.response.reasoning ? <Block title="Рассуждения">{entry.response.reasoning}</Block> : null}
        {entry.response.text ? <Block title="Текст">{entry.response.text}</Block> : null}
        {entry.response.toolCalls.map((call) => (
          <Block key={call.id} title={`Вызов ${call.name}`}>{json(call.input)}</Block>
        ))}
        {entry.error ? <Block title="Ошибка">{entry.error}</Block> : null}
      </div>
    </details>
  );
}

function FlowTransition({ entry }: { entry: FlowTransitionEntry }) {
  const text = transitionText(entry);
  return (
    <div className="rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] bg-[var(--yk-surface-2)] p-2 text-[length:var(--yk-text-small-size)]" data-testid="log-transition">
      <span className="block font-semibold">Переход: {text.route}</span>
      <span className="block">Решил: {text.decider}</span>
      {text.reason ? <span className="block">Причина: {text.reason}</span> : null}
      {text.day ? <span className="block text-[var(--yk-muted)]">{text.day}</span> : null}
    </div>
  );
}

function FirstMessage({ entry }: { entry: FirstMessageEntry }) {
  return (
    <div className="rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] bg-[var(--yk-surface-2)] p-2 text-[length:var(--yk-text-small-size)]" data-testid="log-first-message">
      <span className="block font-semibold">Почему бот написал первым</span>
      <ul className="list-disc pl-5">
        {firstMessageLines(entry.reasons).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function ChatMigration({ entry }: { entry: ChatMigrationEntry }) {
  const text = migrationText(entry);
  return (
    <div className="rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] bg-[var(--yk-surface-2)] p-2 text-[length:var(--yk-text-small-size)]" data-testid="log-migration">
      <span className="block font-semibold">{text.title}</span>
      <span className="block">Перевёл: {text.by}</span>
      <span className="block">{text.versions}</span>
      <ul className="list-disc pl-5">
        {text.moves.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function ToolCall({ entry }: { entry: ToolCallEntry }) {
  const video = entry.error ? null : shownVideoOf(entry.output);
  return (
    <details className="rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] p-2">
      <summary className="cursor-pointer text-[length:var(--yk-text-small-size)]">
        <span className="font-semibold">Инструмент</span> · {entry.name} · {entry.durationMs} мс
        {video ? <span className="block">▶ {video.title}</span> : null}
        {entry.error ? <span className="block text-[var(--yk-danger)]">ошибка: {shorten(entry.error)}</span> : null}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <Block title="Аргументы">{json(entry.input)}</Block>
        {entry.error ? (
          <Block title="Ошибка">{entry.error}</Block>
        ) : video ? (
          <div className="text-[length:var(--yk-text-small-size)]">
            <VideoLink video={video} />
          </div>
        ) : (
          <Block title="Результат">{json(entry.output ?? null)}</Block>
        )}
      </div>
    </details>
  );
}

function Entry({ entry }: { entry: AgentLogTurn["entries"][number] }) {
  switch (entry.kind) {
    case "model":
      return <ModelCall entry={entry} />;
    case "tool":
      return <ToolCall entry={entry} />;
    case "transition":
      return <FlowTransition entry={entry} />;
    case "first-message":
      return <FirstMessage entry={entry} />;
    case "migration":
      return <ChatMigration entry={entry} />;
  }
}

function Turn({ turn }: { turn: AgentLogTurn }) {
  const totals = turnTotals(turn);
  const failed = turn.entries.some((entry) => (entry.kind === "model" || entry.kind === "tool") && entry.error);
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--yk-text-small-size)]">
        <span className="tabular-nums text-[var(--yk-muted)]">{timeFormat.format(new Date(turn.startedAt))}</span>
        <Badge variant={turn.agent === "constructor" ? "cool" : "warm"}>{whoLabel(turn)}</Badge>
        {failed ? <Badge variant="neutral">Ошибка</Badge> : null}
        {isFlowTurn(turn) ? null : (
          <span className="text-[var(--yk-muted)]">
            токены: вход {totals.input}
            {totals.cacheRead ? ` (из кэша ${totals.cacheRead})` : ""} · выход {totals.output}
          </span>
        )}
      </div>
      <ol className="flex flex-col gap-1" aria-label="Шаги хода">
        {turn.entries.map((entry, index) => (
          <li key={index}>
            <Entry entry={entry} />
          </li>
        ))}
      </ol>
    </li>
  );
}

/** Журнал работы агентов лидмагнита: ходы новым сверху, внутри — вызовы модели и инструментов. */
export function LogTab({ leadMagnetId }: { leadMagnetId: string }) {
  const [turns, setTurns] = useState<AgentLogTurn[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(
    (before?: string) =>
      startTransition(async () => {
        try {
          const page = await loadAgentLogAction(leadMagnetId, before);
          setTurns((current) => (before && current ? [...current, ...page.turns] : page.turns));
          setNextBefore(page.nextBefore);
          setError(null);
        } catch {
          setError("Не удалось загрузить журнал");
        }
      }),
    [leadMagnetId],
  );

  useEffect(() => load(), [load]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">Вызовы модели и инструментов, переходы по сценарию за 30 дней</span>
        <Button variant="secondary" size="sm" loading={pending} onClick={() => load()}>
          Обновить
        </Button>
      </div>
      {error ? <p role="alert" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">{error}</p> : null}
      {turns && turns.length === 0 ? <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">Агенты ещё не работали.</p> : null}
      <ol className="flex flex-col divide-y divide-[var(--yk-border)]" aria-label="Ходы агентов">
        {(turns ?? []).map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}
      </ol>
      {nextBefore ? (
        <Button variant="ghost" size="sm" loading={pending} onClick={() => load(nextBefore)}>
          Показать ещё
        </Button>
      ) : null}
    </div>
  );
}
