import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { CHANNEL_LABELS } from "@/modules/channels";
import type { OutboundKind } from "@/modules/channels/schema";
import { listUnansweredThreads, loadInboxThread, type InboxMessage, type InboxThreadSummary } from "@/modules/inbox";
import { getDatabase } from "@/modules/platform/db";
import { isUuid } from "@/modules/platform/uuid";
import { TrayIcon as Tray } from "@phosphor-icons/react/dist/ssr";
import { EmptyState, PageHeader, VideoLink } from "@/ui";
import { AgentMessage } from "@/ui/agent-message";
import { InboxAutoRefresh } from "./auto-refresh";
import { MessageImage } from "./message-image";
import { ReplyForm } from "./reply-form";
import { ThreadMessages } from "./thread-messages";

export const dynamic = "force-dynamic";

const timeFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const OUTBOUND_AUTHORS: Record<OutboundKind, string> = {
  consultant: "Консультант",
  reminder: "Напоминание",
  outreach: "Консультант, первым",
  autoreply: "Автоответ",
  manual_reply: "Вы",
  mailing: "Рассылка",
  menu: "Меню",
  system: "Бот",
};

const CLIENT_PHOTO = { label: "Фото клиента", missingText: "Фото не сохранилось" };
const SENT_IMAGE = { label: "Отправленная картинка", missingText: "Картинка не сохранилась" };

const nameOf = (thread: { displayName: string | null }) => thread.displayName ?? "Без имени";

export default async function Page({ searchParams }: { searchParams: Promise<{ person?: string | string[] }> }) {
  await requireUser();
  const { db } = getDatabase();
  const { person } = await searchParams;
  const selectedId = typeof person === "string" && isUuid(person) ? person : null;
  const [threads, selected] = await Promise.all([listUnansweredThreads(db), selectedId ? loadInboxThread(db, selectedId) : null]);

  return (
    <>
      <InboxAutoRefresh />
      <PageHeader title="Входящие" description="Сообщения, на которые консультант не отвечает. Ответ уходит человеку от имени бота." />
      {/* На узком экране колонка одна: выбрана переписка — она вместо списка, иначе только список */}
      <div className={`grid gap-[var(--yk-space-6)] ${threads.length === 0 && !selectedId ? "" : "lg:grid-cols-[22rem_1fr]"}`}>
        <nav aria-label="Неотвеченные" className={`${selectedId ? "hidden lg:flex" : "flex"} flex-col gap-2`}>
          {threads.length === 0 ? (
            <EmptyState icon={Tray} title="Новых вопросов нет" hint="Сюда попадут сообщения, на которые консультант не ответил сам." />
          ) : null}
          {threads.map((thread) => (
            <ThreadLink key={thread.personId} thread={thread} active={thread.personId === selectedId} />
          ))}
        </nav>
        <section aria-label="Переписка" className={selectedId ? "flex flex-col gap-[var(--yk-space-4)]" : threads.length === 0 ? "hidden" : "hidden lg:block"}>
          {selectedId ? (
            <Link href="/inbox" className="app-focus w-fit text-[length:var(--yk-text-small-size)] underline lg:hidden">
              ← Все переписки
            </Link>
          ) : null}
          {selected ? (
            <Card data-inbox-thread>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <Link href={`/people/${selected.person.id}`} className="app-focus underline">
                    {nameOf(selected.person)}
                  </Link>
                  <span className="text-[length:var(--yk-text-small-size)] font-normal text-[var(--yk-muted)]">
                    {CHANNEL_LABELS[selected.person.channel]}, бот «{selected.person.botTitle}»
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-[var(--yk-space-6)]">
                {selected.handoverReason ? <Alert variant="warm" title="Консультант не ответил сам — ответьте человеку">{handoverText(selected.handoverReason)}</Alert> : null}
                {selected.undeliveredReply ? <Alert variant="danger" title="Ваш ответ не ушёл">{selected.undeliveredReply}</Alert> : null}
                <ThreadMessages personId={selected.person.id} lastMessageId={selected.messages.at(-1)?.id ?? null}>
                  {selected.messages.map((message) => (
                    <Message key={message.id} message={message} />
                  ))}
                </ThreadMessages>
                {selected.cannotReply ? (
                  <Alert variant="warm" title="Ответить нельзя">{selected.cannotReply}</Alert>
                ) : (
                  <ReplyForm
                    // Черновик — одному собеседнику: другой человек начинает форму заново, а новое входящее черновик не стирает
                    key={selected.person.id}
                    personId={selected.person.id}
                    seenUpTo={selected.seenUpTo.toISOString()}
                    requestId={randomUUID()}
                  />
                )}
              </CardContent>
            </Card>
          ) : selectedId ? (
            <p className="text-[var(--yk-muted)]">Человек не найден.</p>
          ) : (
            <p className="text-[var(--yk-muted)]">Выберите переписку слева.</p>
          )}
        </section>
      </div>
    </>
  );
}

function ThreadLink({ thread, active }: { thread: InboxThreadSummary; active: boolean }) {
  return (
    <Link
      href={`/inbox?person=${thread.personId}`}
      aria-current={active ? "page" : undefined}
      className={`app-focus flex flex-col gap-1 rounded-[var(--yk-radius-lg)] border border-[var(--yk-border)] p-[var(--yk-space-4)] ${active ? "bg-[var(--yk-surface-2)]" : "bg-[var(--yk-surface)]"}`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold">{nameOf(thread)}</span>
        <Badge variant="warm">{thread.unansweredCount}</Badge>
      </span>
      <span className="truncate text-[length:var(--yk-text-small-size)]">{thread.lastText}</span>
      <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
        {thread.botTitle}
        {thread.lastMessageAt ? ` · ${timeFormat.format(thread.lastMessageAt)}` : ""}
      </span>
      {thread.handoverReason ? <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">Консультант не ответил: {thread.handoverReason}</span> : null}
      {thread.replyUndelivered ? <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">Ваш ответ не ушёл</span> : null}
    </Link>
  );
}

/** Причина передачи — отдельной фразой после заголовка плашки. */
const handoverText = (reason: string) => `Причина: ${reason}${/[.!?]$/.test(reason) ? "" : "."}`;

function Message({ message }: { message: InboxMessage }) {
  if (message.kind === "start")
    return (
      <p className="self-center text-center text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
        {message.text} · {timeFormat.format(message.at)}
      </p>
    );
  const author = message.kind === "person" ? null : OUTBOUND_AUTHORS[message.kind];
  return (
    <AgentMessage side={message.direction === "in" ? "user" : "agent"} className="whitespace-pre-wrap">
      {author ? <span className="block text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{author}{message.failed ? ` · не доставлено${message.failureReason ? `: ${message.failureReason}` : ""}` : ""}</span> : null}
      {message.image ? <MessageImage image={message.image} {...(message.direction === "in" ? CLIENT_PHOTO : SENT_IMAGE)} /> : null}
      {message.video ? <VideoLink video={message.video} /> : message.text}
      <span className="block text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{timeFormat.format(message.at)}</span>
    </AgentMessage>
  );
}
