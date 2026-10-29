import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { CHANNEL_LABELS } from "@/modules/channels";
import type { OutboundKind } from "@/modules/channels/schema";
import { listUnansweredThreads, loadInboxThread, type InboxMessage, type InboxThreadSummary } from "@/modules/inbox";
import { getDatabase } from "@/modules/platform/db";
import { isUuid } from "@/modules/platform/uuid";
import { PageHeader, VideoLink } from "@/ui";
import { AgentMessage } from "@/ui/agent-message";
import { ReplyForm } from "./reply-form";

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

const nameOf = (thread: { displayName: string | null }) => thread.displayName ?? "Без имени";

export default async function Page({ searchParams }: { searchParams: Promise<{ person?: string | string[] }> }) {
  await requireUser();
  const { db } = getDatabase();
  const { person } = await searchParams;
  const selectedId = typeof person === "string" && isUuid(person) ? person : null;
  const [threads, selected] = await Promise.all([listUnansweredThreads(db), selectedId ? loadInboxThread(db, selectedId) : null]);

  return (
    <>
      <PageHeader title="Входящие" description="Сообщения, на которые консультант не отвечает. Ответ уходит человеку от имени бота." />
      <div className="grid gap-[var(--yk-space-6)] lg:grid-cols-[22rem_1fr]">
        <nav aria-label="Неотвеченные" className="flex flex-col gap-2">
          {threads.length === 0 ? <p className="text-[var(--yk-muted)]">Все сообщения отвечены.</p> : null}
          {threads.map((thread) => (
            <ThreadLink key={thread.personId} thread={thread} active={thread.personId === selectedId} />
          ))}
        </nav>
        <section aria-label="Переписка">
          {selected ? (
            <Card>
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
                {selected.handoverReason ? <Alert variant="warm" title="Консультант передал разговор вам">{selected.handoverReason}</Alert> : null}
                <div className="flex flex-col gap-2" data-testid="inbox-messages">
                  {selected.messages.map((message) => (
                    <Message key={message.id} message={message} />
                  ))}
                </div>
                <ReplyForm
                  // Черновик — одному собеседнику: другой человек или новое входящее начинают форму заново
                  key={`${selected.person.id}:${selected.seenUpTo.toISOString()}`}
                  personId={selected.person.id}
                  seenUpTo={selected.seenUpTo.toISOString()}
                  requestId={randomUUID()}
                />
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
      {thread.handoverReason ? <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">Передан вам: {thread.handoverReason}</span> : null}
    </Link>
  );
}

function Message({ message }: { message: InboxMessage }) {
  const author = message.kind === "person" ? null : OUTBOUND_AUTHORS[message.kind];
  return (
    <AgentMessage side={message.direction === "in" ? "user" : "agent"} className="whitespace-pre-wrap">
      {author ? <span className="block text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{author}{message.failed ? " · не доставлено" : ""}</span> : null}
      {message.video ? <VideoLink video={message.video} /> : message.text}
      <span className="block text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{timeFormat.format(message.at)}</span>
    </AgentMessage>
  );
}
