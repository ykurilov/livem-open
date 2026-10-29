import { describe, expect, it } from "vitest";
import { buildConsultantInstruction } from "../consultant/instruction";
import { newLeadMagnetSettings, newProgramSettings, type LeadMagnetSettings } from "../lead-magnets/settings";
import { buildProgramInstructionSection } from "./instruction-section";
import { leadMagnetToFlow } from "../flows/settings-to-flow";

const stage = (id: string, extra: Partial<LeadMagnetSettings["stages"][number]> = {}) => ({
  id,
  name: id,
  instruction: `Инструкция ${id}`,
  transitionCondition: `Условие ${id}`,
  startDay: null,
  isSale: false,
  ...extra,
});

const oldProgram: LeadMagnetSettings = {
  ...newLeadMagnetSettings("Первое приложение"),
  instruction: "Ты ведёшь человека к первому приложению.",
  endCondition: "Человек сказал «да» курсу",
  stages: [stage("start"), stage("build", { startDay: 2 }), stage("sale", { startDay: 3, isSale: true })],
  program: {
    ...newProgramSettings(3),
    sideTasks: [
      { id: "city", task: "Узнать город", fieldId: null, when: "" },
      { id: "review", task: "Попросить короткий отзыв", fieldId: "00000000-0000-4000-8000-000000000001", when: "когда доволен" },
    ],
  },
  fieldIds: ["00000000-0000-4000-8000-000000000001"],
};
/** Те же настройки со сценарием: правила продажи ищут ноду с меткой «продажа», программу — «Дни и время». */
const program: LeadMagnetSettings = { ...oldProgram, flow: leadMagnetToFlow(oldProgram, []) };

