import { NextRequest } from "next/server";
import { existsSync } from "fs";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";
import { spawnPython, SCRIPTS_DIR } from "@/app/api/_lib/spawn-python";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const SCRIPT = path.join(SCRIPTS_DIR, "patch_fcpxml.py");

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    fcpxmlPath: string;
    versions?: { start: number; end: number }[][];
    clips?: { start: number; end: number }[];  // legacy single-version
    videoPath?: string;
  };

  const { fcpxmlPath, videoPath } = body;
  // Normalise: support both multi-version `versions` and legacy `clips`
  const versions: { start: number; end: number }[][] =
    body.versions ?? (body.clips ? [body.clips] : []);

  if (!fcpxmlPath || !existsSync(fcpxmlPath))
    return Response.json({ error: `Multicam FCPXML not found: ${fcpxmlPath}` }, { status: 400 });

  if (!Array.isArray(versions) || versions.length === 0)
    return Response.json({ error: "versions must be a non-empty array" }, { status: 400 });

  const outputPath = path.join(tmpdir(), `clipper-patched-${randomUUID()}.fcpxml`);

  try {
    await spawnPython(SCRIPT, [fcpxmlPath, JSON.stringify(versions), outputPath, videoPath ?? ""]);
    const { readFile } = await import("fs/promises");
    const xml = await readFile(outputPath, "utf-8");
    await unlink(outputPath).catch(() => {});
    return new Response(xml, {
      headers: {
        "Content-Type": "application/xml",
        "Content-Disposition": `attachment; filename="patched_multicam.fcpxml"`,
      },
    });
  } catch (e: unknown) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
