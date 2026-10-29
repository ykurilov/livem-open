// Примеры запросов Callback API ВК в том виде, в каком сообщество присылает их на вебхук (версия API 5.199).
// Составлены по документации ВК (поля и вложенность те же); реальных запросов к ВК тесты не делают.

export const SECRET = "hookxsecretx1";
export const GROUP_ID = 222333;

const base = { group_id: GROUP_ID, v: "5.199", secret: SECRET };

const clientInfo = {
  button_actions: ["text", "vkpay", "open_app", "location", "open_link", "callback", "intent_subscribe", "intent_unsubscribe"],
  keyboard: true,
  inline_keyboard: true,
  carousel: true,
  lang_id: 0,
};

const messageBase = {
  date: 1790000000,
  from_id: 5550001,
  id: 0,
  out: 0,
  version: 10000000,
  attachments: [],
  conversation_message_id: 12,
  fwd_messages: [],
  important: false,
  is_hidden: false,
  peer_id: 5550001,
  random_id: 0,
};

/** Подтверждение адреса: приходит при `addCallbackServer`. */
export const confirmation = { type: "confirmation", group_id: GROUP_ID, secret: SECRET };

export const confirmationWithoutSecret = { type: "confirmation", group_id: GROUP_ID };

export const confirmationForAnotherGroup = { type: "confirmation", group_id: 999, secret: SECRET };

export const plainText = {
  ...base,
  type: "message_new",
  event_id: "9f2c0a77aa41d3b6c1f0d5e8a2b3c4d5e6f70809",
  object: {
    message: { ...messageBase, id: 41, text: "Хочу научиться делать рассылки" },
    client_info: clientInfo,
  },
};

export const startWithRef = {
  ...base,
  type: "message_new",
  event_id: "1a1a1a1a2b2b2b2b3c3c3c3c4d4d4d4d5e5e5e5e",
  object: {
    message: {
      ...messageBase,
      id: 42,
      text: "Начать",
      ref: "Ab3dE5gH",
      ref_source: "Ab3dE5gH",
      payload: '{"command":"start"}',
    },
    client_info: clientInfo,
  },
};

/** Кнопка «Начать» без ссылки с кодом. */
export const startWithoutRef = {
  ...base,
  type: "message_new",
  event_id: "2b2b2b2b3c3c3c3c4d4d4d4d5e5e5e5e6f6f6f6f",
  object: {
    message: { ...messageBase, id: 43, text: "Начать", payload: '{"command":"start"}' },
    client_info: clientInfo,
  },
};

/** В сообщении только `ref_source` (код дублируется, но `ref` может не прийти). */
export const startWithRefSourceOnly = {
  ...base,
  type: "message_new",
  event_id: "3c3c3c3c4d4d4d4d5e5e5e5e6f6f6f6f7a7a7a7a",
  object: {
    message: { ...messageBase, id: 44, text: "Начать", ref_source: "Zz9Yy8Xx" },
    client_info: clientInfo,
  },
};

export const photoWithCaption = {
  ...base,
  type: "message_new",
  event_id: "4d4d4d4d5e5e5e5e6f6f6f6f7a7a7a7a8b8b8b8b",
  object: {
    message: {
      ...messageBase,
      id: 45,
      text: "Вот мой текущий сайт",
      attachments: [{ type: "photo", photo: { id: 1, owner_id: 5550001, sizes: [], access_key: "k" } }],
    },
    client_info: clientInfo,
  },
};

export const voiceMessage = {
  ...base,
  type: "message_new",
  event_id: "5e5e5e5e6f6f6f6f7a7a7a7a8b8b8b8b9c9c9c9c",
  object: {
    message: {
      ...messageBase,
      id: 46,
      text: "",
      attachments: [{ type: "audio_message", audio_message: { id: 2, owner_id: 5550001, duration: 7, link_ogg: "https://vk.test/v.ogg" } }],
    },
    client_info: clientInfo,
  },
};

export const stickerMessage = {
  ...base,
  type: "message_new",
  event_id: "6f6f6f6f7a7a7a7a8b8b8b8b9c9c9c9cad0d0d0d",
  object: {
    message: { ...messageBase, id: 47, text: "", attachments: [{ type: "sticker", sticker: { sticker_id: 9, product_id: 1 } }] },
    client_info: clientInfo,
  },
};

export const documentMessage = {
  ...base,
  type: "message_new",
  event_id: "7a7a7a7a8b8b8b8b9c9c9c9cad0d0d0dbe1e1e1e",
  object: {
    message: {
      ...messageBase,
      id: 48,
      text: "Бриф",
      attachments: [{ type: "doc", doc: { id: 3, owner_id: 5550001, title: "brief.pdf", ext: "pdf" } }],
    },
    client_info: clientInfo,
  },
};

