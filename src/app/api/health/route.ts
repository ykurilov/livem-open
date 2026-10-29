import { getDatabase } from "@/modules/platform/db";
import { checkDatabase, createHealthHandler } from "@/modules/platform/health";
import { getWebQueue } from "@/modules/platform/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = createHealthHandler({
  checkDatabase: () => checkDatabase(getDatabase()),
  checkQueue: async () => (await getWebQueue()).ping(),
});

export const GET = () => handler();
