import { expect, test, type Locator } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { leadMagnetToFlow } from "../../src/modules/flows/settings-to-flow";
import { createLeadMagnet, getLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { connectDatabase } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

async function camera(viewport: Locator) {
  return viewport.evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });
}

for (const fullscreen of [false, true]) test(`тачпад: scroll перемещает, pinch масштабирует, fullscreen=${fullscreen}`, async ({ page, context }) => {
  test.setTimeout(120_000);
  const connection = connectDatabase(e2eDatabaseUrl(), { poolSize: 1 });
  try {
    const lead = await createLeadMagnet(connection.db, { name: "Проверка жестов холста" });
    const settings = { ...lead.draft, firstMessage: "Здравствуйте!", instruction: "Обсуди идею", stages: [
      { id: "idea", name: "Идея", instruction: "Обсуди идею", transitionCondition: "Идея выбрана", startDay: null, isSale: false },
    ] };
    const flow = leadMagnetToFlow(settings, []);
    await saveDraft(connection.db, lead.id, { ...settings, flow }, "manual");
    const session = { user: { id: "e2e-expert", email: E2E_EMAIL, roles: [] }, accessToken: "e2e", refreshToken: "e2e", accessTokenExpiresAt: Date.now() + 86_400_000 };
    await context.addCookies([{ name: "auth_session", value: await seal(session, E2E_COOKIE_SECRET), url: E2E_BASE_URL }]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/lead-magnets/${lead.id}`);
    const tab = page.getByRole("tab", { name: "Сценарий", exact: true });
    await expect(async () => {
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
    }).toPass({ timeout: 60_000 });
    const board = page.getByRole("tabpanel", { name: "Сценарий", exact: true });
    await expect(board.getByRole("application")).toBeVisible();
    if (fullscreen) await board.locator("[data-flow-fullscreen-toggle]").click();
    const canvas = board.locator(".react-flow");
    const viewport = board.locator(".react-flow__viewport");
    // Wait for automatic fitView to finish before measuring gestures.
    let last = "", stableSince = Date.now();
    await expect.poll(async () => {
      const current = JSON.stringify(await camera(viewport));
      if (current !== last) { last = current; stableSince = Date.now(); }
      return Date.now() - stableSince >= 400;
    }).toBe(true);
    const bounds = (await canvas.boundingBox())!;
    const cursor = { x: Math.round(bounds.x + bounds.width * 0.7), y: Math.round(bounds.y + bounds.height * 0.15) };
    await page.mouse.move(cursor.x, cursor.y);
    const before = await camera(viewport);
    await page.mouse.wheel(100, 140);
    await expect.poll(async () => Math.abs((await camera(viewport)).x - before.x)).toBeGreaterThan(10);
    await expect.poll(async () => Math.abs((await camera(viewport)).y - before.y)).toBeGreaterThan(10);
    expect((await camera(viewport)).zoom).toBeCloseTo(before.zoom, 5);

    const panned = await camera(viewport);
    const anchor = { x: (cursor.x - bounds.x - panned.x) / panned.zoom, y: (cursor.y - bounds.y - panned.y) / panned.zoom };
    await page.keyboard.down("Control");
    try { await page.mouse.wheel(0, 80); } finally { await page.keyboard.up("Control"); }
    await expect.poll(async () => (await camera(viewport)).zoom).toBeLessThan(panned.zoom);
    const zoomed = await camera(viewport);
    expect((cursor.x - bounds.x - zoomed.x) / zoomed.zoom).toBeCloseTo(anchor.x, 1);
    expect((cursor.y - bounds.y - zoomed.y) / zoomed.zoom).toBeCloseTo(anchor.y, 1);
    // Camera gestures must not become edits to the saved scenario.
    const after = (await getLeadMagnet(connection.db, lead.id))!;
    expect(after.draft.flow).toEqual(flow);
    expect(after.publishedSnapshotId).toBeNull();
  } finally { await connection.close(); }
});
