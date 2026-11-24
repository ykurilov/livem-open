"use client";

import { CheckIcon as Check, CopyIcon as Copy } from "@phosphor-icons/react/dist/ssr";
import { Radio, RadioGroup } from "@ykurilov/ds-react";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Alert, Button, Field, Textarea } from "@/ui/primitives";
import { ACTION_SEND_FAILED, keepingFormOnSendFailure } from "@/ui/form-upload";
import { submitKeepingFields } from "@/ui/submit-keeping-fields";
import { WIDGET_STYLE_EXAMPLE, widgetEmbedCode, type WidgetMode } from "@/widget/embed-code";
import { issueApiKeyAction, revokeApiKeyAction, saveAllowedSitesAction, type AllowedSitesState, type ApiKeyState } from "./actions";

/** Сколько держится «Скопировано», прежде чем кнопка снова зовёт копировать. */
const COPIED_MS = 2_000;

export interface ApiKeyView {
  keyStart: string;
  issuedOn: string;
}

/**
 * «Встроить на сайт»: код виджета с живым просмотром, пример CSS, сайты, где чат работает, и ключ API для сервера эксперта.
 * `origin` — адрес приложения, с которого сайт берёт скрипт виджета.
 */
export function SiteEmbed({ leadMagnetId, code, origin, sites, apiKey }: { leadMagnetId: string; code: string; origin: string; sites: string[]; apiKey: ApiKeyView | null }) {
  const [mode, setMode] = useState<WidgetMode>("button");
  const embedCode = widgetEmbedCode({ origin, code, mode, position: "right" });

  return (
    <div className="flex flex-col gap-[var(--yk-space-6)]">
      <section className="flex flex-col gap-[var(--yk-space-3)]" aria-label="Код виджета">
        <RadioGroup label="Как показать чат на сайте" value={mode} onValueChange={(value) => setMode(value as WidgetMode)}>
          <Radio value="button">
            Кнопка в углу <span className="app-muted">— по нажатию открывается окно чата</span>
          </Radio>
          <Radio value="inline">
            Блок на странице <span className="app-muted">— чат стоит там, где вставлен код</span>
          </Radio>
        </RadioGroup>
        <CopyableCode text={embedCode} label="Код для сайта" testId="widget-embed-code" />
        <WidgetPreview code={code} mode={mode} />
      </section>

      <section className="flex flex-col gap-[var(--yk-space-3)]" aria-label="Оформление виджета">
        <h3 className="font-semibold">Оформление</h3>
        <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          Виджет берёт цвета и шрифт только из этих переменных и частей: остальные стили сайта его не трогают. Впишите в CSS сайта то, что хотите
          поменять.
        </p>
        <CopyableCode text={WIDGET_STYLE_EXAMPLE} label="Пример CSS" testId="widget-style-example" />
      </section>

      <AllowedSites leadMagnetId={leadMagnetId} sites={sites} />
      <ApiKey leadMagnetId={leadMagnetId} apiKey={apiKey} />

      <p className="text-[length:var(--yk-text-small-size)]">
        Свой чат на сайте полностью по-своему —{" "}
        <Link href="/docs/api" className="text-[var(--yk-accent)] underline underline-offset-2 hover:no-underline" target="_blank">
          документация API для программиста
        </Link>
        .
      </p>
    </div>
  );
}

/**
 * Живой просмотр — по просьбе, а не при открытии страницы: виджет начинает настоящий разговор веб-чата. Скрипт — с этого
 * же адреса приложения: свой адрес разрешён всегда. Окно с кнопкой держится внутри рамки: у неё свой слой.
 */
function WidgetPreview({ code, mode }: { code: string; mode: WidgetMode }) {
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = frame.current;
    if (!shown || !target) return;
    let removed = false;
    void loadWidgetScript().then(
      () => {
        if (removed) return;
        const widget = document.createElement("livem-chat");
        widget.setAttribute("code", code);
        widget.setAttribute("mode", mode);
        target.replaceChildren(widget);
      },
      () => setFailed(true),
    );
    return () => {
      removed = true;
      target.replaceChildren();
    };
  }, [shown, code, mode]);

  if (!shown)
    return (
      <div className="flex flex-col gap-1">
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setShown(true)}>
            Показать просмотр
          </Button>
        </div>
        <p className="yk-field__hint">Просмотр начинает настоящий разговор с агентом — он появится в отчёте и во «Входящих».</p>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      {failed ? (
        <Alert variant="danger" title="Просмотр не загрузился">
          Обновите страницу и попробуйте ещё раз.
        </Alert>
      ) : null}
      <div
        ref={frame}
        data-testid="widget-preview"
        aria-label="Просмотр виджета"
        role="region"
        className="relative overflow-hidden rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] bg-[var(--yk-bg)] p-4"
        // Свой слой: окно и кнопка с `position: fixed` остаются в рамке, а не в углу кабинета
        style={{ transform: "translateZ(0)", height: mode === "button" ? 720 : 640 }}
      />
    </div>
  );
}

