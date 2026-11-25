import Link from "next/link";
import { BooksIcon } from "@phosphor-icons/react/dist/ssr";
import { requireUser } from "@/modules/access";
import { KNOWLEDGE_MAX_CHARS, formatChars, listKnowledgeBases, type KnowledgeBaseListItem } from "@/modules/knowledge";
import { listLeadMagnetCards } from "@/modules/lead-magnets";
import { getDatabase } from "@/modules/platform/db";
import { DataTable, KNOWLEDGE_TABS, PageHeader, SectionTabs, type DataTableColumn } from "@/ui";
import { AddKnowledgeButton, KnowledgeActions } from "./knowledge-dialogs";

export const dynamic = "force-dynamic";

const kilobytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} КБ`;

const columns: DataTableColumn<KnowledgeBaseListItem>[] = [
  {
    key: "title",
    header: "База знаний",
    render: (base) => (
      <div className="flex flex-col">
        <span className="font-semibold">{base.title}</span>
        <span className="text-[var(--yk-muted)]">{base.fileName}</span>
      </div>
    ),
  },
  { key: "size", header: "Размер", render: (base) => `${formatChars(base.charCount)} знаков · ${kilobytes(base.byteSize)}` },
  {
    key: "usedBy",
    header: "Прикреплена",
    render: (base) =>
      base.usedBy.length === 0 ? (
        <span className="text-[var(--yk-muted)]">Ни к одному лидмагниту — консультанты её не получают</span>
      ) : (
        <ul className="flex flex-col">
          {base.usedBy.map((lead) => (
            <li key={lead.id}>
              <Link href={`/lead-magnets/${lead.id}`} className="app-focus underline">
                {lead.name}
              </Link>
            </li>
          ))}
        </ul>
      ),
  },
  { key: "actions", header: "", align: "right", render: (base) => <KnowledgeActions base={base} /> },
];

export default async function Page() {
  await requireUser();
  const { db } = getDatabase();
  const [bases, leadMagnets] = await Promise.all([listKnowledgeBases(db), listLeadMagnetCards(db)]);
  return (
    <>
      <PageHeader title="База знаний" action={<AddKnowledgeButton targets={leadMagnets.map(({ id, name }) => ({ id, name }))} />} tabs={<SectionTabs label="Разделы «Базы знаний»" tabs={KNOWLEDGE_TABS} />} />
      <p className="app-muted mb-4">
        Тексты, на которые консультант опирается в ответах: транскрипты курсов, частые вопросы и ответы на них. Консультант получает базу целиком,
        только когда она подключена к лидмагниту: отметьте лидмагниты при загрузке или подключите базу на вкладке «Настройки» лидмагнита. Файл,
        отправленный в чат конструктора, становится базой и подключается к этому лидмагниту сам. На один лидмагнит помещается до{" "}
        {formatChars(KNOWLEDGE_MAX_CHARS)} знаков.
      </p>
      <DataTable
        columns={columns}
        rows={bases}
        rowKey={(base) => base.id}
        empty={{ icon: BooksIcon, title: "Баз знаний пока нет", hint: "Нажмите «Добавить текст»: например, транскрипт курса или список частых вопросов — файлом .txt, .md или .pdf." }}
      />
    </>
  );
}
