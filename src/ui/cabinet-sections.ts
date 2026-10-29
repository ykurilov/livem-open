import type { Icon as CabinetIcon } from "@phosphor-icons/react";
import { RobotIcon as Bot, TrayIcon as Inbox, ListChecksIcon as ListChecks, MagnetIcon as Magnet, PaperPlaneTiltIcon as Send, GearIcon as Settings, ImageIcon as Picture, UsersIcon as Users, VideoCameraIcon as Video } from "@phosphor-icons/react/dist/ssr";

export interface CabinetSection {
  href: string;
  title: string;
  /** Значок в меню; в свёрнутом меню остаётся только он. */
  icon: CabinetIcon;
  /** Что открывается на этом экране — для заглушек, пока экран не сделан. */
  purpose: string;
}

/** Разделы кабинета в порядке бокового меню. */
export const CABINET_SECTIONS: CabinetSection[] = [
  { href: "/", title: "Лидмагниты", icon: Magnet, purpose: "Карточки лидмагнитов и кнопка «Создать»." },
  { href: "/bots", title: "Боты", icon: Bot, purpose: "Подключение ботов Telegram, ВКонтакте и Max." },
  { href: "/people", title: "База", icon: Users, purpose: "Люди, которые прошли через ваши лидмагниты." },
  { href: "/fields", title: "Поля базы", icon: ListChecks, purpose: "Что консультант запоминает о людях." },
  { href: "/videos", title: "Видео", icon: Video, purpose: "Архив роликов, которые консультант может присылать." },
  { href: "/images", title: "Картинки", icon: Picture, purpose: "Архив картинок и скриншотов, которые консультант может показывать." },
  { href: "/mailings", title: "Рассылки", icon: Send, purpose: "Сообщения людям из базы." },
  { href: "/inbox", title: "Входящие", icon: Inbox, purpose: "Сообщения, на которые консультант не отвечал." },
  { href: "/settings", title: "Настройки", icon: Settings, purpose: "Лимиты, бюджет, напоминания, политика конфиденциальности." },
];

export function isSectionActive(section: CabinetSection, pathname: string): boolean {
  if (section.href === "/") return pathname === "/" || pathname.startsWith("/lead-magnets");
  return pathname === section.href || pathname.startsWith(`${section.href}/`);
}
