"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/ui/primitives";
import { Dialog } from "@ykurilov/ds-react";
import { chatsText, versionText } from "@/modules/agent-log/flow-text";
import { Select } from "@/ui";
import { migrateChatsAction } from "./actions";

export interface MigrationGroupView {
  versionId: string;
  versionAt: string;
  stateId: string;
  stateTitle: string;
  chats: number;
  inNewVersion: boolean;
  suggestedTo: string;
}

export interface ChatMigrationView {
  total: number;
  pending: number;
  groups: MigrationGroupView[];
  targets: Array<{ id: string; title: string }>;
}

/** Ноды прежних версий, которых нет в новой: по одной строке выбора на ноду, сколько бы версий её ни было. */
function removedStates(groups: MigrationGroupView[]) {
  const removed = new Map<string, { stateId: string; stateTitle: string; chats: number; suggestedTo: string }>();
  for (const group of groups) {
    if (group.inNewVersion) continue;
    const known = removed.get(group.stateId);
    if (known) known.chats += group.chats;
    else removed.set(group.stateId, { stateId: group.stateId, stateTitle: group.stateTitle, chats: group.chats, suggestedTo: group.suggestedTo });
  }
  return [...removed.values()];
}

/** «Разговоры на прежних версиях»: сколько и где, куда отправить людей из удалённых нод, перевод с подтверждением. Переводить некого — ничего. */
export function ChatMigrationCard({ leadMagnetId, view }: { leadMagnetId: string; view: ChatMigrationView }) {
  const removed = removedStates(view.groups);
  const [map, setMap] = useState<Record<string, string>>(() => Object.fromEntries(removed.map((state) => [state.stateId, state.suggestedTo])));
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ moved?: number; error?: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const severalVersions = new Set(view.groups.map((group) => group.versionId)).size > 1;
  const targets = view.targets.map((target) => ({ value: target.id, label: target.title }));
  // Нечего переводить и ничего не переводили — карточки нет; после перевода остаётся его итог
  if (view.total === 0 && view.pending === 0 && !result) return null;

  const migrate = () =>
    startTransition(async () => {
      const chosen = Object.fromEntries(removed.map((state) => [state.stateId, map[state.stateId] ?? state.suggestedTo]));
      setResult(await migrateChatsAction(leadMagnetId, chosen));
      setConfirming(false);
    });

  return (
    <Card data-testid="chat-migration">
      <CardHeader>
        <CardTitle>Разговоры на прежних версиях</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-[var(--yk-space-4)]">
        {view.total > 0 ? (
          <>
            <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
              Эти люди начали раньше и идут по старым правилам. Новые разговоры уже идут по новой версии.
            </span>
            <ul className="flex flex-col gap-1 text-[length:var(--yk-text-small-size)]" aria-label="Разговоры по нодам">
              {view.groups.map((group) => (
                <li key={`${group.versionId}:${group.stateId}`}>
                  {severalVersions ? `${versionText(group.versionAt)}: ` : ""}«{group.stateTitle}» — {chatsText(group.chats)}
                  {group.inNewVersion ? null : <span className="text-[var(--yk-muted)]"> · этой ноды в новой версии нет</span>}
                </li>
              ))}
            </ul>
            {removed.length > 0 ? (
              <div className="flex max-w-xl flex-col gap-2">
                <span className="text-[length:var(--yk-text-small-size)] font-semibold">Куда отправить людей из нод, которых больше нет</span>
                {removed.map((state) => (
                  <label key={state.stateId} className="flex flex-col gap-1 text-[length:var(--yk-text-small-size)]">
                    <span>
                      Нода «{state.stateTitle}» · {chatsText(state.chats)}
                    </span>
                    <Select
                      aria-label={`Куда отправить людей из «${state.stateTitle}»`}
                      options={targets}
                      value={map[state.stateId] ?? state.suggestedTo}
                      onValueChange={(value) => setMap((current) => ({ ...current, [state.stateId]: value }))}
                    />
                  </label>
                ))}
              </div>
            ) : null}
            <div>
              <Button type="button" onClick={() => setConfirming(true)}>
                Перевести на новую версию
              </Button>
            </div>
          </>
        ) : null}
        {view.pending > 0 ? (
          <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]" data-testid="chat-migration-pending">
            Ещё переводятся: {chatsText(view.pending)}. Обновите страницу через минуту.
          </span>
        ) : null}
        {result?.error ? (
          <Alert variant="danger" title="Не получилось перевести">
            {result.error}
          </Alert>
        ) : null}
        {result?.moved !== undefined && !result.error ? (
          <Alert variant="success" title="Переведено">
            {result.moved > 0
              ? `${chatsText(result.moved)} продолжат по новой версии со следующего сообщения.`
              : "Переводить уже некого: все разговоры на новой версии или закончились."}
          </Alert>
        ) : null}
      </CardContent>
      <Dialog open={confirming} onClose={() => setConfirming(false)} title={`Перевести ${chatsText(view.total)}?`}>

            <p className="app-muted mb-4">
              Люди продолжат с той же ноды по новым правилам.
              {removed.length > 0 ? " Из нод, которых больше нет, — туда, куда вы выбрали." : ""}
            </p>

          <div className="app-dialog-actions">

              <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
                Отмена
              </Button>

            <Button type="button" loading={pending} onClick={migrate}>
              Перевести
            </Button>
          </div>

      </Dialog>
    </Card>
  );
}
