import { UsersIcon as Users } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { CHANNEL_LABELS } from "@/modules/channels";
import { REPLY_WINDOW_DAYS, getMailing, loadMailingReport, type MailingReportRow, type RecipientOutcome } from "@/modules/mailings";
import { getDatabase } from "@/modules/platform/db";
import { ArrowLink, DataTable, PageHeader, type DataTableColumn } from "@/ui";
import type { SearchParams } from "../../people/filter-params";
import { pageFromSearchParams } from "../../people/filter-params";
import { MailingEditor } from "../mailing-editor";
import { CancelMailingButton } from "./cancel-mailing-button";
import { mailingHeadline } from "../status-labels";
import { RefreshWhileSending } from "./refresh-while-sending";

export const dynamic = "force-dynamic";

/** Сколько строк получателей на странице отчёта: недоставленные идут первыми. */
const REPORT_PAGE_SIZE = 100;

const DONE_NOTICES: Record<string, string> = {
  test: "Проба отправлена — проверьте мессенджер.",
  save: "Черновик сохранён.",
  schedule: "Рассылка запланирована.",
};

const OUTCOMES: Record<RecipientOutcome, { label: string; variant: "cool" | "neutral" | "success" | "warm" | "danger" }> = {
  sent: { label: "Ушло", variant: "success" },
  failed: { label: "Не доставлено", variant: "danger" },
  blocked: { label: "Заблокировал", variant: "danger" },
  waiting: { label: "В очереди", variant: "neutral" },
  skipped: { label: "Пропущен", variant: "neutral" },
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
      <div className="flex flex-col items-start gap-1">
        <Badge variant={OUTCOMES[row.outcome].variant}>{OUTCOMES[row.outcome].label}</Badge>
        {row.error ? <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{row.error}</span> : null}
      </div>
    ),
  },
  { key: "replied", header: "Ответил", render: (row) => (row.replied ? "да" : "") },
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
        <ArrowLink href="/mailings">Ко всем рассылкам</ArrowLink>
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

  const page = pageFromSearchParams(query);
  const report = await loadMailingReport(db, mailing.id, { limit: REPORT_PAGE_SIZE, offset: (page - 1) * REPORT_PAGE_SIZE });
  const headline = mailingHeadline({ ...mailing, sentCount: report?.sent ?? 0 }, new Date());
  const pages = Math.max(1, Math.ceil((report?.recipients ?? 0) / REPORT_PAGE_SIZE));
  const pageLink = (target: number) => `/mailings/${mailing.id}${target > 1 ? `?page=${target}` : ""}`;
  return (
    <>
      {headline.live ? <RefreshWhileSending /> : null}
      <PageHeader
        title="Рассылка"
        action={
          <Badge variant={headline.badge.variant} data-testid="mailing-status">
            {headline.badge.label}
          </Badge>
        }
      />
      <div className="flex flex-col gap-[var(--yk-space-6)]">
        {notices}
        <Card>
          <CardHeader>
            <CardTitle>{headline.title}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-[var(--yk-space-4)]">
            <p className="whitespace-pre-wrap">{mailing.text}</p>
            {mailing.imagePath ? <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">С картинкой</p> : null}
            {headline.canCancel ? <CancelMailingButton mailingId={mailing.id} /> : null}
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
            {report.skipped > 0 ? (
              <p className="text-[var(--yk-muted)]">
                Пропущено: {report.skipped} — к отправке были посреди лидмагнита, рассылка не стала мешать разговору.
              </p>
            ) : null}
            <DataTable columns={columns} rows={report.people} rowKey={(row) => row.personId} empty={{ icon: Users, title: "Получателей нет" }} />
            {pages > 1 ? (
              <nav aria-label="Страницы отчёта" className="flex items-center gap-[var(--yk-space-4)] text-[length:var(--yk-text-small-size)]">
                {page > 1 ? (
                  <ArrowLink href={pageLink(page - 1)}>Назад</ArrowLink>
                ) : null}
                <span className="text-[var(--yk-muted)]">
                  Страница {page} из {pages}
                </span>
                {page < pages ? (
                  <ArrowLink href={pageLink(page + 1)} direction="forward">Дальше</ArrowLink>
                ) : null}
              </nav>
            ) : null}
          </>
        ) : mailing.status === "done" ? (
          <Alert variant="warm" title="Рассылка никому не ушла: получателей не нашлось">
            При запуске под условие «Кому» не подошёл ни один человек. Возможно, после планирования удалили поле или бота из условия. Проверьте условие и создайте рассылку заново.
          </Alert>
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
