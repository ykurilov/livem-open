import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Клик по вкладке до гидратации страницы пропадает. Поэтому сначала ждём гидратацию, затем клик,
 * затем проверка, что вкладка выбрана и (если заданы `ready`) её содержимое появилось.
 */
export async function openTab(page: Page, name: string, ...ready: Locator[]): Promise<void> {
  const tab = page.getByRole("tab", { name, exact: true });
  await expect(async () => {
    const hydrated = await tab.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps$")), undefined, { timeout: 2000 });
    expect(hydrated).toBe(true);
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click({ timeout: 2000 });
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
    for (const locator of ready) await expect(locator).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 45_000 });
}

/** Открывает панель конструктора кнопкой в шапке редактора (у лидмагнита с черновиком она по умолчанию закрыта). */
export async function openConstructor(page: Page): Promise<Locator> {
  const panel = page.getByRole("region", { name: "Конструктор", exact: true });
  const toggle = page.getByRole("button", { name: "Конструктор", exact: true });
  await expect(async () => {
    if (!(await panel.isVisible())) await toggle.click({ timeout: 2000 });
    await expect(panel).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 45_000 });
  return panel;
}
