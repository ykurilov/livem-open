import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "@phosphor-icons/react/dist/ssr";
import { cn } from "./class-names";

/**
 * Ссылка-кнопка со стрелкой: «назад» к списку и листание страниц.
 * Вид — маленькая кнопка с рамкой из дизайн-системы (канон: NAVIGATION.md, «Назад» внутри страницы).
 */
export function ArrowLink({ href, direction = "back", className, children }: { href: string; direction?: "back" | "forward"; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={cn("yk-button yk-button--outline yk-button--sm w-fit", className)}>
      {direction === "back" ? <ArrowLeftIcon aria-hidden /> : null}
      {children}
      {direction === "forward" ? <ArrowRightIcon aria-hidden /> : null}
    </Link>
  );
}
