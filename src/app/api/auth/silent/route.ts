import { createSilentLogin } from "@/modules/access";

export const dynamic = "force-dynamic";

export const GET = createSilentLogin({ env: process.env });
