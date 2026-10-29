import { MagnifyingGlassIcon as SearchX } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Alert, Badge, Card, CardContent } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { CHANNEL_LABELS, CONTACT_SOURCE_LABELS } from "@/modules/channels";
import { countPeople, listFields, listPeople, listPeopleFilterOptions, type PersonListItem } from "@/modules/people";
import { getDatabase } from "@/modules/platform/db";
import { DataTable, PageHeader, type DataTableColumn } from "@/ui";
import { filterFromSearchParams, pageFromSearchParams, searchParamsFromFilter, type SearchParams } from "./filter-params";
import { PeopleFilterForm } from "./people-filter-form";
import { PASSAGE_STATUS_BADGES, PASSAGE_STATUS_LABELS } from "./status-labels";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const dateFormat = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", year: "numeric" });

const columns: DataTableColumn<PersonListItem>[] = [
  {
    key: "name",
    header: "Человек",
    render: (person) => (
      <Link href={`/people/${person.id}`} className="app-focus font-semibold underline-offset-2 hover:underline">
        {person.displayName ?? "Без имени"}
      </Link>
    ),
  },
  {
    key: "bot",
    header: "Бот",
    render: (person) => (
      <div className="flex flex-col">
        <span>{person.botTitle}</span>
        <span className="text-[var(--yk-muted)]">{CHANNEL_LABELS[person.channel]}</span>
      </div>
    ),
  },
  {
    key: "passage",
    header: "Последний лидмагнит",
    render: (person) =>
      person.lastPassage ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>{person.lastPassage.leadMagnetName}</span>
          <Badge variant={PASSAGE_STATUS_BADGES[person.lastPassage.status]}>{PASSAGE_STATUS_LABELS[person.lastPassage.status]}</Badge>
        </div>
      ) : (
        <span className="text-[var(--yk-muted)]">{person.source ? CONTACT_SOURCE_LABELS[person.source] : "—"}</span>
      ),
  },
  { key: "created", header: "Пришёл", align: "right", numeric: true, render: (person) => dateFormat.format(person.createdAt) },
];

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser();
  const params = await searchParams;
  const { filter, error } = filterFromSearchParams(params);
  const page = pageFromSearchParams(params);
  const { db } = getDatabase();
  const [options, fields, total, rows] = await Promise.all([
    listPeopleFilterOptions(db),
    listFields(db),
    countPeople(db, filter),
    listPeople(db, filter, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageLink = (target: number) => `/people?${searchParamsFromFilter(filter, target)}`;

  return (
    <>
      <PageHeader title="База" />
      <div className="flex flex-col gap-[var(--yk-space-6)]">
        <Card>
          <CardContent>
            <PeopleFilterForm options={options} fields={fields} filter={filter} />
          </CardContent>
        </Card>
        {error ? <Alert variant="warm" title={error} /> : null}
        <p className="font-semibold" data-testid="people-count">
          Найдено: {total}
        </p>
        <DataTable columns={columns} rows={rows} rowKey={(person) => person.id} empty={{ icon: SearchX, title: "Никто не подходит", hint: "Под этот фильтр в базе никого нет." }} />
        {pages > 1 ? (
          <nav aria-label="Страницы" className="flex items-center gap-[var(--yk-space-4)] text-[length:var(--yk-text-small-size)]">
            {page > 1 ? (
              <Link href={pageLink(page - 1)} className="app-focus underline">
                ← Назад
              </Link>
            ) : null}
            <span className="text-[var(--yk-muted)]">
              Страница {page} из {pages}
            </span>
            {page < pages ? (
              <Link href={pageLink(page + 1)} className="app-focus underline">
                Дальше →
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </>
  );
}