let widgetScript: Promise<void> | null = null;

function loadWidgetScript(): Promise<void> {
  if (customElements.get("livem-chat")) return Promise.resolve();
  widgetScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/widget.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      widgetScript = null;
      script.remove();
      reject(new Error("widget.js не загрузился"));
    };
    document.head.append(script);
  });
  return widgetScript;
}

function AllowedSites({ leadMagnetId, sites }: { leadMagnetId: string; sites: string[] }) {
  const [state, formAction, pending] = useActionState<AllowedSitesState, FormData>(keepingFormOnSendFailure(saveAllowedSitesAction.bind(null, leadMagnetId)), {});
  return (
    <section className="flex flex-col gap-[var(--yk-space-3)]" aria-label="Сайты, где работает чат">
      <h3 className="font-semibold">Где работает чат</h3>
      <form onSubmit={submitKeepingFields(formAction)} className="flex max-w-xl flex-col gap-2">
        <Field label="Сайты" hint="По одному на строке: example.ru, а для всех поддоменов — *.example.ru. Пусто — чат работает на любом сайте.">
          <Textarea name="sites" rows={4} defaultValue={sites.join("\n")} placeholder="example.ru" spellCheck={false} />
        </Field>
        <Alert variant="warm" title="Новый сайт — впишите сюда">
          Если список не пустой, на сайте не из списка виджета и своего чата не будет: разговор не начнётся.
        </Alert>
        <div className="flex items-center gap-3">
          <Button type="submit" loading={pending}>
            Сохранить сайты
          </Button>
          {state.saved && !pending ? <span role="status">Сохранено</span> : null}
        </div>
      </form>
      {state.error ? (
        <Alert variant="danger" title="Сайты не сохранены">
          {state.error}
        </Alert>
      ) : null}
    </section>
  );
}

/** Ключ для сервера эксперта. Новый ключ показывается один раз: в базе только его хэш. */
function ApiKey({ leadMagnetId, apiKey }: { leadMagnetId: string; apiKey: ApiKeyView | null }) {
  const [state, setState] = useState<ApiKeyState>({});
  const [confirmingReissue, setConfirmingReissue] = useState(false);
  const [pending, startTransition] = useTransition();
  const run = (action: (id: string) => Promise<ApiKeyState>) =>
    startTransition(async () => {
      setConfirmingReissue(false);
      setState(await action(leadMagnetId).catch(() => ({ error: ACTION_SEND_FAILED })));
    });

  return (
    <section className="flex flex-col gap-[var(--yk-space-3)]" aria-label="Ключ API">
      <h3 className="font-semibold">Ключ API для сервера</h3>
      <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
        Нужен, если ваш сервер сам говорит с агентом от имени посетителей. Ключ храните только на сервере: в коде страниц сайта его быть не должно.
      </p>
      {state.key ? (
        <Alert variant="success" title="Новый ключ выпущен">
          <span className="flex flex-col gap-2">
            Скопируйте его сейчас: больше он не покажется.
            <CopyableCode text={state.key} label="Ключ API" testId="api-key-new" />
          </span>
        </Alert>
      ) : apiKey ? (
        <p className="text-[length:var(--yk-text-small-size)]" data-testid="api-key-current">
          Действует ключ <code>{apiKey.keyStart}…</code>, выпущен {apiKey.issuedOn}.
        </p>
      ) : (
        <p className="text-[length:var(--yk-text-small-size)]">Ключа нет.</p>
      )}
      {state.error ? (
        <Alert variant="danger" title="Не получилось">
          {state.error}
        </Alert>
      ) : null}
      {confirmingReissue ? (
        <Alert variant="warm" title="Выпустить новый ключ?">
          <span className="flex flex-col gap-2">
            Прежний ключ сразу перестанет работать: замените его на сервере.
            <span className="flex flex-wrap gap-2">
              <Button type="button" size="sm" loading={pending} onClick={() => run(issueApiKeyAction)}>
                Выпустить новый
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmingReissue(false)}>
                Отмена
              </Button>
            </span>
          </span>
        </Alert>
      ) : (
        <div className="flex flex-wrap gap-2">
          {apiKey || state.key ? (
            <>
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirmingReissue(true)}>
                Выпустить новый ключ
              </Button>
              <Button type="button" variant="outline" size="sm" loading={pending} onClick={() => run(revokeApiKeyAction)}>
                Отозвать ключ
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" loading={pending} onClick={() => run(issueApiKeyAction)}>
              Выпустить ключ
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function CopyableCode({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <pre className="max-w-full overflow-x-auto rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] p-3 text-[length:var(--yk-text-small-size)]">
        <code className="select-all" data-testid={testId}>
          {text}
        </code>
      </pre>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Скопировано" : "Скопировать"}
          <span className="sr-only"> · {label}</span>
        </Button>
      </div>
      {failed ? <span role="status">Не удалось скопировать. Выделите текст и скопируйте вручную.</span> : null}
    </div>
  );
}
