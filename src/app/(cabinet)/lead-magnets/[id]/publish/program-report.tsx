import { Stat, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import type { ProgramReport } from "@/modules/lead-magnets";
import { formatUsd } from "@/modules/spending";
import { DataTable, type DataTableColumn } from "@/ui";

const REASON_LABELS: Record<ProgramReport["refusalReasons"][number]["reason"], string> = {
  price: "Дорого",
  time: "Нет времени",
  doubt: "Сомневаются",
  not_interested: "Не интересно",
};

type DayRow = ProgramReport["reachedDay"][number];
type ReasonRow = ProgramReport["refusalReasons"][number];

const dayColumns: DataTableColumn<DayRow>[] = [
  { key: "day", header: "День", render: (row) => `День ${row.day}` },
  { key: "count", header: "Дошли", align: "right", numeric: true, render: (row) => row.count },
];

const reasonColumns: DataTableColumn<ReasonRow>[] = [
  { key: "reason", header: "Причина", render: (row) => REASON_LABELS[row.reason] },
  { key: "count", header: "Людей", align: "right", numeric: true, render: (row) => row.count },
];

function Figure({ value, label, testId }: { value: string; label: string; testId: string }) {
  return <Stat value={value} label={label} data-testid={testId} />;
}

/** Отчёт «Воронка»: кто до какого дня дошёл, кто дошёл до продажи, кто вернулся на сообщения бота, почему отказываются. */
export function ProgramReportCard({ report }: { report: ProgramReport }) {
  const { outreach } = report;
  return (
    <Card data-testid="program-report">
      <CardHeader>
        <CardTitle>Воронка</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-[var(--yk-space-4)]">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Figure value={String(report.passages)} label="проходят или прошли воронку" testId="program-people" />
          <Figure value={String(report.reachedSale)} label="дошли до продажи" testId="program-sale" />
          <Figure
            value={`${outreach.peopleReturned} из ${outreach.people}`}
            label="вернулись, когда бот написал первым"
            testId="program-returned"
          />
        </div>
        <span className="text-[length:var(--yk-text-small-size)] font-semibold">Кто до какого дня дошёл</span>
        <DataTable columns={dayColumns} rows={report.reachedDay} rowKey={(row) => String(row.day)} />
        <span className="text-[length:var(--yk-text-small-size)] font-semibold">Сообщения бота первым</span>
        <p className="text-[length:var(--yk-text-small-size)]" data-testid="program-outreach">
          Бот написал первым {outreach.messages} раз, ответили на {outreach.messagesAnswered}. Это стоило {formatUsd(outreach.costUsd)}. Судья
          сценария, который решает переходы между этапами, стоил {formatUsd(report.judgeCostUsd)}.
        </p>
        {report.refusalReasons.length > 0 ? (
          <>
            <span className="text-[length:var(--yk-text-small-size)] font-semibold">Почему отказываются от предложения</span>
            <DataTable columns={reasonColumns} rows={report.refusalReasons} rowKey={(row) => row.reason} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
