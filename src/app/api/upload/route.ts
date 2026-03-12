import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import os from "os";

const UPLOAD_DIR = path.join(os.tmpdir(), "clipper-uploads");

export async function POST(req: NextRequest) {
  try {
    await mkdir(UPLOAD_DIR, { recursive: true });

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const destPath = path.join(UPLOAD_DIR, `${Date.now()}_${safeName}`);

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(destPath, buffer);

    return NextResponse.json({ path: destPath, name: file.name });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 500 }
    );
  }
}
