import { requireUser } from "@/modules/access";
import { PageHeader } from "@/ui";
import type { SearchParams } from "../../people/filter-params";
import { MailingEditor } from "../mailing-editor";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser();
  return (
    <>
      <PageHeader title="Новая рассылка" />
      <MailingEditor mailing={null} params={await searchParams} basePath="/mailings/new" />
    </>
  );
}
