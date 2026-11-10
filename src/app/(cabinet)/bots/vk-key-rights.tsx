// Права ключа сообщества ВК — одним списком для окна подключения и карточки бота: у каждого права одна строка «зачем»
const VK_KEY_RIGHTS = [
  { name: "Управление сообществом", why: "приложение само настроит приём сообщений" },
  { name: "Сообщения сообщества", why: "бот читает сообщения людей и отвечает" },
  { name: "Фотографии", why: "нужно, только если бот будет присылать картинки. Без него ответы приходят текстом" },
] as const;

export function VkKeyRights() {
  return (
    <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5" aria-label="Права ключа">
      {VK_KEY_RIGHTS.map((right) => (
        <li key={right.name}>
          <span className="font-semibold">«{right.name}»</span> — {right.why}.
        </li>
      ))}
    </ul>
  );
}
