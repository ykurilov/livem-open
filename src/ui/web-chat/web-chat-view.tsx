"use client";

import { ArrowUpIcon, ImageIcon, MicrophoneIcon, SquareIcon, XIcon, type Icon as PhosphorIcon, type IconProps } from "@phosphor-icons/react";
import { russianLabels, useVoiceDictation, type VoiceInputView } from "@ykurilov/agent-chat-react";
import type { VoiceInput } from "@ykurilov/agent-chat-voice";
import { Banner, Button, ChatHeader, Textarea } from "@ykurilov/ds-react";
import { forwardRef, Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { WebChatHandoffState, WebChatItem } from "@/modules/web-chat/web-chat";
import { MessengerLogo } from "@/ui/messenger-logos";
import { useRememberedDraft } from "@/ui/remembered-draft";
import type { WebChatState } from "./use-web-chat";

const MESSAGE_MAX_LENGTH = 2000;
/** Как на сервере: больше — отказ ещё до отправки. */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = "image/png,image/jpeg,image/gif,image/webp";

/**
 * Общий вид веб-чата: шапка, лента, кнопки-подсказки, медиа, переход в мессенджер, поле с голосом и фото. Один и тот же на
 * странице `/c/<код>` и в виджете на сайте. Части помечены `part`: в виджете сайт меняет их своим CSS через `::part(...)`.
 *
 * `voice` — микрофон в поле; `photos` — лидмагнит принимает фото клиента. `currentChatHref` — куда вести в идущий
 * разговор другого лидмагнита (у виджета такой ссылки нет). `feedFooter` — своё под лентой (у страницы — уведомления).
 */
export function WebChatView({
  chat,
  title,
  draftKey,
  voice = null,
  photos = false,
  headerAside,
  headingLevel = 1,
  feedFooter,
  currentChatHref,
  rootRef,
  children,
}: {
  chat: WebChatState;
  title: string;
  draftKey: string;
  voice?: { input: VoiceInput; chatId: string } | null;
  photos?: boolean;
  headerAside?: ReactNode;
  headingLevel?: 1 | 2 | 3;
  feedFooter?: ReactNode;
  currentChatHref?: (code: string) => string;
  rootRef?: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
}) {
  const { status, items, handoff: messenger, sending } = chat;
  const feedRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [scrolled, setScrolled] = useState(false);
  // Набранное переживает перезагрузку страницы: черновик лежит в браузере, пока сообщение не уйдёт
  const [draft, setDraft] = useRememberedDraft(draftKey);
  // Сказанное дописывается к набранному; после «стоп» сервер чистит его моделью, заменяется только надиктованный кусок
  const dictation = useVoiceDictation({ voice: voice?.input, value: draft, setValue: setDraft, chatId: voice?.chatId ?? "" });
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const ready = status.kind === "ready";

  // Новые сообщения — вниз, если человек не листает историю выше
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (feed && stickToBottom.current) feed.scrollTop = feed.scrollHeight;
  }, [items, feedFooter, status]);

  const onScroll = () => {
    const feed = feedRef.current;
    if (!feed) return;
    stickToBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    setScrolled(feed.scrollTop > 0);
  };

  /** `chosen` — готовый ответ с кнопки: уходит как обычное сообщение, черновик и фото в поле не трогаются. */
  async function send(event?: FormEvent, chosen?: string) {
    event?.preventDefault();
    const text = (chosen ?? draft).trim();
    const attached = chosen === undefined ? (photo ?? undefined) : undefined;
    if ((!text && !attached) || sending) return;
    dictation.cancel();
    if (!(await chat.send({ text, photo: attached }))) return;
    if (chosen !== undefined) return;
    // Пока сообщение уходило, человек мог дописать следующее — его не стираем
    setDraft((current) => (current.trim() === text ? "" : current));
    setPhoto((current) => (current === attached ? null : current));
    stickToBottom.current = true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !isTouch()) {
      event.preventDefault();
      void send();
    }
  }

  function choosePhoto(file: File | null) {
    setPhotoError(null);
    if (!file) return;
    if (!PHOTO_TYPES.split(",").includes(file.type)) return setPhotoError("Подойдёт фото PNG, JPG, GIF или WebP");
    if (file.size > PHOTO_MAX_BYTES) return setPhotoError("Фото больше 10 МБ: пришлите поменьше");
    setPhoto(file);
  }

  const last = items.at(-1);
  const canSend = ready && (Boolean(draft.trim()) || photo !== null);
  const away = status.kind === "closed" || status.kind === "elsewhere";

  return (
    <div ref={rootRef} className="web-chat" part="chat">
      {children}
      <ChatHeader title={title} scrolled={scrolled} headingLevel={headingLevel} aside={headerAside} part="header" />
      <div ref={feedRef} className="web-chat__feed" onScroll={onScroll} role="log" aria-label="Переписка" part="feed">
        <div className="web-chat__column">
          {status.kind === "loading" && items.length === 0 && <p className="web-chat__note">Открываем чат…</p>}
          {status.kind === "failed" && (
            <>
              <Banner tone="danger">{status.error}</Banner>
              {status.retryable && (
                <div className="web-chat__offer-actions">
                  <Button type="button" size="sm" onClick={chat.reopen}>
                    Попробовать снова
                  </Button>
                </div>
              )}
            </>
          )}
          {ready && !last && !chat.waitingForGreeting && <p className="web-chat__note">Приветствие задерживается. Можно написать первым — вам ответят здесь.</p>}
          {away && (
            <div className="web-chat__offer" role="group" aria-label={status.kind === "closed" ? "Чат закончен" : "Идёт другой разговор"}>
              <p>
                {status.kind === "closed"
                  ? `Этот чат закончен. Сейчас у вас идёт разговор «${status.current.title}»${currentChatHref ? " — продолжить можно там" : ""}.`
                  : `Сейчас у вас идёт разговор «${status.current.title}». ${currentChatHref ? "Продолжите его или вернитесь" : "Можно вернуться"} в этот чат — он начнётся заново.`}
              </p>
              <div className="web-chat__offer-actions">
                {currentChatHref && (
                  <Button href={currentChatHref(status.current.code)} size="sm">
                    Перейти в текущий чат
                  </Button>
                )}
                {status.kind === "elsewhere" && (
                  <Button type="button" size="sm" variant={currentChatHref ? "secondary" : "primary"} onClick={chat.reopen}>
                    Вернуться в этот чат
                  </Button>
                )}
              </div>
            </div>
          )}
          {/* Лента общая: под названием этого чата, когда идёт другой, она читалась бы как чужая */}
          {status.kind !== "elsewhere" && items.map((item) => <ChatBubble key={item.id} item={item} />)}
          {/* Готовые ответы — только под последним сообщением консультанта: ответил человек — их нет */}
          {ready && !messenger && last?.from === "bot" && last.quickReplies && (
            <div className="web-chat__quick-replies" role="group" aria-label="Быстрые ответы" part="quick-replies">
              {last.quickReplies.map((reply) => (
                <Button key={reply} type="button" size="sm" variant="secondary" className="web-chat__quick-reply" part="quick-reply" disabled={sending} onClick={() => void send(undefined, reply)}>
                  {reply}
                </Button>
              ))}
            </div>
          )}
          {chat.waitingForReply && status.kind !== "elsewhere" && (
            <div className="web-chat__typing" aria-label="Печатает">
              <span />
              <span />
              <span />
            </div>
          )}
          {chat.pollProblem && ready && <Banner tone="danger">{chat.pollProblem}</Banner>}
          {feedFooter}
        </div>
      </div>
      {messenger && <MessengerHandoff handoff={messenger} />}
      {!away && !messenger && (
        <form className="web-chat__composer" onSubmit={send} part="composer">
          <div className="web-chat__column">
            {chat.sendError && <p className="web-chat__error" role="alert">{chat.sendError}</p>}
            {photoError && <p className="web-chat__error" role="alert">{photoError}</p>}
            {dictation.view?.error && <p className="web-chat__error" role="alert">{dictation.view.error}</p>}
            {photo && <AttachedPhoto photo={photo} onRemove={() => setPhoto(null)} />}
            <div className={`web-chat__field${!ready ? " web-chat__field--disabled" : ""}`} part="field">
              <div className="web-chat__input">
                <Textarea
                  autoGrow
                  aria-label="Сообщение"
                  placeholder="Напишите сообщение"
                  rows={1}
                  maxLength={MESSAGE_MAX_LENGTH}
                  value={draft}
                  disabled={!ready}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onKeyDown}
                />
              </div>
              <div className="web-chat__field-actions">
                {photos && <PhotoButton disabled={!ready || sending} onChosen={choosePhoto} />}
                {dictation.view && <VoiceButton view={dictation.view} disabled={!ready} />}
                <Button
                  type="submit"
                  size="lg"
                  icon={ArrowUpIcon}
                  aria-label="Отправить"
                  className="web-chat__send"
                  part="send"
                  // Пока сообщение уходит, кнопка занята: повторное нажатие не проходит
                  loading={sending && (Boolean(draft.trim()) || photo !== null)}
                  disabled={!canSend}
                  // Фокус остаётся в поле: на iPhone клавиатура не закрывается после каждого сообщения
                  onPointerDown={keepInputFocus}
                  onMouseDown={keepInputFocus}
                />
              </div>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

/** Кнопка фото: системный выбор файла (на телефоне — и камера). */
function PhotoButton({ disabled, onChosen }: { disabled: boolean; onChosen: (file: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={PHOTO_TYPES}
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          onChosen(event.target.files?.[0] ?? null);
          // Тот же файл можно выбрать снова, если его убрали
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        size="lg"
        variant="ghost"
        icon={ImageIcon}
        aria-label="Прикрепить фото"
        className="web-chat__photo"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onPointerDown={keepInputFocus}
        onMouseDown={keepInputFocus}
      />
    </>
  );
}

/** Выбранное фото над полем: уйдёт вместе с текстом, можно убрать. */
function AttachedPhoto({ photo, onRemove }: { photo: File; onRemove: () => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  return (
    <div className="web-chat__attachment">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview && <img src={preview} alt="Выбранное фото" />}
      <span className="web-chat__attachment-name">{photo.name}</span>
      <Button type="button" size="sm" variant="ghost" icon={XIcon} aria-label="Убрать фото" onClick={onRemove} />
    </div>
  );
}

/**
 * Вместо поля ввода: кнопки мессенджеров; после перехода — где продолжается разговор и кнопка туда же; человек уже в
 * мессенджере, где есть и этот лидмагнит, — кнопка туда.
 */
function MessengerHandoff({ handoff }: { handoff: WebChatHandoffState }) {
  return (
    <div className="web-chat__composer" part="composer">
      <div className="web-chat__column">
        <div className="web-chat__offer web-chat__handoff" role="group" aria-label="Продолжение в мессенджере">
          {handoff.state === "offered" ? (
            <>
              <p>Продолжим в мессенджере — выберите удобный. Разговор пойдёт с того же места.</p>
              <div className="web-chat__messengers">
                {handoff.buttons.map((button) => (
                  <a key={button.channel} className="web-chat__messenger" href={button.url} target="_blank" rel="noreferrer" aria-label={`Открыть ${button.title}`} part="messenger">
                    <MessengerLogo channel={button.channel} size={40} />
                    <span>{button.title}</span>
                  </a>
                ))}
              </div>
              <p className="web-chat__handoff-hint">Если в мессенджере нет кнопки «Начать», напишите боту любое сообщение — и разговор продолжится.</p>
            </>
          ) : (
            <>
              <div className="web-chat__handoff-moved">
                <MessengerLogo channel={handoff.channel} size={32} />
                <p>
                  {handoff.state === "taken"
                    ? `Разговор продолжается в ${handoff.title}. Ответы и напоминания приходят туда.`
                    : `Мы уже на связи в ${handoff.title} — продолжим этот разговор там.`}
                </p>
              </div>
              {handoff.url && (
                <a className="web-chat__messenger web-chat__messenger--wide" href={handoff.url} target="_blank" rel="noreferrer" part="messenger">
                  <MessengerLogo channel={handoff.channel} size={24} />
                  <span>{`Перейти в ${handoff.title}`}</span>
                </a>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Квадрат «стоп» — закрашенный: так он читается в кружке кнопки. */
const StopGlyph: PhosphorIcon = forwardRef<SVGSVGElement, IconProps>((props, ref) => <SquareIcon ref={ref} {...props} weight="fill" />);
StopGlyph.displayName = "StopGlyph";

/** Микрофон в поле: нажал — говорит, нажал ещё раз — текст дописан в поле, его можно поправить и отправить. */
function VoiceButton({ view, disabled }: { view: VoiceInputView; disabled: boolean }) {
  const labels = russianLabels;
  const busy = view.state === "connecting" || view.state === "stopping" || view.polishing;
  const recording = !busy && view.state === "listening";
  const label = busy ? (view.polishing ? labels.voicePolishing : labels.voiceConnecting) : recording ? labels.voiceStop : labels.voiceStart;
  return (
    <Button
      type="button"
      size="lg"
      variant="ghost"
      icon={recording ? StopGlyph : MicrophoneIcon}
      aria-label={label}
      aria-pressed={busy ? undefined : recording}
      className={`web-chat__voice${recording ? " web-chat__voice--recording" : ""}`}
      // Подключение и обработка сказанного: кнопка занята, нажатия не проходят
      loading={busy}
      disabled={disabled}
      onClick={view.onToggle}
      onPointerDown={keepInputFocus}
      onMouseDown={keepInputFocus}
    />
  );
}

function ChatBubble({ item }: { item: WebChatItem }) {
  return (
    <div className={`web-chat__bubble web-chat__bubble--${item.from}`} data-from={item.from} part={`message message-${item.from}`}>
      {item.imageUrl && (
        // Картинка своя, отдаётся только этому посетителю: оптимизатор Next её не получит
        // eslint-disable-next-line @next/next/no-img-element
        <img className="web-chat__image" src={item.imageUrl} alt={item.from === "person" ? "Ваше фото" : "Картинка от консультанта"} loading="lazy" />
      )}
      {item.video &&
        (item.video.embedUrl ? (
          <div className="web-chat__video">
            <iframe
              src={item.video.embedUrl}
              title={item.video.title}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              loading="lazy"
            />
          </div>
        ) : (
          <a href={item.video.url} target="_blank" rel="noreferrer">
            {item.video.title}
          </a>
        ))}
      {item.video && item.video.embedUrl && <p className="web-chat__video-title">{item.video.title}</p>}
      {item.text && <p className="web-chat__text">{linkified(item.text)}</p>}
    </div>
  );
}

function keepInputFocus(event: { preventDefault(): void }): void {
  event.preventDefault();
}

function isTouch(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

const URL_PATTERN = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]])/g;

function linkified(text: string) {
  return text.split(URL_PATTERN).map((part, index) =>
    index % 2 === 1 ? (
      <a key={index} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}
