import { leadMagnetToFlow } from "../flows/settings-to-flow";
import { newLeadMagnetSettings, type LeadMagnetSettings } from "../lead-magnets/settings";
import type { SalesCard } from "./sales-cards";

/** Лидмагнит из двух этапов («Знакомство», «Продажа») с заготовками — для тестов. */
export function settingsWithCards(salesCards: SalesCard[]): LeadMagnetSettings {
  const base = newLeadMagnetSettings("Лидмагнит с заготовками");
  const stages = [
    { id: "intro", name: "Знакомство", instruction: "Узнай задачу", transitionCondition: "Человек назвал задачу", startDay: null, isSale: false },
    { id: "sale", name: "Продажа", instruction: "Предложи курс", transitionCondition: "", startDay: null, isSale: true },
  ];
  const flow = leadMagnetToFlow({ name: base.name, instruction: "", stages, program: null, fieldIds: [], viewsLinks: false }, []);
  return { ...base, stages, flow, salesCards };
}

export const priceCard: SalesCard = {
  id: "c-price",
  stateId: "sale",
  title: "Цена курса",
  when: "Человек спросил, сколько стоит курс",
  text: "Курс стоит 9 900 ₽, оплата по ссылке https://pay.example.com/course",
  verbatim: true,
};

export const doubtCard: SalesCard = {
  id: "c-doubt",
  stateId: null,
  title: "Не уверен, что получится",
  when: "Человек сомневается, что справится",
  text: "Первые две недели куратор разбирает каждое задание лично.",
  verbatim: false,
};
