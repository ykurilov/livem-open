import { createRoot, type Root } from "react-dom/client";
import styles from "livem-widget-styles";
import type { WidgetMode, WidgetPosition } from "./embed-code";
import { LivemChat } from "./livem-chat";

/** Адрес приложения — откуда загружен этот скрипт: туда виджет и ходит. */
const appOrigin = new URL((document.currentScript as HTMLScriptElement | null)?.src || window.location.href).origin;

/**
 * `<livem-chat code="…" mode="button|inline" position="right|left">` — чат лидмагнита на сайте. Внутри теневой корень: стили
 * сайта виджет не ломают, а меняют его только переменные `--livem-*` и части `::part(...)`.
 */
class LivemChatElement extends HTMLElement {
  static observedAttributes = ["code", "mode", "position"];
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = styles;
      const mount = document.createElement("div");
      shadow.replaceChildren(style, mount);
      this.root = createRoot(mount);
    }
    this.render();
  }

  disconnectedCallback() {
    // Элемент могут переставить на странице: корень снимается, только если он так и не вернулся
    queueMicrotask(() => {
      if (this.isConnected || !this.root) return;
      this.root.unmount();
      this.root = null;
    });
  }

  attributeChangedCallback() {
    if (this.root) this.render();
  }

  private render() {
    const code = this.getAttribute("code")?.trim();
    if (!code) {
      console.warn("Виджет лидмагнита: у элемента livem-chat нет атрибута code — его берут в кабинете, «Встроить на сайт».");
      this.root?.render(null);
      return;
    }
    const mode: WidgetMode = this.getAttribute("mode") === "inline" ? "inline" : "button";
    const position: WidgetPosition = this.getAttribute("position") === "left" ? "left" : "right";
    this.root?.render(<LivemChat key={code} origin={appOrigin} code={code} mode={mode} position={position} />);
  }
}

if (!customElements.get("livem-chat")) customElements.define("livem-chat", LivemChatElement);