describe("раздел программы в инструкции консультанта", () => {
  it("программа: назвал город — пояс записывается всегда, даже когда время как в служебной строке (eval 14.10: Казань)", () => {
    expect(buildConsultantInstruction(program)).toMatch(/назвал[^\n]*город[^\n]*flow_time_zone[^\n]*даже если[^\n]*Казань — Europe\/Moscow/i);
  });

  it("без продажи раздела нет; без программы — обычное правило завершения", () => {
    const plainOld = { ...oldProgram, program: null, stages: oldProgram.stages.map((s) => ({ ...s, startDay: null, isSale: false })) };
    const plain = { ...plainOld, flow: leadMagnetToFlow(plainOld, []) };
    expect(buildProgramInstructionSection(plain)).toBeNull();
    expect(buildConsultantInstruction(plain)).not.toMatch(/программ/i);
    expect(buildConsultantInstruction(plain)).toMatch(/«подумаю»[^\n]*«не сейчас»[^\n]*declined/i);
  });

  it("дни, пояс, рамки дня, этапы и попутные задачи объясняет сценарий SDK, а не наш раздел", () => {
    const instruction = buildConsultantInstruction(program);
    expect(instruction).not.toMatch(/5:00|set_time_zone|end_day|side_task|go_to_stage/);
  });

  it("правила продажи — только если есть этап «Продажа»", () => {
    expect(buildProgramInstructionSection(program)).toMatch(/продаж/i);
    const noSaleOld = { ...oldProgram, stages: oldProgram.stages.map((s) => ({ ...s, isSale: false })) };
    const noSale = { ...noSaleOld, flow: leadMagnetToFlow(noSaleOld, []) };
    expect(buildProgramInstructionSection(noSale)).toBeNull();
    expect(buildConsultantInstruction(noSale)).not.toMatch(/sale_answer/);
  });

  it("продажа как у хорошего продавца: твёрдое «нет» принять, мягкое — разобрать один раз живыми вопросами (решение 6)", () => {
    const section = buildProgramInstructionSection(program)!;
    expect(section).toMatch(/твёрдое «нет»[^\n]*прими[^\n]*больше не продавай/i);
    expect(section).toMatch(/«прекратите»[^\n]*finish_dialog[^\n]*declined/i);
    expect(section).toMatch(/мягкое «нет»[^\n]*один раз/i);
    expect(section).toMatch(/живы[^\n]*вопрос/i);
    expect(section).toMatch(/слова[^\n]*успехи самого человека/i);
    expect(section).toMatch(/цен[аы] бездействия/i);
    expect(section).toMatch(/шаг поменьше[^\n]*если он есть/i);
    expect(section).toMatch(/снова «нет»[^\n]*помощи без продажи/i);
    expect(section).toMatch(/упёрся[^\n]*последний день[^\n]*с новой стороны/i);
    expect(section).toMatch(/sale_answer[^\n]*цена[^\n]*время[^\n]*неуверенность[^\n]*не интересно/i);
  });

  it("продажа без выдумок и нажима: факты только из инструкции, примеры «как нельзя» — штампы", () => {
    const section = buildProgramInstructionSection(program)!;
    expect(section).toMatch(/не выдумывай[^\n]*цены[^\n]*скидки[^\n]*гарантии[^\n]*истории учеников/i);
    expect(section).toMatch(/рассрочк[^\n]*уточнит/i);
    expect(section).toMatch(/не дави/i);
    expect(section).toMatch(/фальшив[^\n]*срочност/i);
    expect(section).toMatch(/«по сравнению с чем»/);
    expect(section).toMatch(/«что вас останавливает»/);
    expect(section).toMatch(/формулировки[^\n]*меняй|не повторяй[^\n]*формулировк/i);
  });

  it("подробности продукта — формат, группа, записи, доплаты — только из инструкции, даже чтобы успокоить", () => {
    const section = buildProgramInstructionSection(program)!;
    expect(section).toMatch(/групп[^\n]*запис[^\n]*доплат[^\n]*только[^\n]*инструкци[^\n]*этапа/i);
    expect(section).toMatch(/даже чтобы успокоить/i);
  });

  it("последний круг: прощание в последний день — finish_dialog; не продавать в ответе про сбой; «эксперт» — по имени", () => {
    const instruction = buildConsultantInstruction(program);
    expect(instruction).toMatch(/последний день[^\n]*прощани[^\n]*finish_dialog[^\n]*agreed[^\n]*declined/i);
    const section = buildProgramInstructionSection(program)!;
    expect(section).toMatch(/не продавай в ответе[^\n]*сбо/i);
    expect(section).toMatch(/уточнит[^\n]*по имени из инструкции/i);
    expect(section).not.toMatch(/«про рассрочку уточнит эксперт»/);
  });

  it("условия оплаты — тоже подробность продукта: только из инструкции", () => {
    expect(buildProgramInstructionSection(program)!).toMatch(/доплаты, условия оплаты[^\n]*только если она есть в инструкции/i);
  });

  it("в программе отложенное решение и мягкий отказ разговор не завершают; «да» продукту — досрочный конец", () => {
    const instruction = buildConsultantInstruction(program);
    expect(instruction).toContain(buildProgramInstructionSection(program)!);
    expect(instruction).not.toMatch(/«подумаю»[^\n]*«не сейчас»[^\n]*вызови finish_dialog с declined/i);
    expect(instruction).toMatch(/«подумаю»[^\n]*не завершай/i);
    expect(instruction).toMatch(/«да»[^\n]*finish_dialog[^\n]*agreed/i);
  });

  it("agreed — только ясное «да» или конкретное действие; «кажется, в деле» — ещё не согласие", () => {
    const instruction = buildConsultantInstruction(program);
    expect(instruction).toMatch(/agreed[^\n]*только[^\n]*ясно[^\n]*«да»[^\n]*действи/i);
    expect(instruction).toMatch(/перешёл по ссылке|спросил, как оплатить/i);
    expect(instruction).toMatch(/«кажется, в деле»[^\n]*не согласие/i);
  });

  it("«возьму», даже с «наверное», — в этом же ответе ссылка на покупку и как оплатить, без «так что решили?» вместо ссылки", () => {
    const section = buildProgramInstructionSection(program)!;
    expect(section).toMatch(/«возьму»[^\n]*«наверное, возьму»[^\n]*в этом же ответе[^\n]*ссылку на покупку[^\n]*как оплатить/i);
    expect(section).toMatch(/«Так что решили\?» без ссылки[^\n]*нельзя/i);
    expect(buildConsultantInstruction(program)).toMatch(/«наверное, возьму»[^\n]*ссылк/i);
  });

  it("после ссылки на оплату — только обещания из фактов о продукте: не «как оплатите, пойдём по шагам» (eval 21.10)", () => {
    expect(buildProgramInstructionSection(program)!).toMatch(/что будет после покупки[^\n]*только из фактов о продукте[^\n]*«Как оплатите, начнём с установки — пойдём по шагам»/i);
  });

  it("сомнение вопросом о продукте — не «нет»: sale_answer не вызывать", () => {
    expect(buildProgramInstructionSection(program)!).toMatch(/сомнение вопросом[^\n]*«а если не сдам\?»[^\n]*не «нет»[^\n]*sale_answer не вызывай/i);
  });

  it("раздел зависит только от настроек версии: побайтно одинаков при повторной сборке", () => {
    expect(buildConsultantInstruction(structuredClone(program))).toBe(buildConsultantInstruction(program));
  });
});
