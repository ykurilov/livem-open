import type { Icon as CabinetIcon } from "@phosphor-icons/react";
import { TrayIcon as Inbox, MagnetIcon as Magnet, PaperPlaneTiltIcon as Send, GearIcon as Settings, BooksIcon as Knowledge, UsersIcon as Users } from "@phosphor-icons/react/dist/ssr";

export interface CabinetSection {
  href: string;
  title: string;
  /** Значок в меню; в свёрнутом меню остаётся только он. */
  icon: CabinetIcon;
  /** Что открывается на этом экране — для заглушек, пока экран не сделан. */
  purpose: string;
  /** Вкладки раздела: пункт меню подсвечен на любой из них и на вложенных страницах. Нет вкладок — только `href`. */
  tabs?: SectionTab[];
}

export interface SectionTab {
  href: string;
  label: string;
}

export const PEOPLE_TABS: SectionTab[] = [
  { href: "/people", label: "Список" },
  { href: "/fields", label: "Что запоминает агент" },
];

export const KNOWLEDGE_TABS: SectionTab[] = [
  { href: "/knowledge", label: "Тексты" },
  { href: "/videos", label: "Видео" },
  { href: "/images", label: "Картинки" },
];

export const SETTINGS_TABS: SectionTab[] = [
  { href: "/settings", label: "Общие" },
  { href: "/bots", label: "Боты" },
];

export const SETTINGS_SECTION: CabinetSection = {
  href: "/settings",
  title: "Настройки",
  icon: Settings,
  purpose: "Боты, лимиты, бюджет, напоминания, политика конфиденциальности.",
  tabs: SETTINGS_TABS,
};

/** Разделы кабинета в порядке бокового меню. Настройки сюда не входят: их открывает шестерёнка внизу панели и пункт меню аккаунта. */
export const CABINET_SECTIONS: CabinetSection[] = [
  { href: "/", title: "Лидмагниты", icon: Magnet, purpose: "Карточки лидмагнитов и кнопка «Создать»." },
  { href: "/inbox", title: "Входящие", icon: Inbox, purpose: "Сообщения, на которые консультант не отвечал." },
  { href: "/people", title: "Люди", icon: Users, purpose: "Люди, которые прошли через ваши лидмагниты, и что о них запоминает агент.", tabs: PEOPLE_TABS },
  { href: "/mailings", title: "Рассылки", icon: Send, purpose: "Сообщения людям." },
  {
    href: "/knowledge",
    title: "База знаний",
    icon: Knowledge,
    purpose: "Тексты, на которые консультант опирается в ответах, а также ролики и картинки, которые он может присылать.",
    tabs: KNOWLEDGE_TABS,
  },
];

export function isSectionActive(section: CabinetSection, pathname: string): boolean {
  if (section.href === "/") return pathname === "/" || pathname.startsWith("/lead-magnets");
  return (section.tabs?.map((tab) => tab.href) ?? [section.href]).some((href) => isUnder(href, pathname));
}

/** Адрес — эта страница или вложенная в неё: `/people/42` под `/people`, а `/people-extra` — нет. */
export function isUnder(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
