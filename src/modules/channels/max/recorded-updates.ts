// Примеры обновлений Max в том виде, в каком платформа присылает их на вебхук.
// Составлены по документации Max Bot API (поля и вложенность те же); реальных запросов к Max тесты не делают.

const anna = {
  user_id: 5550001,
  first_name: "Анна",
  last_name: "Петрова",
  name: "Анна Петрова",
  username: "anna_p",
  is_bot: false,
  last_activity_time: 1790000000000,
};
const botUser = { user_id: 123456, first_name: "Живой лидмагнит", name: "Живой лидмагнит", username: "live_magnet_bot", is_bot: true };

const dialog = { chat_id: 880001, chat_type: "dialog", user_id: 123456 };

const messageUpdate = (timestamp: number, body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  update_type: "message_created",
  timestamp,
  message: { sender: anna, recipient: dialog, timestamp, body: { seq: 1, ...body }, ...extra },
  user_locale: "ru",
});

export const startWithPayload = {
  update_type: "bot_started",
  timestamp: 1790000001000,
  chat_id: 880001,
  user: anna,
  payload: "Ab3dE5gH",
  user_locale: "ru",
};

export const startWithoutPayload = {
  update_type: "bot_started",
  timestamp: 1790000002000,
  chat_id: 880001,
  user: anna,
  user_locale: "ru",
};

/** Предельная длина payload — 128 знаков. */
export const LONGEST_PAYLOAD = "p".repeat(128);

export const startWithLongestPayload = { ...startWithPayload, timestamp: 1790000003000, payload: LONGEST_PAYLOAD };

export const plainText = messageUpdate(1790000004000, { mid: "mid.0000000000a1b2c3", text: "Хочу научиться делать рассылки" });

export const photoWithCaption = messageUpdate(1790000005000, {
  mid: "mid.0000000000a1b2c4",
  text: "Вот мой текущий сайт",
  attachments: [{ type: "image", payload: { photo_id: 1, token: "t", url: "https://i.max.test/1.jpg" } }],
});

export const voiceMessage = messageUpdate(1790000006000, {
  mid: "mid.0000000000a1b2c5",
  text: null,
  attachments: [{ type: "audio", payload: { token: "t", url: "https://a.max.test/1.ogg" } }],
});

export const stickerMessage = messageUpdate(1790000007000, {
  mid: "mid.0000000000a1b2c6",
  attachments: [{ type: "sticker", payload: { url: "https://s.max.test/1.webp", code: "c" }, width: 512, height: 512 }],
});

export const fileMessage = messageUpdate(1790000008000, {
  mid: "mid.0000000000a1b2c7",
  text: "Бриф",
  attachments: [{ type: "file", payload: { token: "t", url: "https://f.max.test/brief.pdf" }, filename: "brief.pdf", size: 100 }],
});

export const videoMessage = messageUpdate(1790000009000, {
  mid: "mid.0000000000a1b2c8",
  attachments: [{ type: "video", payload: { token: "t", url: "https://v.max.test/1.mp4" } }],
});

export const locationMessage = messageUpdate(1790000010000, {
  mid: "mid.0000000000a1b2c9",
  attachments: [{ type: "location", latitude: -8.65, longitude: 115.21 }],
});

/** Ссылка текстом: Max сам добавляет к ней карточку-превью вложением `share` (живой разговор 20.10). */
export const linkWithPreview = messageUpdate(1790000010500, {
  mid: "mid.0000000000a1b2ca",
  text: "https://koleso-uzhina.apps.example.com/",
  attachments: [{ type: "share", payload: { url: "https://koleso-uzhina.apps.example.com/" }, title: "Колесо ужина" }],
});

/** Нет `mid` — ключ строится из типа, человека и времени. */
export const textWithoutMid = messageUpdate(1790000011000, { text: "Без идентификатора" });

export const buttonPressed = {
  update_type: "message_callback",
  timestamp: 1790000012000,
  callback: { timestamp: 1790000012000, callback_id: "cb.Zm9vYmFy", payload: "menu:lead-magnet-1", user: anna },
  message: { sender: botUser, recipient: { ...dialog, user_id: 5550001 }, timestamp: 1790000000000, body: { mid: "mid.0000000000a1b200", seq: 1, text: "Выберите" } },
  user_locale: "ru",
};

export const botStoppedByUser = {
  update_type: "bot_stopped",
  timestamp: 1790000013000,
  chat_id: 880001,
  user: anna,
  user_locale: "ru",
};

/** Сообщение в групповом чате, куда добавили бота. */
export const groupChatMessage = {
  ...messageUpdate(1790000014000, { mid: "mid.0000000000a1b2d0", text: "/start Ab3dE5gH" }),
  message: {
    sender: anna,
    recipient: { chat_id: 990001, chat_type: "chat" },
    timestamp: 1790000014000,
    body: { mid: "mid.0000000000a1b2d0", seq: 1, text: "/start Ab3dE5gH" },
  },
};

/** Сообщение, которое прислал другой бот. */
export const messageFromAnotherBot = {
  ...messageUpdate(1790000015000, { mid: "mid.0000000000a1b2d1", text: "Привет от бота" }),
  message: { sender: botUser, recipient: dialog, timestamp: 1790000015000, body: { mid: "mid.0000000000a1b2d1", seq: 1, text: "Привет от бота" } },
};

export const messageEdited = {
  update_type: "message_edited",
  timestamp: 1790000016000,
  message: { sender: anna, recipient: dialog, timestamp: 1790000016000, body: { mid: "mid.0000000000a1b2d2", seq: 2, text: "Исправил опечатку" } },
};

export const botAddedToChat = { update_type: "bot_added", timestamp: 1790000017000, chat_id: 990001, user: anna, is_channel: false };
