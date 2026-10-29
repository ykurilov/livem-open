"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { CaretDoubleLeftIcon, CaretDoubleRightIcon, ListIcon, MoonIcon, SignOutIcon, SunIcon, UserCircleIcon } from "@phosphor-icons/react";
import { Button, Icon, Sheet, Sphere, StudioLayout } from "@ykurilov/ds-react";
import type { CabinetUser } from "@/modules/access";
import { CABINET_SECTIONS, isSectionActive } from "@/ui";
import { BoardLayoutContext } from "./board-layout";
import { NAVIGATION_EXPANDED_COOKIE } from "./navigation-cookie";

export function CabinetShell({ user, unanswered, navigationExpanded, children }: {
  user: Pick<CabinetUser, "name" | "email">;
  unanswered: number;
  /** Меню раскрыто с названиями разделов: выбор помнит кука, чтобы страница сразу пришла в нужном виде. */
  navigationExpanded: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [boardActive, setBoardActive] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(navigationExpanded);
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => { setDark(document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches)); }, []);
  const toggleTheme = () => {
    const current = document.documentElement.dataset.theme;
    const next = !(current ? current === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--yk-bg").trim());
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* The selected theme still applies when storage is unavailable. */ }
    setDark(next);
  };
  const toggleExpanded = () => {
    const next = !expanded;
    document.cookie = `${NAVIGATION_EXPANDED_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
    setExpanded(next);
  };
  const userName = user.name || user.email;
  const navigation = (withTitles: boolean, inSheet: boolean) => <div className={withTitles ? "app-sidebar app-sidebar--expanded" : "app-sidebar"}>
    <div className="app-navigation">
      {CABINET_SECTIONS.map(section => {
        const active = isSectionActive(section, pathname);
        return <Link key={section.href} href={section.href} aria-current={active ? "page" : undefined}
          aria-label={section.title} title={section.title} className="app-navigation-link" onClick={() => setMenuOpen(false)}>
          <Icon icon={section.icon} size={22} weight={active ? "fill" : "regular"} />
          {withTitles ? <span className="app-navigation-title">{section.title}</span> : null}
          {section.href === "/inbox" && unanswered > 0 ? <span className="app-navigation-count" aria-label={`${unanswered} без ответа`}>{unanswered}</span> : null}
        </Link>;
      })}
    </div>
    <div className="app-navigation app-sidebar-account">
      <div className="app-navigation-item app-account-name" title={user.email}>
        <Icon icon={UserCircleIcon} size={22} />
        {withTitles ? <span className="app-navigation-title">{userName}</span> : <span className="sr-only">{userName}</span>}
      </div>
      <button type="button" className="app-navigation-link" onClick={toggleTheme} aria-label="Сменить тему" title="Сменить тему">
        <Icon icon={dark ? SunIcon : MoonIcon} size={22} />
        {withTitles ? <span className="app-navigation-title">{dark ? "Светлая тема" : "Тёмная тема"}</span> : null}
      </button>
      <a href="/api/auth/logout" className="app-navigation-link" aria-label="Выйти" title="Выйти">
        <Icon icon={SignOutIcon} size={22} />
        {withTitles ? <span className="app-navigation-title">Выйти</span> : null}
      </a>
      {inSheet ? null : <button type="button" className="app-navigation-link" onClick={toggleExpanded} aria-expanded={expanded}
        aria-label={expanded ? "Свернуть меню" : "Раскрыть меню"} title={expanded ? "Свернуть меню" : "Раскрыть меню"}>
        <Icon icon={expanded ? CaretDoubleLeftIcon : CaretDoubleRightIcon} size={22} />
        {withTitles ? <span className="app-navigation-title">Свернуть</span> : null}
      </button>}
    </div>
  </div>;
  const studioClass = ["app-studio", expanded && "app-studio--navigation-expanded", boardActive && "app-studio--board"].filter(Boolean).join(" ");
  return <BoardLayoutContext value={setBoardActive}>
    <StudioLayout className={studioClass} navigation={navigation(expanded, false)} navigationLabel="Разделы кабинета" contentLabel="Рабочая область"
      // На компьютере шапки нет: разделы, тема и выход — в меню слева. На телефоне — тонкая полоса с кнопкой меню
      header={<div className="app-topbar">
        <Button variant="ghost" icon={ListIcon} aria-label="Открыть меню" onClick={() => setMenuOpen(true)} />
        <Link href="/" className="app-brand" aria-label="Живые лидмагниты"><Sphere size={24} /><span>Живые лидмагниты</span></Link>
      </div>}>
      <main id="app-content" className={boardActive ? "app-content app-content--board" : "app-content"}>{children}</main>
    </StudioLayout>
    <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Разделы кабинета">
      {navigation(true, true)}
      <Button variant="secondary" onClick={() => setMenuOpen(false)}>Закрыть меню</Button>
    </Sheet>
  </BoardLayoutContext>;
}