/** Ссылка текстом: ВК сам добавляет к ней сниппет вложением `link`. */
export const linkWithSnippet = {
  ...base,
  type: "message_new",
  event_id: "8b8b8b8b9c9c9c9cad0d0d0dbe1e1e1ecf2f2f30",
  object: {
    message: {
      ...messageBase,
      id: 52,
      text: "https://koleso-uzhina.apps.example.com/",
      attachments: [{ type: "link", link: { url: "https://koleso-uzhina.apps.example.com/", title: "Колесо ужина" } }],
    },
    client_info: clientInfo,
  },
};

export const wallPostMessage = {
  ...base,
  type: "message_new",
  event_id: "8b8b8b8b9c9c9c9cad0d0d0dbe1e1e1ecf2f2f2f",
  object: {
    message: { ...messageBase, id: 49, text: "", attachments: [{ type: "wall", wall: { id: 5, owner_id: -1 } }] },
    client_info: clientInfo,
  },
};

export const locationMessage = {
  ...base,
  type: "message_new",
  event_id: "9c9c9c9cad0d0d0dbe1e1e1ecf2f2f2f0a3a3a3a",
  object: {
    message: { ...messageBase, id: 50, text: "", geo: { type: "point", coordinates: { latitude: -8.65, longitude: 115.21 } } },
    client_info: clientInfo,
  },
};

export const buttonPressed = {
  ...base,
  type: "message_event",
  event_id: "ad0d0d0dbe1e1e1ecf2f2f2f0a3a3a3a1b4b4b4b",
  object: {
    user_id: 5550001,
    peer_id: 5550001,
    event_id: "ev-5550001-1790000010",
    payload: { p: "menu:lead-magnet-1" },
    conversation_message_id: 20,
  },
};

/** ВК присылает `payload` кнопки либо разобранным объектом, либо строкой с JSON. */
export const buttonPressedStringPayload = {
  ...buttonPressed,
  event_id: "be1e1e1ecf2f2f2f0a3a3a3a1b4b4b4b2c5c5c5c",
  object: { ...buttonPressed.object, payload: '{"p":"menu:lead-magnet-1"}' },
};

/** Кнопка не от нашего бота: данные остаются как есть. */
export const buttonWithForeignPayload = {
  ...buttonPressed,
  event_id: "cf2f2f2f0a3a3a3a1b4b4b4b2c5c5c5c3d6d6d6d",
  object: { ...buttonPressed.object, payload: { cmd: "x" } },
};

export const messagesDenied = {
  ...base,
  type: "message_deny",
  event_id: "0a3a3a3a1b4b4b4b2c5c5c5c3d6d6d6d4e7e7e7e",
  object: { user_id: 5550001 },
};

export const messagesAllowed = {
  ...base,
  type: "message_allow",
  event_id: "1b4b4b4b2c5c5c5c3d6d6d6d4e7e7e7e5f8f8f8f",
  object: { user_id: 5550001, key: "" },
};

/** Сообщение в беседе, куда добавили сообщество. */
export const groupChatMessage = {
  ...base,
  type: "message_new",
  event_id: "2c5c5c5c3d6d6d6d4e7e7e7e5f8f8f8f609090a0",
  object: {
    message: { ...messageBase, id: 51, peer_id: 2000000007, text: "/start Ab3dE5gH" },
    client_info: clientInfo,
  },
};

/** Исходящее сообщение сообщества (например, ответил администратор) — не разговор. */
export const outgoingMessage = {
  ...base,
  type: "message_new",
  event_id: "3d6d6d6d4e7e7e7e5f8f8f8f609090a071a1a1b1",
  object: {
    message: { ...messageBase, id: 52, out: 1, from_id: -GROUP_ID, text: "Ответ администратора" },
    client_info: clientInfo,
  },
};

export const wallPostNew = {
  ...base,
  type: "wall_post_new",
  event_id: "4e7e7e7e5f8f8f8f609090a071a1a1b182b2b2c2",
  object: { id: 77, owner_id: -GROUP_ID, text: "Новый пост" },
};

// --- коды в `ref` ссылки vk.me ---

const startMessage = (eventId: string, id: number, refs: { ref?: string; ref_source?: string }) => ({
  ...base,
  type: "message_new",
  event_id: eventId,
  object: { message: { ...messageBase, id, text: "Начать", payload: '{"command":"start"}', ...refs }, client_info: clientInfo },
});

/** Ссылка лидмагнита: код 8 знаков. */
export const leadMagnetLink = startMessage("71a1a1b182b2b2c293c3c3d3a4d4d4e4b5e5e5f5", 63, {
  ref: "Ab3dE5gH",
  ref_source: "Ab3dE5gH",
});

/** Рекламная метка в `ref` (не наш код): сообщение идёт в лидмагнит как обычное. */
export const adRef = startMessage("82b2b2c293c3c3d3a4d4d4e4b5e5e5f5c6f6f606", 64, {
  ref: "vk_ads_autumn",
  ref_source: "vk_ads_autumn",
});
