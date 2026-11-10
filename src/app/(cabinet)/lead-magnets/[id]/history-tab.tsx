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
  /** Почему откат сейчас закрыт (несохранённая правка в «Настройках» или на доске); `null` — открыт. */
  blockedBecause: string | null;
  /** Откат прошёл; `true` — черновик успел измениться, и откат лёг поверх. */
  onRolledBack(overwroteNewerDraft: boolean): void;
}

export function HistoryTab({ leadMagnetId, versions, currentVersionId, locked, blockedBecause, onRolledBack }: HistoryTabProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Версия, откат к которой ждёт подтверждения. */
  const [confirming, setConfirming] = useState<VersionRow | null>(null);

  const rollback = (versionId: string) =>
    startTransition(async () => {
      try {
        const result = await rollbackAction(leadMagnetId, versionId, currentVersionId);
        setError(result.ok ? null : result.error);
        if (result.ok) onRolledBack(result.overwroteNewerDraft);
      } catch {
        setError("Не получилось откатить: нет связи с сервером. Попробуйте ещё раз.");
      }
      setConfirming(null);
      router.refresh();
    });

  return (
    <>
    {locked ? (
      <Alert title="Конструктор правит черновик…" className="mb-3" />
    ) : null}
    {blockedBecause ? <p role="status" className="mb-3 text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{blockedBecause}</p> : null}
    {error ? <p role="alert" className="mb-3 text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">{error}</p> : null}
    <p className="mb-2 text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
      Каждое сохранение — отдельная версия. Вернуть можно любую: нынешний черновик тоже останется здесь, и к нему можно вернуться так же.
    </p>
    <ol className="flex flex-col divide-y divide-[var(--yk-border)]" aria-label="Версии">
      {versions.map((version) => (
        <li key={version.id} className="flex items-center justify-between gap-3 py-2 text-[length:var(--yk-text-small-size)]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="tabular-nums text-[var(--yk-muted)]">{timeFormat.format(new Date(version.createdAt))}</span>
            <Badge variant="neutral">{sourceLabel[version.source]}</Badge>
            <span className="truncate">{version.name}</span>
          </div>
          {version.id === currentVersionId ? (
            <span className="text-[var(--yk-muted)]">Сейчас в черновике</span>
          ) : (
            <Button variant="ghost" size="sm" disabled={pending || locked || blockedBecause !== null} onClick={() => setConfirming(version)}>
              Вернуть эту
            </Button>
          )}
        </li>
      ))}
    </ol>
    <Dialog open={confirming !== null} onClose={() => setConfirming(null)} title={`Вернуть черновик к версии от ${confirming ? timeFormat.format(new Date(confirming.createdAt)) : ""}?`}>

          <p className="app-muted mb-4">Нынешний черновик останется в Истории — передумаете, вернёте его тем же способом.</p>

        <div className="app-dialog-actions">

            <Button type="button" variant="secondary" onClick={() => setConfirming(null)}>
              Отмена
            </Button>

          <Button type="button" loading={pending} disabled={locked || blockedBecause !== null} onClick={() => confirming && rollback(confirming.id)}>
            Вернуть
          </Button>
        </div>

    </Dialog>
    </>
  );
}
