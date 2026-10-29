import { getEditorServices } from "@/modules/editor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = async (request: Request) => (await getEditorServices()).constructor.fetch(request);

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
