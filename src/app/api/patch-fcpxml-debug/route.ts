import { NextRequest } from "next/server";
import { existsSync } from "fs";
import path from "path";
import { spawnPython, SCRIPTS_DIR } from "@/app/api/_lib/spawn-python";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const SCRIPT = path.join(SCRIPTS_DIR, "patch_fcpxml_debug.py");

export async function POST(req: NextRequest) {
  const { fcpxmlPath, keptRanges } = await req.json() as {
    fcpxmlPath: string;
    keptRanges: { start: number; end: number }[];
  };

  if (!fcpxmlPath || !existsSync(fcpxmlPath))
    return Response.json({ error: `Multicam FCPXML not found: ${fcpxmlPath}` }, { status: 400 });

  if (!Array.isArray(keptRanges) || keptRanges.length === 0)
    return Response.json({ error: "keptRanges must be a non-empty array" }, { status: 400 });

  try {
    const txt = await spawnPython(SCRIPT, [fcpxmlPath, JSON.stringify(keptRanges)]);
    return new Response(txt, { headers: { "Content-Type": "text/plain" } });
  } catch (e: unknown) {
    // Debug script failures should still return output (may be partial)
    return new Response(String(e), { status: 500, headers: { "Content-Type": "text/plain" } });
  }
}
