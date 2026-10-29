import type { ReactNode } from "react";

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <header className="mb-[var(--yk-space-8)] flex flex-wrap items-start justify-between gap-[var(--yk-space-4)]">
      <div>
        <h1 className="app-page-title">{title}</h1>
        {description ? <p className="mt-1 text-[var(--yk-muted)]">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}
