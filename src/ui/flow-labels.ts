"use client";

import { russianFlowLabels } from "@ykurilov/agent-chat-flows/react";

const { editor, notices } = russianFlowLabels;

/** Product wording through the SDK's supported localization contract. Дни сценария в кабинете — «дни воронки». */
export const flowLabels = {
  ...russianFlowLabels,
  editor: {
    ...editor,
    board: {
      ...editor.board,
      nudgesUntilProgramDay: (day: number) => `до дня ${day} воронки`,
      noSideQuestions: "Без попутных вопросов",
    },
    overview: {
      ...editor.overview,
      afterEndHints: {
        ...editor.overview.afterEndHints,
        reply: "Агент отвечает по общей части: знает, что воронка закончилась, не ведёт по шагам и не продаёт повторно.",
      },
    },
    schedule: {
      ...editor.schedule,
      maxPerDayByDay: "Не больше в день по дням воронки",
    },
    statePanel: {
      ...editor.statePanel,
      noSideQuestions: "Не задавать здесь попутных вопросов о человеке",
      toolsHint: "Что агент может сделать на этом этапе, кроме ответа. Доступны только отмеченные.",
      tagsHint: "Пометки этапа. «продажа» — этап, где агент предлагает продукт и записывает отказы.",
      noSideQuestionsHint: "На этом этапе агент не уточняет между делом поля карточки человека и не берёт попутных задач.",
      durationHint: "Потом переход «Куда». Новый день начинается в начале дня. «До дня воронки» — до начала этого дня, когда бы человек ни пришёл на этап.",
      durationUnits: { ...editor.statePanel.durationUnits, program_day: "до дня воронки" },
      nudges: "Напоминания",
      nudgesModes: { inherit: "Общие", own: "Для этого этапа", off: "Выключены" },
      nudgesHint: "Агент пишет первым, когда человек молчит.",
      nudgesDays: "Когда действуют напоминания этапа",
      nudgesDaysModes: {
        always: "всё время на этом этапе",
        days: "дней, считая день начала этапа",
        untilProgramDay: "до дня воронки включительно",
      },
      nudgesUntilProgramDayHint: "Дни воронки считаются от начала участия человека в лидмагните. На этом этапе напоминания работают только до указанного дня.",
      nudgesDaysHint: "Затем используются общие напоминания из раздела «Дни и время».",
    },
  },
  notices: {
    ...notices,
    farewell: "прощание: срок воронки вышел",
  },
};
