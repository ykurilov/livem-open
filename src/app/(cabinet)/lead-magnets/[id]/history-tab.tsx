"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Alert,
  Badge,
  Button,
} from "@/ui/primitives";
import { Dialog } from "@ykurilov/ds-react";
import type { VersionSource } from "@/modules/lead-magnets";
import { rollbackAction } from "../actions";

export interface VersionRow {
  id: string;
  source: VersionSource;
  createdAt: string;
  name: string;
}

const sourceLabel: Record<VersionRow["source"], string> = {
  constructor: "Конструктор",
  manual: "Вручную",
  rollback: "Откат",
  agent: "Агент",
};

const timeFormat = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Moscow" });

export interface HistoryTabProps {
  leadMagnetId: string;
  versions: VersionRow[];
  currentVersionId: string;
  /** Черновик правит конструктор — откат закрыт. */
  locked: boolean;
  /** Откат прошёл; `true` — черновик успел измениться, и откат лёг поверх. */
  onRolledBack(overwroteNewerDraft: boolean): void;
}

export function HistoryTab({ leadMagnetId, versions, currentVersionId, locked, onRolledBack }: HistoryTabProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Версия, откат к которой ждёт подтверждения. */
  const [confirming, setConfirming] = useState<VersionRow | null>(null);

  const rollback = (versionId: string) =>
    startTransition(async () => {
      const result = await rollbackAction(leadMagnetId, versionId, currentVersionId);
      setError(result.ok ? null : result.error);
      if (result.ok) onRolledBack(result.overwroteNewerDraft);
      setConfirming(null);
      router.refresh();
    });

  return (
    <>
    {locked ? (
      <Alert title="Конструктор правит черновик…" className="mb-3" />
    ) : null}
    {error ? <p role="alert" className="mb-3 text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">{error}</p> : null}
    <ol className="flex flex-col divide-y divide-[var(--yk-border)]" aria-label="Версии">
      {versions.map((version) => (
        <li key={version.id} className="flex items-center justify-between gap-3 py-2 text-[length:var(--yk-text-small-size)]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="tabular-nums text-[var(--yk-muted)]">{timeFormat.format(new Date(version.createdAt))}</span>
            <Badge variant="neutral">{sourceLabel[version.source]}</Badge>
            <span className="truncate">{version.name}</span>
          </div>
          {version.id === currentVersionId ? (
            <span className="text-[var(--yk-muted)]">Текущая</span>
          ) : (
            <Button variant="ghost" size="sm" disabled={pending || locked} onClick={() => setConfirming(version)}>
              Откатить
            </Button>
          )}
        </li>
      ))}
    </ol>
    <Dialog open={confirming !== null} onClose={() => setConfirming(null)} title={`Вернуть черновик к версии от ${confirming ? timeFormat.format(new Date(confirming.createdAt)) : ""}?`}>

          <p className="app-muted mb-4">Текущий черновик останется в Истории.</p>

        <div className="app-dialog-actions">

            <Button type="button" variant="secondary" onClick={() => setConfirming(null)}>
              Отмена
            </Button>

          <Button type="button" loading={pending} disabled={locked} onClick={() => confirming && rollback(confirming.id)}>
            Вернуть
          </Button>
        </div>

    </Dialog>
    </>
  );
}
