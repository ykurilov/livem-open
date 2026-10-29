"use client";

import { PencilSimpleIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { IconButton } from "@/ui/icon-button";
import { Button, Textarea } from "@/ui/primitives";
import { saveCardDescriptionAction } from "./lead-magnets/actions";

/** Описание в карточке лидмагнита на главной: видно здесь — здесь и правится. */
export function CardDescriptionEditor({ leadMagnetId, name, description }: { leadMagnetId: string; name: string; description: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(description);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  if (!editing)
    return (
      <div className="relative z-10 flex items-center gap-1">
        <p className={description ? "app-muted min-w-0 flex-1" : "app-muted min-w-0 flex-1 italic"}>{description || "Без описания"}</p>
        <IconButton label={`Изменить описание «${name}»`} icon={PencilSimpleIcon} size="sm" onClick={() => { setText(description); setEditing(true); }} />
      </div>
    );

  const save = () =>
    startSaving(async () => {
      const result = await saveCardDescriptionAction(leadMagnetId, text);
      if (!result.ok) return setError(result.error);
      setError(null);
      setEditing(false);
      router.refresh();
    });

  return (
    <form className="relative z-10 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <Textarea rows={3} autoFocus aria-label={`Описание «${name}»`} value={text} onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={saving}>Сохранить</Button>
        <Button variant="secondary" size="sm" disabled={saving} onClick={() => setEditing(false)}>Отмена</Button>
        {error ? <span role="alert" className="text-[length:var(--yk-text-small-size)] text-[var(--yk-danger)]">{error}</span> : null}
      </div>
    </form>
  );
}
