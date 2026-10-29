import { UsersIcon as Users } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { CHANNEL_LABELS } from "@/modules/channels";
import { REPLY_WINDOW_DAYS, getMailing, loadMailingReport, type MailingReportRow, type RecipientOutcome } from "@/modules/mailings";
import { getDatabase } from "@/modules/platform/db";
import { DataTable, PageHeader, type DataTableColumn } from "@/ui";
import type { SearchParams } from "../../people/filter-params";
import { cancelMailingAction } from "../actions";
import { MailingEditor } from "../mailing-editor";
import { MAILING_STATUS_BADGES, MAILING_STATUS_LABELS, mskDateTime } from "../status-labels";

export const dynamic = "force-dynamic";

/** Сколько строк получателей показывать: недоставленные идут первыми. */
const REPORT_ROWS = 300;

const DONE_NOTICES: Record<string, string> = {
  test: "Проба отправлена — проверьте мессенджер.",
  save: "Черновик сохранён.",
  now: "Рассылка запущена.",
  schedule: "Рассылка запланирована.",
};

const OUTCOMES: Record<RecipientOutcome, { label: string; variant: "cool" | "neutral" | "success" | "warm" }> = {
  sent: { label: "Ушло", variant: "success" },
  failed: { label: "Не доставлено", variant: "warm" },
  blocked: { label: "Заблокировал", variant: "warm" },
  waiting: { label: "В очереди", variant: "neutral" },
};

const columns: DataTableColumn<MailingReportRow>[] = [
  {
    key: "person",
    header: "Человек",
    render: (row) => (
      <Link href={`/people/${row.personId}`} className="app-focus underline-offset-2 hover:underline">
        {row.displayName ?? "Без имени"}
      </Link>
    ),
  },
  {
    key: "bot",
    header: "Бот",
    render: (row) => (row.botTitle ? `${row.botTitle}${row.channel ? `, ${CHANNEL_LABELS[row.channel]}` : ""}` : "—"),
  },
  {
    key: "outcome",
    header: "Итог",
    render: (row) => (
      <div className="flex flex-col gap-1">
        <Badge variant={OUTCOMES[row.outcome].variant}>{OUTCOMES[row.outcome].label}</Badge>
        {row.error ? <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{row.error}</span> : null}
      </div>
    ),
  },
  { key: "replied", header: "Ответил", align: "right", render: (row) => (row.replied ? "да" : "") },
];

const single = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const { db } = getDatabase();
  const mailing = await getMailing(db, id);
  if (!mailing) {
    return (
      <>
        <PageHeader title="Рассылка не найдена" />
        <Link href="/mailings" className="app-focus underline">
          ← Ко всем рассылкам
        </Link>
      </>
    );
  }

  const done = single(query.done);
  const error = single(query.error);
  const notices = (
    <>
      {done && DONE_NOTICES[done] ? <Alert variant="success" title={DONE_NOTICES[done]} /> : null}
      {error ? <Alert variant="danger" title={error} /> : null}
    </>
  );

  if (mailing.status === "draft") {
    return (
      <>
        <PageHeader title="Черновик рассылки" action={<Badge variant="neutral">Черновик</Badge>} />
        <div className="mb-[var(--yk-space-6)] flex flex-col gap-2">{notices}</div>
        <MailingEditor mailing={mailing} params={query} basePath={`/mailings/${mailing.id}`} />
      </>
    );
  }

  const report = await loadMailingReport(db, mailing.id);
  return (
    <>
      <PageHeader
        title="Рассылка"
        action={
          <Badge variant={MAILING_STATUS_BADGES[mailing.status]} data-testid="mailing-status">
            {MAILING_STATUS_LABELS[mailing.status]}
          </Badge>
        }
      />
      <div className="flex flex-col gap-[var(--yk-space-6)]">
        {notices}
        <Card>
          <CardHeader>
            <CardTitle>
              {mailing.status === "scheduled" && mailing.scheduledAt
                ? `Уйдёт ${mskDateTime.format(mailing.scheduledAt)} по Москве`
                : mailing.startedAt
                  ? `Началась ${mskDateTime.format(mailing.startedAt)} по Москве`
                  : "Не отправлялась"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-[var(--yk-space-4)]">
            <p className="whitespace-pre-wrap">{mailing.text}</p>
            {mailing.imagePath ? <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">С картинкой</p> : null}
            {mailing.status === "scheduled" ? (
              <form action={cancelMailingAction}>
                <input type="hidden" name="mailingId" value={mailing.id} />
                <Button type="submit" variant="destructive">
                  Отменить
                </Button>
              </form>
            ) : null}
          </CardContent>
        </Card>

        {report && report.recipients > 0 ? (
          <>
            <dl className="grid grid-cols-2 gap-[var(--yk-space-4)] sm:grid-cols-4" data-testid="mailing-report">
              <Stat label="Получателей" value={report.recipients} />
              <Stat label="Ушло" value={report.sent} />
              <Stat label="Не доставлено" value={report.failed} hint={report.blocked ? `из них заблокировали: ${report.blocked}` : undefined} />
              <Stat label="Ответили" value={report.replied} hint={`в течение ${REPLY_WINDOW_DAYS} дней`} />
            </dl>
            {report.waiting > 0 ? <p className="text-[var(--yk-muted)]">Ещё в очереди: {report.waiting}</p> : null}
            <DataTable columns={columns} rows={report.people.slice(0, REPORT_ROWS)} rowKey={(row) => row.personId} empty={{ icon: Users, title: "Получателей нет" }} />
          </>
        ) : mailing.status === "done" ? (
          <p className="text-[var(--yk-muted)]">Под фильтр никто не подошёл — рассылка никому не ушла.</p>
        ) : null}
      </div>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <Card>
      <CardContent>
        <dt className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{label}</dt>
        <dd className="text-[length:var(--yk-text-number-size)] font-semibold">{value}</dd>
        {hint ? <dd className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{hint}</dd> : null}
      </CardContent>
    </Card>
  );
}
