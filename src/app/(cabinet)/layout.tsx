import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AccessError, requireUser } from "@/modules/access";
import { countUnansweredThreads } from "@/modules/inbox";
import { getDatabase } from "@/modules/platform/db";
import { CabinetShell } from "./cabinet-shell";
import { NAVIGATION_EXPANDED_COOKIE } from "./navigation-cookie";

export const dynamic = "force-dynamic";

export default async function CabinetLayout({ children }: { children: ReactNode }) {
  // Прокси уже проверил вход; здесь вторая проверка, чтобы страница не открылась при любой ошибке в прокси
  const user = await requireUser().catch((error: unknown) => {
    if (error instanceof AccessError) redirect(error.status === 401 ? "/api/auth/silent" : "/login?error=access_denied");
    throw error;
  });

  return (
    <CabinetShell
      user={{ name: user.name, email: user.email }}
      unanswered={await countUnansweredThreads(getDatabase().db)}
      navigationExpanded={(await cookies()).get(NAVIGATION_EXPANDED_COOKIE)?.value === "1"}
    >
      {children}
    </CabinetShell>
  );
}
