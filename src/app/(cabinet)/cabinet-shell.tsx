"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { SignOutIcon } from "@phosphor-icons/react";
import { AppShell } from "@ykurilov/ds-react";
import type { CabinetUser } from "@/modules/access";
import { BrandLogo, CABINET_SECTIONS, isSectionActive } from "@/ui";
import { PendingLink } from "@/ui/navigation-progress";
import { BoardLayoutContext } from "./board-layout";
import { NAVIGATION_EXPANDED_COOKIE } from "./navigation-cookie";

const BRAND = "Живые лидмагниты";

export function CabinetShell({ user, unanswered, navigationExpanded, children }: {
  user: Pick<CabinetUser, "name" | "email">;
  unanswered: number;
  /** Меню раскрыто с названиями разделов: выбор помнит кука, чтобы страница сразу пришла в нужном виде. */
  navigationExpanded: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const openSettings = () => router.push("/settings");
  const [boardActive, setBoardActive] = useState(false);
  const [expanded, setExpanded] = useState(navigationExpanded);
  const changeCollapsed = (collapsed: boolean) => {
    document.cookie = `${NAVIGATION_EXPANDED_COOKIE}=${collapsed ? "0" : "1"}; path=/; max-age=31536000; samesite=lax`;
    setExpanded(!collapsed);
  };
  const navigation = CABINET_SECTIONS.map(section => ({
    id: section.href, label: section.title, icon: section.icon, href: section.href,
    active: isSectionActive(section, pathname),
    badge: section.href === "/inbox" && unanswered > 0 ? { value: unanswered, label: `${unanswered} без ответа` } : undefined,
  }));
  return <BoardLayoutContext value={setBoardActive}>
    <AppShell className={boardActive ? "app-shell app-shell--board" : "app-shell"}
      brand={{ label: BRAND, logo: <BrandLogo />, href: "/" }} linkComponent={PendingLink}
      navigation={navigation} navigationLabel="Разделы кабинета"
      collapsed={!expanded} onCollapsedChange={changeCollapsed}
      labels={{ expand: "Раскрыть меню", collapse: "Свернуть меню", open: "Открыть меню", close: "Закрыть меню" }}
      account={{
        // Без имени показываем одну строку: почта вместо имени, второй строки нет
        name: user.name || user.email, email: user.email, show: user.name ? undefined : "name",
        menu: [
          { label: "Настройки", onSelect: openSettings },
          "separator",
          { label: "Выйти", icon: SignOutIcon, onSelect: () => { window.location.href = "/api/auth/logout"; } },
        ],
      }}
      onSettings={openSettings}>
      <div id="app-content" className={boardActive ? "app-content app-content--board" : "app-content"}>{children}</div>
    </AppShell>
  </BoardLayoutContext>;
}
