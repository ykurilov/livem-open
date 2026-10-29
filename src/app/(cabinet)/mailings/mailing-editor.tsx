import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import { countRecipients, lastTestPersonId, listMailingFilterOptions, listTestRecipients, type Mailing } from "@/modules/mailings";
import { listFields, parsePeopleFilter } from "@/modules/people";
import { getDatabase } from "@/modules/platform/db";
import { filterFromSearchParams, type SearchParams } from "../people/filter-params";
import { PeopleFilterForm } from "../people/people-filter-form";
import { MailingForm } from "./mailing-form";
import { testRecipientOption } from "./test-recipient-option";

const FILTER_KEYS = ["bot", "lead", "link", "status", "fields"];

/** Черновик рассылки: кому (фильтр базы и число получателей) и что (текст, картинка, проба, время). */
export async function MailingEditor({ mailing, params, basePath }: { mailing: Mailing | null; params: SearchParams; basePath: string }) {
  // Фильтр в адресе — то, что эксперт только что выбрал; без него — сохранённый в черновике
  const fromUrl = FILTER_KEYS.some((key) => params[key] !== undefined);
  const { filter, error } = fromUrl || !mailing ? filterFromSearchParams(params) : { filter: parsePeopleFilter(mailing.filter), error: undefined };
  const { db } = getDatabase();
  const lastTester = mailing?.testPersonId ?? (await lastTestPersonId(db));
  const [options, fields, recipientCount, testRecipients] = await Promise.all([
    listMailingFilterOptions(db),
    listFields(db),
    countRecipients(db, filter),
    listTestRecipients(db, { includeId: lastTester }),
  ]);

  return (
    <div className="flex flex-col gap-[var(--yk-space-6)]">
      <Card>
        <CardHeader>
          <CardTitle>Кому</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-[var(--yk-space-4)]">
          <PeopleFilterForm basePath={basePath} options={options} fields={fields} filter={filter} />
          {error ? <Alert variant="warm" title={error} /> : null}
          <p className="font-semibold" data-testid="recipient-count">
            Получателей: {recipientCount}
          </p>
          <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
            Люди посреди лидмагнита, заблокировавшие бота и люди удалённых ботов не входят. Получатели фиксируются в момент отправки.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Что</CardTitle>
        </CardHeader>
        <CardContent>
          <MailingForm
            mailingId={mailing?.id ?? ""}
            text={mailing?.text ?? ""}
            imageName={mailing?.imagePath ? basename(mailing.imagePath) : null}
            filterJson={JSON.stringify(filter)}
            recipientCount={recipientCount}
            testRecipients={testRecipients.map(testRecipientOption)}
            testPersonId={testRecipients.some((person) => person.id === lastTester) ? lastTester : null}
            requestId={randomUUID()}
          />
        </CardContent>
      </Card>
    </div>
  );
}
