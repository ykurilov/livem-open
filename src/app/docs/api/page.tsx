import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CHAT_API_VISITOR_HEADER } from "@/modules/chat-api";
import { currentAppOrigin } from "@/modules/platform/request-origin";
import { MESSAGE_MAX_LENGTH } from "@/modules/web-chat/web-chat";

export const metadata: Metadata = { title: "API чата лидмагнита — Живые лидмагниты" };

/**
 * Документация публичного API для программиста эксперта: открыта без входа. Примеры — с адресом этого приложения,
 * чтобы их можно было запускать как есть.
 */
export default async function ApiDocsPage() {
  const origin = await currentAppOrigin();
  const base = `${origin}/api/v1/chats/КОД`;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-[var(--yk-space-6)] px-4 py-10 text-[var(--yk-text)]">
      <header className="flex flex-col gap-2">
        <h1 className="text-[length:var(--yk-text-h1-size,2rem)] font-semibold">API чата лидмагнита</h1>
        <p>
          Свой чат с агентом лидмагнита на своём сайте — с любым видом и поведением. Это тот же разговор, что в веб-чате: он виден эксперту в отчётах и
          во «Входящих», агент тратит модель так же. Готовый виджет для сайта работает через этот же API.
        </p>
        <p>
          Версия API — в адресе: <C>/api/v1/…</C>. Поля, которых нет в этой странице, могут появиться в ответах позже: не опирайтесь на них и не
          ломайтесь от новых.
        </p>
      </header>

      <Section title="Код чата">
        <p>
          Код — последняя часть ссылки на веб-чат лидмагнита: у <C>{`${origin}/c/K7mP2xQ`}</C> код <C>K7mP2xQ</C>. Ссылка и код — в кабинете, на
          странице публикации лидмагнита. В примерах ниже вместо <C>КОД</C> подставьте свой.
        </p>
      </Section>

      <Section title="Два способа входа">
        <h3 className="font-semibold">Из браузера посетителя</h3>
        <p>
          Запросы идут прямо со страниц сайта. Чат работает только на сайтах из списка лидмагнита (раздел «Встроить на сайт»); пустой список —
          работает везде. С сайта не из списка любой запрос получает 403, разговор не начинается.
        </p>
        <p>
          Посетитель узнаётся по токену: вход (<C>POST …/session</C>) возвращает <C>token</C>, браузер хранит его сам (например, в{" "}
          <C>localStorage</C>) и шлёт заголовком <C>Authorization: Bearer &lt;токен&gt;</C>. Cookie не нужны. Потеряли токен — следующий вход заведёт
          нового посетителя.
        </p>
        <h3 className="font-semibold">С сервера эксперта</h3>
        <p>
          Секретный ключ лидмагнита <C>lmk_…</C> в заголовке <C>Authorization: Bearer &lt;ключ&gt;</C> и свой id посетителя в заголовке{" "}
          <C>{CHAT_API_VISITOR_HEADER}</C> — любая строка до 200 знаков, например id пользователя в вашей базе. У каждого id свой разговор, разговоры
          разных посетителей не смешиваются. Токен не нужен.
        </p>
        <p>
          Ключ выпускают и отзывают в кабинете, в разделе «Встроить на сайт»; показывается он один раз. Новый ключ отменяет прежний. Ключ держите
          только на сервере: запрос с ключом из браузера (с заголовком <C>Origin</C>) отклоняется.
        </p>
      </Section>

      <Section title="Адреса">
        <Endpoint method="GET" path="/api/v1/chats/{код}">
          О чате, ничего не начинает: <C>{`{ "title": "…", "photos": true, "voice": false }`}</C>. <C>photos</C> — принимает ли лидмагнит фото
          посетителя. <C>voice</C> — только для готового виджета, в API голоса нет.
        </Endpoint>
        <Endpoint method="POST" path="/api/v1/chats/{код}/session">
          Начать или продолжить разговор. Тело (необязательно): <C>{`{ "timeZone": "Europe/Moscow" }`}</C> — часовой пояс посетителя для напоминаний и
          записи на звонок. Ответ: <C>{`{ "title": "…", "token": "…" }`}</C>; <C>token</C> — только браузеру. Первое сообщение агента готовится
          после входа и приходит в ленте. Вход повторять можно: тот же посетитель продолжает тот же разговор.
        </Endpoint>
        <Endpoint method="GET" path="/api/v1/chats/{код}/messages?since={время}">
          Лента разговора: <C>{`{ "messages": [...], "handoff": null }`}</C>. Без <C>since</C> — вся история, с <C>since</C> (время ISO 8601) — только
          сообщения новее.
        </Endpoint>
        <Endpoint method="POST" path="/api/v1/chats/{код}/messages">
          Сообщение посетителя. JSON <C>{`{ "text": "…", "clientId": "…" }`}</C> или форма <C>multipart/form-data</C> с полями <C>text</C>,{" "}
          <C>clientId</C> и <C>photo</C>. Текст — до {MESSAGE_MAX_LENGTH} знаков; с фото текст можно не писать. Фото — PNG, JPEG, GIF или WebP до 10 МБ,
          если лидмагнит принимает фото. <C>clientId</C> — ваш id сообщения (до 100 знаков): повтор с тем же id после обрыва связи второго сообщения
          не создаст; не указали — сервер придумает сам. Ответ: <C>{`{ "ok": true, "item": {…} }`}</C> — принятое сообщение для ленты.
        </Endpoint>
      </Section>

      <Section title="Сообщение в ленте">
        <Code>{`{
  "id": "…",                    // повторы при опросе отсекайте по id
  "from": "bot",                // "bot" — агент или эксперт, "person" — посетитель
  "text": "…",
  "at": "2026-11-24T10:00:00.000Z",
  "imageUrl": "…",              // есть, если в сообщении картинка: ссылка подписана, годится для <img>
  "video": { "title": "…", "url": "…", "embedUrl": "…" },   // ролик; embedUrl — плеер, null — показать ссылкой
  "quickReplies": ["…", "…"],   // кнопки-подсказки: показывайте, пока сообщение последнее в ленте
  "noReply": true               // сообщение посетителя ушло эксперту, агент на него не ответит
}`}</Code>
        <p>
          <B>Ответ по частям.</B> Агент отвечает несколькими сообщениями подряд, и они появляются в ленте по мере готовности. После своего сообщения
          опрашивайте <C>messages?since=…</C> раз в 1–3 секунды, пока ждёте ответ, потом реже. В <C>since</C> берите время последнего сообщения минус
          минуту: так ничего не потеряется, а повторы отсекутся по <C>id</C>.
        </p>
      </Section>

      <Section title="Переход в мессенджер">
        <p>
          Агент может позвать посетителя продолжить в мессенджере. Тогда в ленте приходит <C>handoff</C>:
        </p>
        <Code>{`// предложение: кнопки мессенджеров, поле ввода можно оставить
{ "state": "offered", "buttons": [{ "channel": "telegram", "title": "Telegram", "url": "https://t.me/…" }] }

// посетитель перешёл: дальше разговор там, сообщения сюда не принимаются (409)
{ "state": "taken", "channel": "telegram", "title": "Telegram", "url": "https://t.me/…" }`}</Code>
        <p>
          <C>state</C> бывает <C>offered</C>, <C>taken</C> или <C>messenger</C> (разговор уже идёт в мессенджере). Ссылку открывайте в новой вкладке.
        </p>
      </Section>

      <Section title="Ошибки">
        <p>
          Ответ с ошибкой — <C>{`{ "error": "…" }`}</C>: текст на русском, его можно показать человеку или записать в журнал.
        </p>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            <C>400</C> — пустое или слишком длинное сообщение, нет заголовка <C>{CHAT_API_VISITOR_HEADER}</C>, чат не принимает фото.
          </li>
          <li>
            <C>401</C> — нет токена посетителя (сначала вход) или ключ не подошёл: отозван или набран с ошибкой.
          </li>
          <li>
            <C>403</C> — сайт не из списка разрешённых, ключ от другого лидмагнита или ключ прислан из браузера.
          </li>
          <li>
            <C>404</C> — чата нет: код с ошибкой или лидмагнит снят с публикации.
          </li>
          <li>
            <C>409</C> — разговор ушёл в мессенджер или закончен; в ответе может быть <C>current</C> — код и название разговора, который идёт сейчас.
          </li>
          <li>
            <C>413</C> — фото больше 10 МБ.
          </li>
          <li>
            <C>429</C> — слишком часто: подождите и повторите. С ключом ограничения считаются на весь ключ, из браузера — по адресу посетителя в сети.
          </li>
          <li>
            <C>503</C> — временный сбой: повторите тот же запрос (с тем же <C>clientId</C>).
          </li>
        </ul>
      </Section>

      <Section title="Пример: браузер">
        <Code>{`const base = "${base}";
const auth = () => {
  const token = localStorage.getItem("chat-token");
  return token ? { Authorization: "Bearer " + token } : {};
};

// Начать или продолжить разговор
const session = await fetch(base + "/session", {
  method: "POST",
  headers: { ...auth(), "Content-Type": "application/json" },
  body: JSON.stringify({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
}).then((response) => response.json());
if (session.token) localStorage.setItem("chat-token", session.token);

// Сообщение
await fetch(base + "/messages", {
  method: "POST",
  headers: { ...auth(), "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Здравствуйте!", clientId: crypto.randomUUID() }),
});

// Фото с подписью
const form = new FormData();
form.set("text", "Вот моё фото");
form.set("clientId", crypto.randomUUID());
form.set("photo", fileInput.files[0]);
await fetch(base + "/messages", { method: "POST", headers: auth(), body: form });

// Лента: вся история, затем только новое
const { messages, handoff } = await fetch(base + "/messages", { headers: auth() }).then((response) => response.json());`}</Code>
      </Section>

      <Section title="Пример: сервер">
        <Code>{`# Начать или продолжить разговор посетителя user-42
curl -X POST "${base}/session" \\
  -H "Authorization: Bearer lmk_ВАШ_КЛЮЧ" \\
  -H "${CHAT_API_VISITOR_HEADER}: user-42" \\
  -H "Content-Type: application/json" \\
  -d '{"timeZone":"Europe/Moscow"}'

# Сообщение
curl -X POST "${base}/messages" \\
  -H "Authorization: Bearer lmk_ВАШ_КЛЮЧ" \\
  -H "${CHAT_API_VISITOR_HEADER}: user-42" \\
  -H "Content-Type: application/json" \\
  -d '{"text":"Здравствуйте!","clientId":"msg-1"}'

# Фото
curl -X POST "${base}/messages" \\
  -H "Authorization: Bearer lmk_ВАШ_КЛЮЧ" \\
  -H "${CHAT_API_VISITOR_HEADER}: user-42" \\
  -F text="Вот моё фото" -F clientId=msg-2 -F photo=@photo.jpg

# Новые сообщения
curl "${base}/messages?since=2026-11-24T10:00:00Z" \\
  -H "Authorization: Bearer lmk_ВАШ_КЛЮЧ" \\
  -H "${CHAT_API_VISITOR_HEADER}: user-42"`}</Code>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[length:var(--yk-text-h2-size,1.5rem)] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Endpoint({ method, path, children }: { method: string; path: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <code className="font-semibold">
        {method} {path}
      </code>
      <p>{children}</p>
    </div>
  );
}

function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-[var(--yk-surface)] px-1 break-words">{children}</code>;
}

function B({ children }: { children: ReactNode }) {
  return <strong className="font-semibold">{children}</strong>;
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] p-3 text-[length:var(--yk-text-small-size)]">
      <code>{children}</code>
    </pre>
  );
}
