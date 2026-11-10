import { describe, expect, it } from "vitest";
import { CLIENT_PLAY_RULES, clientRoleIntro } from "../consultant/client-role";
import { CLIENT_LEAVE_TOOL, clientCardBlock, clientInstructions, ROLE_SWAP_CLIENT_BLOCK_KEY } from "./client-agent";

const conversation = { topic: "Как выбрать велосипед (подбор под рост и бюджет)", clientCard: "Ольга, 42 года, хочет ездить на работу, боится дорогих покупок." };

describe("агент-клиент «Поменяемся ролями»", () => {
  it("инструкция одна на все разговоры: в ней нет ни темы, ни карточки", () => {
    const text = clientInstructions();
    expect(clientInstructions()).toBe(text);
    expect(text).not.toContain(conversation.topic);
    expect(text).not.toContain("Ольга");
  });

  it("инструкция собрана из общей роли клиента и правил режима: ответ на каждую реплику, уход инструментом", () => {
    const text = clientInstructions();
    const intro = clientRoleIntro("").split("\n")[0]!;
    expect(text.startsWith(intro)).toBe(true);
    expect(text).toContain(CLIENT_PLAY_RULES);
    expect(text).toContain(CLIENT_LEAVE_TOOL);
    expect(CLIENT_LEAVE_TOOL).toBe("leave_chat");
  });

  it("в правилах режима нет примеров реплик клиента", () => {
    const ownRules = clientInstructions().replace(CLIENT_PLAY_RULES, "");
    expect(ownRules).not.toMatch(/[«»"“”]/);
  });

  it("блок клиента — тема бота и карточка под своим ключом", () => {
    const block = clientCardBlock(conversation);
    expect(block.key).toBe(ROLE_SWAP_CLIENT_BLOCK_KEY);
    expect(block.key).toBe("role-swap:client");
    expect(block.text).toContain(conversation.topic);
    expect(block.text).toContain(conversation.clientCard);
  });

  it("блок одинаков побайтно для одного разговора", () => {
    expect(clientCardBlock(conversation)).toEqual(clientCardBlock({ ...conversation }));
  });
});
