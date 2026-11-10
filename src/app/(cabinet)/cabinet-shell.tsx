"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { SignOutIcon } from "@phosphor-icons/react";
import { AppShell, Avatar, Menu } from "@ykurilov/ds-react";
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
      // На компьютере шапки нет: название — вверху панели. На телефоне рядом с кнопкой меню — название приложения
      header={<Link href="/" className="app-mobile-brand"><BrandLogo /><span>{BRAND}</span></Link>}
      footer={collapsed => <AccountMenu email={user.email} name={user.name || user.email} collapsed={collapsed} />}>
      <div id="app-content" className={boardActive ? "app-content app-content--board" : "app-content"}>{children}</div>
    </AppShell>
  </BoardLayoutContext>;
}

/** Блок аккаунта внизу панели: аватар с инициалами и почта, по нажатию — меню с выходом. */
function AccountMenu({ email, name, collapsed }: { email: string; name: string; collapsed: boolean }) {
  return <Menu label="Аккаунт" entries={[{ label: "Выйти", icon: SignOutIcon, onSelect: () => { window.location.href = "/api/auth/logout"; } }]}
    trigger={<button type="button" className="app-account" aria-label={collapsed ? `Аккаунт ${email}` : undefined} title={email}>
      <Avatar name={name} size="sm" aria-hidden="true" />
      {collapsed ? null : <span className="app-account-email">{email}</span>}
    </button>} />;
}
