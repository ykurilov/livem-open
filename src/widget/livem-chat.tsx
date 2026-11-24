import { ChatCircleDotsIcon, XIcon } from "@phosphor-icons/react";
import { createVoiceInput } from "@ykurilov/agent-chat-voice";
import { Button } from "@ykurilov/ds-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { webChatVoiceChatId } from "@/modules/voice/access";
import { chatApiTransport, type ChatAbout, type ChatApiTransport } from "@/ui/web-chat/transport";
import { useWebChat } from "@/ui/web-chat/use-web-chat";
import { WebChatView } from "@/ui/web-chat/web-chat-view";
import type { WidgetMode, WidgetPosition } from "./embed-code";

const DRAFT_KEY = "livem-chat-draft:";

/**
 * Виджет лидмагнита на сайте: кнопка в углу с окном чата или блок в секции. Ходит в публичный API приложения (`origin`).
 * Разговор начинается не при загрузке сайта, а когда человек его открыл: у кнопки — первый клик, у блока — первый показ
 * на экране. Иначе каждый заход на сайт тратил бы модель.
 */
export function LivemChat({ origin, code, mode, position }: { origin: string; code: string; mode: WidgetMode; position: WidgetPosition }) {
  const transport = useMemo(() => chatApiTransport({ origin, code, onRefused: (error) => console.warn(`Виджет лидмагнита: ${error}`) }), [origin, code]);
  const [about, setAbout] = useState<ChatAbout | null>(null);
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const inlineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stopped = false;
    void transport.about().then((result) => !stopped && setAbout(result));
    return () => {
      stopped = true;
    };
  }, [transport]);

  // Блок начинает разговор, когда впервые показался на экране
  useEffect(() => {
    const block = inlineRef.current;
    if (mode !== "inline" || !block || started) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setStarted(true);
    });
    observer.observe(block);
    return () => observer.disconnect();
  }, [mode, started, about]);

  // Сайт не из списка разрешённых или ссылка устарела: виджета нет, причина — в консоли сайта
  if (!about || (!about.ok && about.refused)) return null;
  const title = about.ok ? about.title : "Чат";
  const session = started && (
    <ChatSession
      origin={origin}
      code={code}
      transport={transport}
      about={about}
      title={title}
      headingLevel={2}
      onClose={mode === "button" ? () => setOpen(false) : undefined}
    />
  );

  if (mode === "inline")
    return (
      <div className="livem-root livem-inline" ref={inlineRef} part="window">
        {session}
      </div>
    );

  const toggle = () => {
    setStarted(true);
    setOpen((current) => !current);
  };
  return (
    <div className={`livem-root${position === "left" ? " livem-root--left" : ""}${open ? " livem-root--open" : ""}`}>
      {/* Окно не пропадает при закрытии: разговор и набранное остаются, опрос идёт дальше */}
      <div className="livem-window" part="window" role="dialog" aria-label={title} hidden={!open}>
        {session}
      </div>
      <button type="button" className="livem-launcher" part="button" aria-label={open ? "Закрыть чат" : `Открыть чат «${title}»`} aria-expanded={open} onClick={toggle}>
        {open ? <XIcon size={24} weight="bold" aria-hidden /> : <ChatCircleDotsIcon size={28} weight="fill" aria-hidden />}
      </button>
    </div>
  );
}

function ChatSession({
  origin,
  code,
  transport,
  about,
  title,
  headingLevel,
  onClose,
}: {
  origin: string;
  code: string;
  transport: ChatApiTransport;
  about: ChatAbout;
  title: string;
  headingLevel: 1 | 2 | 3;
  onClose?: () => void;
}) {
  const chat = useWebChat({ transport });
  const ticket = chat.entry?.voiceTicket ?? null;
  // Голос — через ретранслятор приложения: WebSocket заголовков не шлёт, посетителя узнаёт билет из входа
  const voice = useMemo(() => {
    if (!ticket || !about.ok || !about.voice) return null;
    const relayUrl = `${origin.replace(/^http/, "ws")}/api/voice/stream?${new URLSearchParams({ ticket })}`;
    return { input: createVoiceInput({ api: `${origin}/api/voice`, mode: "relay", relayUrl }), chatId: webChatVoiceChatId(code) };
  }, [ticket, about, origin, code]);

  return (
    <WebChatView
      chat={chat}
      title={title}
      draftKey={`${DRAFT_KEY}${code}`}
      voice={voice}
      photos={about.ok && about.photos}
      headingLevel={headingLevel}
      headerAside={onClose ? <Button type="button" size="sm" variant="ghost" icon={XIcon} aria-label="Закрыть чат" onClick={onClose} /> : undefined}
    />
  );
}
