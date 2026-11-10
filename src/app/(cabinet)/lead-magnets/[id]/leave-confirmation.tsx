"use client";

import { Dialog } from "@ykurilov/ds-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/ui/primitives";

/** Куда уводит щелчок по ссылке на этой странице; `null` — не уводит (новая вкладка, другой сайт, тот же адрес). */
function leavingHref(event: MouseEvent): string | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download")) return null;
  if (link.target && link.target !== "_self") return null;
  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === window.location.pathname && url.search === window.location.search) return null;
  return url.pathname + url.search + url.hash;
}

/**
 * Пока правка не сохранена (`unsavedEdit` — где она), уход со страницы спрашивает: ссылки кабинета и редактора —
 * окном «Уйти без сохранения?», обновление и закрытие вкладки — браузер.
 */
export function useLeaveConfirmation(unsavedEdit: string | null) {
  const router = useRouter();
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  useEffect(() => {
    if (!unsavedEdit) return;
    const askBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    // Раньше обработчиков ссылок: переход Next не начинается, если щелчок уже отменён
    const askBeforeLink = (event: MouseEvent) => {
      const href = leavingHref(event);
      if (!href) return;
      event.preventDefault();
      setLeaveTo(href);
    };
    window.addEventListener("beforeunload", askBeforeUnload);
    document.addEventListener("click", askBeforeLink, true);
    return () => {
      window.removeEventListener("beforeunload", askBeforeUnload);
      document.removeEventListener("click", askBeforeLink, true);
    };
  }, [unsavedEdit]);

  return (
    <Dialog open={leaveTo !== null && unsavedEdit !== null} onClose={() => setLeaveTo(null)} title="Уйти без сохранения?">
      <p className="app-muted mb-4">Правка {unsavedEdit} не сохранена и пропадёт.</p>
      <div className="app-dialog-actions">
        <Button type="button" variant="secondary" onClick={() => leaveTo && router.push(leaveTo)}>
          Уйти без сохранения
        </Button>
        <Button type="button" onClick={() => setLeaveTo(null)}>
          Остаться
        </Button>
      </div>
    </Dialog>
  );
}
