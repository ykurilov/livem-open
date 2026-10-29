/** Роль в кабинете одна, все эксперты видят всё: чаты кабинета (конструктор, тестовый разговор) принадлежат общему владельцу. */
export const CABINET_OWNER_ID = "cabinet";

const PREVIEW_OWNER_PREFIX = `${CABINET_OWNER_ID}:`;

/**
 * Владелец тестового чата «Проверки»: свой на каждый чат. Сценарий SDK считает по владельцу сообщения первым за день —
 * так у каждой проверки свой счёт, как у каждого человека. Карточка клиента и пояс у всех тестовых чатов общие
 * (`isPreviewOwner`). Чаты, начатые раньше, принадлежат общему владельцу кабинета.
 */
export const previewOwnerId = (chatId: string) => `${PREVIEW_OWNER_PREFIX}${chatId}`;

/** Владелец — тестовый чат «Проверки» (свой или общий владелец кабинета у старых чатов). */
export const isPreviewOwner = (ownerId: string) => ownerId === CABINET_OWNER_ID || ownerId.startsWith(PREVIEW_OWNER_PREFIX);
