import { ChartBarIcon as BarChart3 } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Alert, Badge, Card, CardContent, Stat } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { listPeopleFilterOptions, sourcesReport, type SourceRow } from "@/modules/people";
import { getDatabase } from "@/modules/platform/db";
import { DataTable, PageHeader, PEOPLE_TABS, SectionTabs, type DataTableColumn } from "@/ui";
import { searchParamsFromFilter } from "../filter-url";
import { sourcesCostFormatter } from "./sources-cost";
import { SourcesFilter } from "./sources-filter";
import { sourcesViewFromSearchParams } from "./sources-params";

export const dynamic = "force-dynamic";

/** Меньше стольких людей за период — сравнивать источники рано. */
const FEW_PEOPLE = 10;

const sourceName = (row: SourceRow) =>
  row.kind === "label" ? row.label! : row.kind === "main" ? "Основная ссылка и меню бота" : "Без ссылки (лидмагнит по умолчанию)";

function sourceColumns(rows: SourceRow[], sinceDay: string | null): DataTableColumn<SourceRow>[] {
  const formatCost = sourcesCostFormatter(rows.map((row) => row.costUsd));
  return [
    {
      key: "source",
      header: "Источник",
      render: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{sourceName(row)}</span>
          {row.archived ? <Badge variant="neutral">В архиве</Badge> : null}
        </span>
      ),
    },
    { key: "lead", header: "Лидмагнит", cardLine: "plain", render: (row) => row.leadMagnetName || "Без названия" },
    {
      key: "arrived",
      header: "Пришли",
      align: "right",
      numeric: true,
      cardLine: "labeled",
      // Список — ровно эти люди: первый приход по этому источнику в этом периоде
      render: (row) =>
        row.arrived > 0 ? (
          <Link
            href={`/people?${searchParamsFromFilter({ arrival: { leadMagnetId: row.leadMagnetId, linkId: row.linkId, ...(sinceDay && { sinceDay }) } })}`}
            className="app-focus font-semibold underline underline-offset-2"
            aria-label={`Люди: ${sourceName(row)}, ${row.arrived}`}
          >
            {row.arrived}
          </Link>
        ) : (
          row.arrived
        ),
    },
    { key: "completed", header: "Дошли до конца", align: "right", numeric: true, cardLine: "labeled", render: (row) => row.completed },
    { key: "purchased", header: "Купили", align: "right", numeric: true, cardLine: "labeled", render: (row) => row.purchased },
    { key: "cost", header: "Расход ИИ", align: "right", numeric: true, cardLine: "labeled", render: (row) => formatCost(row.costUsd) },
  ];
}

export default async function SourcesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  const view = sourcesViewFromSearchParams(await searchParams, new Date());
  const { db } = getDatabase();
  const [options, report] = await Promise.all([
    listPeopleFilterOptions(db),
    sourcesReport(db, { sinceDay: view.sinceDay, ...(view.leadMagnetId && { leadMagnetId: view.leadMagnetId }) }),
  ]);

  return (
    <>
      <PageHeader title="Люди" tabs={<SectionTabs label="Разделы «Люди»" tabs={PEOPLE_TABS} />} />
      <div className="flex flex-col gap-[var(--yk-space-6)]">
        <Card>
          <CardContent>
            <SourcesFilter period={view.period} leadMagnetId={view.leadMagnetId} leadMagnets={options.leadMagnets} />
          </CardContent>
        </Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Итог за период">
          <Stat value={String(report.totals.arrived)} label="пришли" data-testid="sources-arrived" />
          <Stat value={String(report.totals.completed)} label="дошли до конца" data-testid="sources-completed" />
          <Stat value={String(report.totals.purchased)} label="купили" data-testid="sources-purchased" />
        </div>
        {report.totals.arrived > 0 && report.totals.arrived < FEW_PEOPLE ? (
          <Alert variant="warm" title="Людей пока мало — сравнивать источники рано." />
        ) : null}
        {report.totals.arrived === 0 && report.rows.length > 0 ? (
          <Alert variant="info" title="За этот период никто не пришёл" data-testid="sources-nobody" />
        ) : null}
        <DataTable
          columns={sourceColumns(report.rows, view.sinceDay)}
          rows={report.rows}
          rowKey={(row) => row.linkId ?? `without-link-${row.leadMagnetId}`}
          empty={{
            icon: BarChart3,
            title: "За этот период никто не пришёл",
            hint: "Выберите период длиннее или сделайте ссылку с меткой для рекламы.",
          }}
        />
        <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          Чтобы видеть, какая реклама приводит людей, давайте каждому объявлению свою ссылку с меткой: «Лидмагниты» → лидмагнит →
          «Публикация» → «Ссылки с метками». Обычные utm-метки здесь не считаются.
        </p>
        <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          Человек засчитывается ссылке, по которой впервые начал лидмагнит: «Начать заново» и возврат через меню нового прихода
          не дают. «Дошли до конца» и «Купили» — из пришедших за период, к сегодняшнему дню. Дни считаются по Москве. Число
          «Пришли» открывает список этих людей. Кто прошёл два лидмагнита, есть в строке каждого, а в итоге — один раз.
        </p>
      </div>
    </>
  );
}
