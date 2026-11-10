import { Button } from "@ykurilov/ds-react";
import { getDatabase } from "@/modules/platform/db";
import { webChatTitle } from "@/modules/web-chat";
import { currentVisitor } from "@/modules/web-chat/server";
import "./web-chat.css";

/** Неизвестная или устаревшая ссылка веб-чата: вернувшемуся посетителю — переход в его последний чат. */
export default async function WebChatNotFound() {
  const visitor = await currentVisitor();
  const lastCode = visitor?.lastCode ?? null;
  const lastTitle = lastCode ? await webChatTitle(getDatabase().db, lastCode, visitor) : null;
  return (
    <main className="web-chat-notice">
      <h1>Чат не найден</h1>
      <p>Ссылка устарела, или автор закрыл этот чат.</p>
      {lastCode && lastTitle ? (
        <>
          {/* Название чата бывает длинным: оно строкой выше, а на кнопке — короткая подпись, которая влезает в телефон */}
          <p>
            Ваш чат — <span className="web-chat-notice__title">«{lastTitle}»</span>
          </p>
          <Button href={`/c/${encodeURIComponent(lastCode)}`}>Вернуться в мой чат</Button>
        </>
      ) : (
        <p>Чтобы продолжить, попросите у автора новую ссылку.</p>
      )}
    </main>
  );
}
