"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { Tab, TabList, Tabs } from "@ykurilov/ds-react";
import { isUnder, type SectionTab } from "./cabinet-sections";
import { NavigationProgress } from "./navigation-progress";

/** Вкладки раздела кабинета: каждая — своя страница, выбор вкладки переходит по её адресу. */
export function SectionTabs({ label, tabs }: { label: string; tabs: SectionTab[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const [opening, startOpening] = useTransition();
  const current = tabs.find((tab) => isUnder(tab.href, pathname))?.href ?? tabs[0]?.href;
  return (
    <Tabs value={current} onValueChange={(href) => startOpening(() => router.push(href))}>
      <NavigationProgress active={opening} />
      <TabList aria-label={label}>
        {tabs.map((tab) => (
          <Tab key={tab.href} value={tab.href} onMouseEnter={() => router.prefetch(tab.href)}>
            {tab.label}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}
