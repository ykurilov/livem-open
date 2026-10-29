import { PaperPlaneTiltIcon as Send } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Badge, Button } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { listMailings, type MailingListItem } from "@/modules/mailings";
import { getDatabase } from "@/modules/platform/db";
import { DataTable, PageHeader, type DataTableColumn } from "@/ui";
import { MAILING_STATUS_BADGES, MAILING_STATUS_LABELS, mskDateTime } from "./status-labels";

export const dynamic = "force-dynamic";

const preview = (text: string) => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

const columns: DataTableColumn<MailingListItem>[] = [
  {
    key: "text",
    header: "Рассылка",
    render: (mailing) => (
      <Link href={`/mailings/${mailing.id}`} className="app-focus font-semibold underline-offset-2 hover:underline">
        {preview(mailing.text)}
      </Link>
    ),
  },
  {
    key: "status",
    header: "Состояние",
    render: (mailing) => <Badge variant={MAILING_STATUS_BADGES[mailing.status]}>{MAILING_STATUS_LABELS[mailing.status]}</Badge>,
  },
  {
    key: "when",
    header: "Когда (Москва)",
    render: (mailing) => (mailing.scheduledAt ? mskDateTime.format(mailing.scheduledAt) : "—"),
  },
  { key: "recipients", header: "Получателей", align: "right", numeric: true, render: (mailing) => (mailing.status === "draft" || mailing.status === "scheduled" ? "—" : mailing.recipientCount) },
];

export default async function Page() {
  await requireUser();
  const mailings = await listMailings(getDatabase().db);
  return (
    <>
      <PageHeader
        title="Рассылки"
        action={
          <Button asChild>
            <Link href="/mailings/new">Новая рассылка</Link>
          </Button>
        }
      />
      <DataTable columns={columns} rows={mailings} rowKey={(mailing) => mailing.id} empty={{ icon: Send, title: "Рассылок пока нет" }} />
    </>
  );
}
