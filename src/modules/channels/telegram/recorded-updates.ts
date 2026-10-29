// Примеры обновлений Telegram в том виде, в каком Bot API присылает их на вебхук.
// Составлены по документации Bot API (поля и вложенность те же); реальных запросов к Telegram тесты не делают.

const anna = { id: 5550001, is_bot: false, first_name: "Анна", last_name: "Петрова", username: "anna_p", language_code: "ru" };
const privateChat = { id: 5550001, first_name: "Анна", last_name: "Петрова", username: "anna_p", type: "private" };
const botUser = { id: 123456789, is_bot: true, first_name: "Живой лидмагнит", username: "live_magnet_bot" };

const messageBase = { message_id: 12, from: anna, chat: privateChat, date: 1790000000 };

export const startWithCode = {
  update_id: 810000001,
  message: { ...messageBase, text: "/start Ab3dE5gH", entities: [{ offset: 0, length: 6, type: "bot_command" }] },
};

export const startWithoutCode = {
  update_id: 810000002,
  message: { ...messageBase, text: "/start", entities: [{ offset: 0, length: 6, type: "bot_command" }] },
};

export const startWithCodeAndBotName = {
  update_id: 810000003,
  message: {
    ...messageBase,
    text: "/start@live_magnet_bot Zz9Yy8Xx",
    entities: [{ offset: 0, length: 22, type: "bot_command" }],
  },
};

export const plainText = {
  update_id: 810000004,
  message: { ...messageBase, message_id: 13, text: "Хочу научиться делать рассылки" },
};

export const photoWithCaption = {
  update_id: 810000005,
  message: {
    ...messageBase,
    message_id: 14,
    photo: [
      { file_id: "AgAD-small", file_unique_id: "s1", file_size: 1200, width: 90, height: 60 },
      { file_id: "AgAD-big", file_unique_id: "s2", file_size: 90000, width: 1280, height: 853 },
    ],
    caption: "Вот мой текущий сайт",
  },
};

export const voiceMessage = {
  update_id: 810000006,
  message: {
    ...messageBase,
    message_id: 15,
    voice: { duration: 7, mime_type: "audio/ogg", file_id: "AwAD-voice", file_unique_id: "v1", file_size: 20000 },
  },
};

export const stickerMessage = {
  update_id: 810000007,
  message: {
    ...messageBase,
    message_id: 16,
    sticker: { width: 512, height: 512, emoji: "👍", file_id: "CAAC-sticker", file_unique_id: "st1", type: "regular" },
  },
};

export const documentMessage = {
  update_id: 810000008,
  message: {
    ...messageBase,
    message_id: 17,
    document: { file_name: "brief.pdf", mime_type: "application/pdf", file_id: "BQAD-doc", file_unique_id: "d1" },
    caption: "Бриф",
  },
};

export const locationMessage = {
  update_id: 810000009,
  message: { ...messageBase, message_id: 18, location: { latitude: -8.65, longitude: 115.21 } },
};

export const buttonPressed = {
  update_id: 810000010,
  callback_query: {
    id: "4382901234567890123",
    from: anna,
    message: { ...messageBase, from: botUser, text: "Выберите", message_id: 20 },
    chat_instance: "-1234567890",
    data: "menu:lead-magnet-1",
  },
};

export const botBlockedByUser = {
  update_id: 810000011,
  my_chat_member: {
    chat: privateChat,
    from: anna,
    date: 1790000100,
    old_chat_member: { user: botUser, status: "member" },
    new_chat_member: { user: botUser, status: "kicked", until_date: 0 },
  },
};

export const botUnblockedByUser = {
  update_id: 810000012,
  my_chat_member: {
    chat: privateChat,
    from: anna,
    date: 1790000200,
    old_chat_member: { user: botUser, status: "kicked", until_date: 0 },
    new_chat_member: { user: botUser, status: "member" },
  },
};

export const groupMessage = {
  update_id: 810000013,
  message: {
    ...messageBase,
    chat: { id: -1001234567890, title: "Чат экспертов", type: "supergroup" },
    text: "/start Ab3dE5gH",
  },
};

export const editedMessage = {
  update_id: 810000014,
  edited_message: { ...messageBase, edit_date: 1790000300, text: "Исправил опечатку" },
};
