import type { ModelCatalog } from "@ykurilov/agent-chat-core";
import { createStubModelCatalog } from "./models-catalog";
import { OUTREACH_REQUEST_TEXT } from "../consultant/outreach-request";
import { E2E_SCRIPT } from "./e2e-script";
import { createScriptedModel, type ScriptedCall, type ScriptedReply } from "./scripted-model";

function constructorReply(call: ScriptedCall): ScriptedReply {
  if (call.lastToolResult !== undefined) return { text: E2E_SCRIPT.constructorDone };
  return {
    delayMs: call.lastUserText.includes(E2E_SCRIPT.slowTrigger) ? 1500 : 0,
    toolCalls: [
      {
        toolName: "edit_lead_magnet",
        input: {
          changes: [
            { op: "set", field: "firstMessage", value: E2E_SCRIPT.firstMessage },
            { op: "set", field: "endCondition", value: "Человек сказал, что готов" },
            { op: "set", field: "farewellMessage", value: E2E_SCRIPT.farewell },
            {
              op: "put_state",
              state: {
                id: "conversation",
                title: E2E_SCRIPT.stageName,
                instructions: "Человек рассказал, чем занимается\nУзнай, чем занимается человек",
                exits: [{ id: "conversation_finish", when: { type: "event", event: "tool", name: "finish_dialog" }, to: "final" }],
              },
            },
          ],
        },
      },
    ],
  };
}

/** Ролик: найти по запросу, показать первый найденный, ответить текстом. */
function videoReply(call: ScriptedCall): ScriptedReply {
  if (call.lastToolResult === undefined) return { toolCalls: [{ toolName: "find_videos", input: { query: E2E_SCRIPT.videoQuery } }] };
  const result = (call.lastToolResult as { value?: { найдено?: Array<{ id: string }> } }).value;
  const first = result?.найдено?.[0];
  if (first) return { toolCalls: [{ toolName: "show_video", input: { id: first.id } }] };
  return { text: E2E_SCRIPT.videoReply };
}

/** Картинка: найти по запросу, показать первую найденную, ответить текстом. */
function imageReply(call: ScriptedCall): ScriptedReply {
  if (call.lastToolResult === undefined) return { toolCalls: [{ toolName: "find_images", input: { query: E2E_SCRIPT.imageQuery } }] };
  const result = (call.lastToolResult as { value?: { найдено?: Array<{ id: string }> } }).value;
  const first = result?.найдено?.[0];
  if (first) return { toolCalls: [{ toolName: "show_image", input: { id: first.id } }] };
  return { text: E2E_SCRIPT.imageReply };
}

/** Кнопки готовых ответов, потом вопрос: ход кончается текстом, и следующий ход сценарий не примет за шаг после инструмента. */
function quickRepliesReply(call: ScriptedCall): ScriptedReply {
  if (call.lastToolResult === undefined) return { toolCalls: [{ toolName: "suggest_replies", input: { replies: [...E2E_SCRIPT.quickReplies] } }] };
  return { text: E2E_SCRIPT.quickRepliesQuestion };
}

/** Начало задачи «ты пишешь человеку первым», которую сценарий SDK кладёт в ход по таймеру (утро, переход по сроку, тишина). */
const FLOW_FIRST_MESSAGE_MARK = "Ты пишешь человеку первым";

function consultantReply(call: ScriptedCall): ScriptedReply {
  if (call.lastUserText.toLowerCase().includes(E2E_SCRIPT.videoTrigger) && call.toolNames.includes("find_videos")) return videoReply(call);
  if (call.lastUserText.toLowerCase().includes(E2E_SCRIPT.imageTrigger) && call.toolNames.includes("find_images")) return imageReply(call);
  if (call.lastUserText.toLowerCase().includes(E2E_SCRIPT.quickRepliesTrigger) && call.toolNames.includes("suggest_replies"))
    return quickRepliesReply(call);
  const finishing = call.lastUserText.toLowerCase().includes(E2E_SCRIPT.finishTrigger);
  if (call.lastToolResult !== undefined) return {};
  if (call.lastUserText.includes(OUTREACH_REQUEST_TEXT) || call.lastUserText.includes(FLOW_FIRST_MESSAGE_MARK)) return { text: E2E_SCRIPT.morningReply };
  if (finishing)
    return {
      toolCalls: [
        {
          toolName: "finish_dialog",
          input: { goal: "Проверка", stuckAt: "Нет", chosenStep: "Созвон", outcome: "agreed", answer: E2E_SCRIPT.finalReply },
        },
      ],
    };
  if (call.lastUserText.includes(E2E_SCRIPT.longTrigger))
    return { text: `${longReplyBody()} ${E2E_SCRIPT.longReplyEnd}` };
  if (call.system.includes(E2E_SCRIPT.newVersionMark)) return { text: E2E_SCRIPT.newVersionReply };
  if (call.lastUserText.toLowerCase().includes(E2E_SCRIPT.knowledgeTrigger)) return { text: knowledgeReply(call.system) };
  return { text: E2E_SCRIPT.consultantReply };
}

/** Первая строка первой базы знаний в системной части запроса: так видно, что база дошла до модели. */
function knowledgeReply(system: string): string {
  const line = system.match(/<материал[^>]*>\n([^\n]*)/)?.[1];
  return line ? `${E2E_SCRIPT.knowledgeReply} ${line}` : "Материалов эксперта у меня нет.";
}

/** Тело длинного ответа: несколько абзацев, выше любой ленты на экране. */
function longReplyBody(): string {
  return Array.from({ length: 12 }, (_, index) => `Абзац ${index + 1}. Расскажу подробно, как это устроено и что из этого получится у вас.`).join("\n\n");
}

/** Начало роли клиента: так «Автоответ» просит модель ответить за клиента. */
const CLIENT_ROLE_MARK = "Ты играешь человека, который перешёл по ссылке эксперта";

/** В последнем сообщении человека модель получила картинку: так e2e проверяет, что вложение дошло до запроса. */
function sentImage(call: ScriptedCall): boolean {
  const last = call.options.prompt.findLast((message) => message.role === "user");
  return Array.isArray(last?.content) && last.content.some((part) => part.type === "file" && part.mediaType.startsWith("image/"));
}

/** Каталог, где тестовая модель играет конструктора, консультанта и клиента для «Автоответа» — по запросу. */
export function createE2eCatalog(base: ModelCatalog): ModelCatalog {
  const { model } = createScriptedModel((call) => {
    if (call.system.includes(CLIENT_ROLE_MARK)) return { text: E2E_SCRIPT.clientAutoreply };
    if (sentImage(call)) return { text: E2E_SCRIPT.imageSeen };
    return call.toolNames.includes("edit_lead_magnet") ? constructorReply(call) : consultantReply(call);
  });
  return createStubModelCatalog(base, model);
}
