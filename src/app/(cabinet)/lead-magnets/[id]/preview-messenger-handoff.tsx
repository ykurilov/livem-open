"use client";

import { cn } from "@/ui/primitives";
import { MessengerLogo } from "@/ui/messenger-logos";
import type { PreviewMessengerHandoff } from "@/modules/consultant";
import type { HandoffMessenger } from "@/modules/messenger-handoff/setting";

/**
 * Кнопки мессенджеров в «Проверке»: консультант показал их человеку в веб-чате, и там поле ввода закрыто. Нажатие
 * изображает «Старт» в боте — консультант продолжает разговор первым, дальше всё как в мессенджере.
 */
export function PreviewMessengerHandoffPanel({
  handoff,
  onTake,
  taking,
}: {
  handoff: PreviewMessengerHandoff;
  onTake(channel: HandoffMessenger): void;
  taking: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Переход в мессенджер"
      data-testid="preview-messenger-handoff"
      className="flex flex-col gap-2 rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] bg-[var(--yk-surface)] px-3 py-2"
    >
      {handoff.state === "offered" ? (
        <>
          <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
            Консультант показал кнопки мессенджеров. В веб-чате человек сейчас может только нажать одну. Нажмите — проверите,
            как разговор продолжится в мессенджере.
          </p>
          <div className="flex flex-wrap gap-2">
            {handoff.buttons.map((button) => (
              <button
                key={button.channel}
                type="button"
                aria-label={`Открыть ${button.title}`}
                disabled={taking}
                onClick={() => onTake(button.channel)}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] bg-[var(--yk-surface)] py-1.5 pr-4 pl-2",
                  "font-semibold text-[var(--yk-text)] transition-colors hover:border-[var(--yk-border-strong)] hover:bg-[var(--yk-surface-2)]",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--yk-accent)] disabled:opacity-60",
                )}
              >
                <MessengerLogo channel={button.channel} size={28} />
                {button.title}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <MessengerLogo channel={handoff.channel} size={24} />
          <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
            Разговор перешёл в {handoff.title}: дальше всё как в мессенджере.
          </p>
        </div>
      )}
    </div>
  );
}
