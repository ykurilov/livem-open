import type { ReactNode } from "react";

/** `tabs` — вкладки раздела под заголовком (SectionTabs). */
export function PageHeader({ title, description, action, tabs }: { title: string; description?: string; action?: ReactNode; tabs?: ReactNode }) {
  return (
    <header className="mb-[var(--yk-space-8)] flex flex-col gap-[var(--yk-space-4)]">
      <div className="flex flex-wrap items-start justify-between gap-[var(--yk-space-4)]">
        <div>
          <h1 className="app-page-title">{title}</h1>
          {description ? <p className="mt-1 text-[var(--yk-muted)]">{description}</p> : null}
        </div>
        {action}
      </div>
      {tabs}
    </header>
  );
}
