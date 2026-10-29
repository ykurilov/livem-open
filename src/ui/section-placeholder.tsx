import { Card, CardContent } from "@/ui/primitives";
import { CABINET_SECTIONS } from "./cabinet-sections";
import { PageHeader } from "./page-header";

/** Заглушка раздела, пока его экран не сделан. Заменяется экраном целиком. */
export function SectionPlaceholder({ href }: { href: string }) {
  const section = CABINET_SECTIONS.find((candidate) => candidate.href === href);
  if (!section) throw new Error(`Нет раздела кабинета ${href}`);
  return (
    <>
      <PageHeader title={section.title} />
      <Card>
        <CardContent className="py-8 text-[var(--yk-muted)]">Этот раздел появится на следующих этапах.</CardContent>
      </Card>
    </>
  );
}
