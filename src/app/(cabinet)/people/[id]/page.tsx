import { NotebookIcon as NotebookText } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { CHANNEL_LABELS, CONTACT_SOURCE_LABELS } from "@/modules/channels";
import { loadPersonCard, type PersonCardPassage } from "@/modules/people";
import { getChatStorage } from "@/modules/platform/chat-storage";
import { getDatabase } from "@/modules/platform/db";
import { requireEnv } from "@/modules/platform/env";
import { isUuid } from "@/modules/platform/uuid";
import { formatUsd } from "@/modules/spending";
import { EmptyState, ImageLink, PageHeader, VideoLink } from "@/ui";
import { AgentMessage } from "@/ui/agent-message";
import { PASSAGE_STATUS_BADGES, PASSAGE_STATUS_LABELS } from "../status-labels";

export const dynamic = "force-dynamic";

const dateTimeFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const card = isUuid(id)
    ? await loadPersonCard({ db: getDatabase().db, chatStorage: await getChatStorage(requireEnv("DATABASE_URL")) }, id)
    : null;
  if (!card) notFound();

  return (
    <>
      <PageHeader
        title={card.displayName ?? "Без имени"}
        description={`${CHANNEL_LABELS[card.channel]}, бот «${card.botTitle}». В базе с ${dateTimeFormat.format(card.createdAt)}.${card.source ? ` Источник: ${CONTACT_SOURCE_LABELS[card.source]}.` : ""}`}
        action={card.blockedAt ? <Badge variant="warm">Заблокировал бота</Badge> : undefined}
      />
      <div className="flex flex-col gap-[var(--yk-space-6)]">
        <Link href="/people" className="app-focus w-fit text-[length:var(--yk-text-small-size)] underline">
          ← К базе
        </Link>
        <div className="grid gap-[var(--yk-space-6)] md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Поля</CardTitle>
            </CardHeader>
            <CardContent>
              {card.fields.length === 0 ? (
                <p className="text-[var(--yk-muted)]">Консультант пока не заполнил ни одного поля.</p>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-[var(--yk-space-4)] gap-y-2" data-testid="person-fields">
                  {card.fields.map((field) => (
                    <div key={field.id} className="contents">
                      <dt className="text-[var(--yk-muted)]">{field.name}</dt>
                      <dd className="font-semibold">{field.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Факты</CardTitle>
            </CardHeader>
            <CardContent>
              {card.facts.length === 0 ? (
                <EmptyState icon={NotebookText} title="Фактов пока нет" hint="Они появятся, когда человек расскажет о себе в разговоре." />
              ) : (
                <ul className="flex list-disc flex-col gap-1 pl-5">
                  {card.facts.map((fact, index) => (
                    <li key={`${fact.source}-${index}`}>{fact.text}</li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        <h2 className="text-[length:var(--yk-text-heading-size)] font-semibold">Прохождения</h2>
        {card.passages.length === 0 ? <p className="text-[var(--yk-muted)]">Человек ещё не начинал лидмагниты.</p> : null}
        {card.passages.map((passage) => (
          <PassageCard key={passage.id} passage={passage} />
        ))}
      </div>
    </>
  );
}

function PassageCard({ passage }: { passage: PersonCardPassage }) {
  const stopped = passage.status !== "completed" && passage.status !== "active";
  return (
    <Card data-testid="person-passage">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {passage.leadMagnetName}
          <Badge variant={PASSAGE_STATUS_BADGES[passage.status]}>{PASSAGE_STATUS_LABELS[passage.status]}</Badge>
          {passage.linkLabel ? <Badge variant="neutral">метка: {passage.linkLabel}</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-[var(--yk-space-4)]">
        <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          {dateTimeFormat.format(passage.startedAt)}
          {passage.endedAt ? ` — ${dateTimeFormat.format(passage.endedAt)}` : ""} · расход {formatUsd(passage.costUsd)}
          {passage.stageName ? ` · ${stopped ? "остановился на этапе" : "этап"} «${passage.stageName}»` : ""}
        </p>
        {passage.summary ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-[var(--yk-space-4)] gap-y-1 text-[length:var(--yk-text-small-size)]">
            <dt className="text-[var(--yk-muted)]">Цель</dt>
            <dd>{passage.summary.goal}</dd>
            <dt className="text-[var(--yk-muted)]">Где застрял</dt>
            <dd>{passage.summary.stuckAt}</dd>
            <dt className="text-[var(--yk-muted)]">Выбранный шаг</dt>
            <dd>{passage.summary.chosenStep}</dd>
          </dl>
        ) : null}
        <details className="group">
          <summary className="app-focus w-fit cursor-pointer text-[length:var(--yk-text-small-size)] font-semibold">
            Переписка ({passage.messages.length})
          </summary>
          <div className="mt-[var(--yk-space-4)] flex flex-col gap-2">
            {passage.messages.map((message, index) =>
              message.role === "expert" ? (
                <AgentMessage key={index} side="agent" className="whitespace-pre-wrap">
                  <span className="block text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">Ответ эксперта из «Входящих»</span>
                  {message.text}
                </AgentMessage>
              ) : (
                <AgentMessage key={index} side={message.role === "user" ? "user" : "agent"} className={message.role === "user" ? "whitespace-pre-wrap" : undefined}>
                  {message.video ? <VideoLink video={message.video} /> : message.image ? <ImageLink image={message.image} /> : message.text}
                </AgentMessage>
              ),
            )}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
