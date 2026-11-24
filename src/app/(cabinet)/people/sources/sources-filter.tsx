"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@/ui";
import { NavigationProgress } from "@/ui/navigation-progress";
import { SOURCE_PERIOD_LABELS, SOURCE_PERIODS, sourcesHref, type SourcePeriod } from "./sources-params";

const ALL_LEAD_MAGNETS = "all";

/** Период и лидмагнит «Откуда пришли»: выбор сразу меняет адрес, отчёт пересчитывается на сервере. */
export function SourcesFilter({ period, leadMagnetId, leadMagnets }: { period: SourcePeriod; leadMagnetId?: string; leadMagnets: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [opening, startOpening] = useTransition();
  const open = (view: { period: SourcePeriod; leadMagnetId?: string }) => startOpening(() => router.push(sourcesHref(view)));
  return (
    <div className="flex flex-wrap gap-[var(--yk-space-4)] max-sm:flex-col" data-testid="sources-filter" aria-busy={opening}>
      <NavigationProgress active={opening} />
      <Select
        aria-label="Период"
        className="w-full sm:w-44"
        value={period}
        onValueChange={(value) => open({ period: value as SourcePeriod, leadMagnetId })}
        options={SOURCE_PERIODS.map((value) => ({ value, label: SOURCE_PERIOD_LABELS[value] }))}
      />
      <Select
        aria-label="Лидмагнит"
        className="w-full sm:w-72"
        value={leadMagnetId ?? ALL_LEAD_MAGNETS}
        onValueChange={(value) => open({ period, ...(value !== ALL_LEAD_MAGNETS && { leadMagnetId: value }) })}
        options={[{ value: ALL_LEAD_MAGNETS, label: "Все лидмагниты" }, ...leadMagnets.map((lead) => ({ value: lead.id, label: lead.name || "Без названия" }))]}
      />
    </div>
  );
}
