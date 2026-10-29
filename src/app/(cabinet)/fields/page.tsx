import { ListChecksIcon as ListChecks } from "@phosphor-icons/react/dist/ssr";
import { requireUser } from "@/modules/access";
import { listFields, type FieldDefinition, type FieldType } from "@/modules/people";
import { getDatabase } from "@/modules/platform/db";
import { DataTable, PageHeader, type DataTableColumn } from "@/ui";
import { FieldActions } from "./field-actions";

export const dynamic = "force-dynamic";

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  boolean: "да / нет",
  choice: "выбор из списка",
  number: "число",
  text: "текст",
};

const columns: DataTableColumn<FieldDefinition>[] = [
  {
    key: "name",
    header: "Поле",
    render: (field) => (
      <div className="flex flex-col">
        <span className="font-semibold">{field.name}</span>
        {field.description ? <span className="text-[var(--yk-muted)]">{field.description}</span> : null}
      </div>
    ),
  },
  {
    key: "type",
    header: "Тип",
    render: (field) => (
      <div className="flex flex-col">
        <span>{FIELD_TYPE_LABELS[field.type]}</span>
        {field.options.length > 0 ? <span className="text-[var(--yk-muted)]">{field.options.join(", ")}</span> : null}
      </div>
    ),
  },
  { key: "actions", header: "", align: "right", render: (field) => <FieldActions field={field} /> },
];

export default async function Page() {
  await requireUser();
  const fields = await listFields(getDatabase().db);
  return (
    <>
      <PageHeader title="Поля базы" />
      <DataTable columns={columns} rows={fields} rowKey={(field) => field.id} empty={{ icon: ListChecks, title: "Полей пока нет", hint: "Их заводит конструктор лидмагнита." }} />
    </>
  );
}
