"use client";

import type { ChatSkin } from "@ykurilov/agent-chat-react";
import { createContext, useContext } from "react";
import { tagProductLinks, type ProductLink } from "@/modules/purchases/product-links";
import { PREVIEW_MEDIUM, previewTrackingCode } from "@/modules/purchases/preview-code";

/** Ссылки продуктов черновика и чат «Проверки»: по ним текст агента размечается так же, как в мессенджере. */
export const PreviewProductLinks = createContext<{ products: readonly ProductLink[]; chatId: string } | null>(null);

/**
 * Скин, в котором ссылки продукта в ответе агента — с метками, как их получит человек (канал `preview`, тестовый код).
 * В истории модели ссылка остаётся без меток: размечается только экран.
 */
export function withTaggedProductLinks(skin: ChatSkin): ChatSkin {
  const TaggedAgentText: ChatSkin["AgentText"] = (props) => {
    const preview = useContext(PreviewProductLinks);
    const markdown =
      preview && preview.products.length > 0
        ? tagProductLinks(props.markdown, preview.products, { medium: PREVIEW_MEDIUM, content: previewTrackingCode(preview.chatId) })
        : props.markdown;
    return <skin.AgentText {...props} markdown={markdown} />;
  };
  return { ...skin, AgentText: TaggedAgentText };
}
