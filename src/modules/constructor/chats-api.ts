/** Адрес чатов конструктора, общий для сервера и страницы. */
export const CONSTRUCTOR_BASE_PATH = "/api/constructor";

export const CONSTRUCTOR_CHATS_PREFIX = `${CONSTRUCTOR_BASE_PATH}/lead-magnets/`;

/** Адрес списка чатов конструктора одного лидмагнита: панель «Конструктор» работает с чатами только через него. */
export function constructorChatsApi(leadMagnetId: string): string {
  return `${CONSTRUCTOR_CHATS_PREFIX}${encodeURIComponent(leadMagnetId)}`;
}
