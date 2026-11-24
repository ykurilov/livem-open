export type WidgetMode = "button" | "inline";
export type WidgetPosition = "right" | "left";

/** Код, который эксперт вставляет на сайт: скрипт приложения и элемент `livem-chat` с кодом ссылки веб-чата. */
export function widgetEmbedCode({ origin, code, mode, position }: { origin: string; code: string; mode: WidgetMode; position: WidgetPosition }): string {
  const placement = mode === "button" && position === "left" ? ' position="left"' : "";
  return `<script src="${attribute(origin)}/widget.js" async></script>\n<livem-chat code="${attribute(code)}" mode="${mode}"${placement}></livem-chat>`;
}

/** Все переменные оформления и части виджета со значениями по умолчанию: эксперт правит нужное, остальное удаляет. */
export const WIDGET_STYLE_EXAMPLE = `livem-chat {
  --livem-color: #EE6A3C;          /* основной цвет: кнопка, свои сообщения */
  --livem-color-text: #FFFFFF;     /* текст на основном цвете */
  --livem-text: #141414;           /* текст сообщений */
  --livem-background: #FFFFFF;     /* фон окна */
  --livem-font: system-ui, sans-serif;
  --livem-radius: 16px;            /* скругление окна и сообщений */
  --livem-button-size: 56px;
  --livem-window-width: 380px;
  --livem-window-height: 600px;
  --livem-offset-x: 20px;          /* отступ кнопки и окна от края */
  --livem-offset-y: 20px;
  --livem-z-index: 2147483000;
}

/* Части виджета — для точной правки */
livem-chat::part(button) {}          /* кнопка в углу */
livem-chat::part(window) {}          /* окно или блок */
livem-chat::part(header) {}
livem-chat::part(feed) {}            /* лента сообщений */
livem-chat::part(message-bot) {}
livem-chat::part(message-person) {}
livem-chat::part(composer) {}        /* поле ввода с кнопками */
livem-chat::part(quick-reply) {}     /* кнопка-подсказка */
`;

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
