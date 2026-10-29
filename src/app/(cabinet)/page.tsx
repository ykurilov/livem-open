import { MagnetIcon as Magnet } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { listLeadMagnetCards } from "@/modules/lead-magnets";
import { getDatabase } from "@/modules/platform/db";
import { formatUsd } from "@/modules/spending";
import { EmptyState, PageHeader } from "@/ui";
import { CardDescriptionEditor } from "./card-description-editor";
import { createLeadMagnetAction } from "./lead-magnets/actions";

export const dynamic = "force-dynamic";

export default async function LeadMagnetsPage() {
  await requireUser();
  const cards = await listLeadMagnetCards(getDatabase().db);

  return (
    <>
      <PageHeader title="Лидмагниты" />
      <form action={createLeadMagnetAction} className="mb-[var(--yk-space-8)] flex flex-wrap items-end gap-[var(--yk-space-4)]">
        <Field label="Название" className="w-full sm:w-80">
          <Input name="name" required placeholder="Например, разбор воронки" />
        </Field>
        <Field label="Описание" className="w-full sm:w-80">
          <Input name="cardDescription" placeholder="Коротко для карточки" />
        </Field>
        <Button type="submit">Создать</Button>
      </form>

      {cards.length === 0 ? (
        <EmptyState icon={Magnet} title="Лидмагнитов пока нет" hint="Создайте первый: введите название выше." />
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-[var(--yk-space-4)]">
          {cards.map((card) => (
            <li key={card.id}>
              {/* Ссылка растянута на всю карточку; описание с карандашом лежит поверх неё и правится на месте */}
              <Card className="relative h-full">
                <CardHeader>
                  <CardTitle>
                    <Link href={`/lead-magnets/${card.id}`} className="app-focus rounded-[var(--yk-radius-sm)] text-inherit no-underline after:absolute after:inset-0 after:rounded-[var(--yk-radius-lg)] after:content-['']">
                      {card.name}
                    </Link>
                  </CardTitle>
                  <CardDescriptionEditor leadMagnetId={card.id} name={card.name} description={card.cardDescription} />
                </CardHeader>
                <CardContent className="flex items-center justify-between text-[length:var(--yk-text-small-size)]">
                  <Badge variant={card.published ? "success" : "neutral"}>{card.published ? "Опубликован" : "Черновик"}</Badge>
                  <span className="text-[var(--yk-muted)]">
                    Средняя цена: {card.averagePassageCostUsd === null ? "—" : formatUsd(card.averagePassageCostUsd)}
                  </span>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
