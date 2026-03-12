import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
};

export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath) {
    return new NextResponse("Missing path", { status: 400 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return new NextResponse("File not found", { status: 404 });
  }

  const fileSize = stat.size;
  const rangeHeader = req.headers.get("range");

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      return new NextResponse("Invalid range", { status: 416 });
    }
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    const stream = fs.createReadStream(filePath, { start, end });
    const webStream = new ReadableStream({
      start(controller) {
        stream.on("data", (chunk) => controller.enqueue(chunk));
        stream.on("end", () => controller.close());
        stream.on("error", (err) => controller.error(err));
      },
      cancel() { stream.destroy(); },
    });

    return new NextResponse(webStream, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunkSize),
      },
    });
  }

  const stream = fs.createReadStream(filePath);
  const webStream = new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => controller.enqueue(chunk));
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() { stream.destroy(); },
  });

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(fileSize),
    },
  });
}
