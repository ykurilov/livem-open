"use client";

import { russianFlowLabels } from "@ykurilov/agent-chat-flows/labels";

const { editor, notices, migrate } = russianFlowLabels;

/**
 * Product wording through the SDK's supported localization contract. Дни сценария в кабинете — «дни воронки».
 * Слова эксперта, а не программиста: «этап», а не «состояние»; «схема», а не «граф»; «тестовый прогон».
 */
export const flowLabels = {
  ...russianFlowLabels,
  editor: {
    ...editor,
    header: {
      ...editor.header,
      state: "Этап",
      check: "Проверить схему",
      run: "Тестовый прогон",
      saveFailedHint: "Сохранение отклонено. Что не так — в «Проверить схему» и на карточках этапов.",
    },
    events: { ...editor.events, tool: "Консультант выполнил действие" },
    timerSpans: { ...editor.timerSpans, in_state: "Время на этом этапе" },
    anyStatePanel: {
      ...editor.anyStatePanel,
      // Название остаётся коротким «Общие переходы»: длинное выталкивает «Тестовый чат» за край панели на 1280
      hint: "Работают на любом этапе. Переходы самого этапа проверяются раньше.",
    },
    runPanel: {
      ...editor.runPanel,
      title: "Тестовый прогон",
      hint: "Тестовый прогон: выбирайте справа, что произошло",
      finish: "Закончить тестовый прогон",
      step: (step: number) => `Тестовый прогон · шаг ${step}`,
      noStart: "Нет первого этапа: отметьте, с чего начинается сценарий",
    },
    jsonDialog: { ...editor.jsonDialog, title: "Схема в формате JSON" },
    board: {
      ...editor.board,
      anyState: "С любого этапа",
      newState: "Новый этап",
      fit: "Вся схема",
      nudgesUntilProgramDay: (day: number) => `до дня ${day} воронки`,
      noSideQuestions: "Без попутных вопросов",
      nudges: "напоминания",
      noNudges: "без напоминаний",
    },
    overview: {
      ...editor.overview,
      common: "Общее для всех этапов",
      commonHint: "Роль, тон, цены, условия, ссылки — то, что верно на любом этапе.",
      states: "Этапов",
      afterEndHints: {
        ...editor.overview.afterEndHints,
        reply: "Агент отвечает по общей части: знает, что воронка закончилась, не ведёт по шагам и не продаёт повторно.",
      },
    },
    schedule: {
      ...editor.schedule,
      maxPerDayByDay: "Не больше в день по дням воронки",
      nudges: "Напоминания по умолчанию",
    },
    nudges: { ...editor.nudges, on: "Общие напоминания" },
    nudgesSection: {
      ...editor.nudgesSection,
      title: "Напоминания",
      hint: "Агент пишет сам, когда человек молчит. Так на всех этапах, где не заданы свои напоминания.",
      hintWithSchedule: "Агент пишет сам, когда человек молчит. Так на всех этапах, где не заданы свои напоминания. Ночью напоминания ждут начала дня.",
    },
    statePanel: {
      ...editor.statePanel,
      title: "Этап",
      learn: "Узнать на этом этапе",
      deleteState: "Удалить этап",
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
      nudgesDaysHint: "Затем действуют общие напоминания: утреннее сообщение и общий ряд с начала.",
      nudgesDaysHintNoSchedule: "Затем действуют общие напоминания, их ряд с начала.",
      inheritedNudges: "Общие напоминания:",
      inheritedNone: "Общих напоминаний нет: на этом этапе агент первым не пишет.",
    },
  },
  migrate: {
    ...migrate,
    hint: "Чаты продолжат с того же этапа. Закончившиеся разговоры и тестовые чаты остаются на своей версии. Для удалённых этапов выберите, куда перевести.",
    state: "Этап",
    chooseTarget: "Выберите этап",
  },
  notices: {
    ...notices,
    farewell: "прощание: срок воронки вышел",
    silence: "напоминание после молчания",
  },
};
