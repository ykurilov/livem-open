import { loadCurrentBranch, type ChatStorage, type StoredMessage } from "@ykurilov/agent-chat-core";
import { sentImagesOf, type ShownImage } from "../images";
import { sentVideosOf, type ShownVideoLink } from "../videos";
import { lastReplyParts } from "./single-reply";

/**
 * Ролик и картинка, которые человек получит с ответом `messageId` (части `parts`), по правилу `sentVideosOf` и
 * `sentImagesOf`: первые показанные в ответе и не показанные раньше в разговоре. Так же их покажут карточка человека и «Входящие».
 */
export async function mediaSentWith(
  chatStorage: Pick<ChatStorage, "listMessages" | "listBranchSelections">,
  chatId: string,
  messageId: string,
  parts: StoredMessage["parts"],
): Promise<{ video: ShownVideoLink | null; image: ShownImage | null }> {
  const branch = await loadCurrentBranch(chatStorage, chatId);
  const end = branch.findIndex((stored) => stored.id === messageId);
  const earlier = (end === -1 ? branch : branch.slice(0, end)).filter((stored) => stored.role === "assistant");
  const replies = [...earlier.map((stored) => lastReplyParts(stored.parts)), lastReplyParts(parts)];
  return { video: sentVideosOf(replies).at(-1) ?? null, image: sentImagesOf(replies).at(-1) ?? null };
}
