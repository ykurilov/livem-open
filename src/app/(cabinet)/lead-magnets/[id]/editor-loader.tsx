"use client";

import dynamic from "next/dynamic";

// Код редактора с чатами тяжёлый: при переходе страница открывается сразу, а редактор догружается следом
export const EditorLoader = dynamic(() => import("./editor").then((module) => module.Editor), {
  loading: () => (
    <div role="status" className="flex flex-1 items-center justify-center text-[var(--yk-text-secondary)]">
      Загружаю редактор…
    </div>
  ),
});
