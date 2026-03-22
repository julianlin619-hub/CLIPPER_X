import { getFrameTimeFormat } from "@/lib/timecode";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate FCPXML 1.8 from kept segments.
 * Uses simple flat <asset-clip> elements — no compound clip wrappers.
 * Ported from OLDER project where this approach worked reliably.
 */
function sanitizeRole(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "track";
}

export function generateFCPXML(
  segments: { start: number; end: number; text: string }[],
  sourceName: string,
  duration: number,
  fps: number = 30,
  sourceFilePath?: string,
  speakerLabels?: [string, string]
): string {
  const { frameDuration, frameNum, frameDenom } = getFrameTimeFormat(fps);
  const ch1Role = `dialogue.${sanitizeRole(speakerLabels?.[0] ?? "Speaker")}`;
  const ch2Role = `dialogue.${sanitizeRole(speakerLabels?.[1] ?? "Guest")}`;
  const trimmedSource = sourceName.trim();
  const cleanName = trimmedSource.replace(/\.\w+$/, "").trim();
  // Use absolute path if available; file:// URLs require three slashes for absolute paths
  const srcUrl = sourceFilePath
    ? `file://${sourceFilePath.startsWith("/") ? "" : "/"}${escapeXml(sourceFilePath)}`
    : `file://./${escapeXml(trimmedSource)}`;

  let offsetFrames = 0;

  const clipElements = segments
    .map((seg) => {
      const startFrame = Math.round(seg.start * fps);
      const endFrame = Math.ceil(seg.end * fps);
      const durFrames = Math.max(1, endFrame - startFrame);

      const offsetStr = `${offsetFrames * frameNum}/${frameDenom}s`;
      const startStr  = `${startFrame  * frameNum}/${frameDenom}s`;
      const durStr    = `${durFrames   * frameNum}/${frameDenom}s`;

      offsetFrames += durFrames;

      return `            <asset-clip ref="r1" offset="${offsetStr}" name="${escapeXml(seg.text.trim().substring(0, 60))}" start="${startStr}" duration="${durStr}" tcFormat="NDF">
              <audio-channel-source srcCh="1" role="${ch1Role}" />
              <audio-channel-source srcCh="2" role="${ch2Role}" />
              <note>${escapeXml(seg.text)}</note>
            </asset-clip>`;
    })
    .join("\n");

  const totalDurStr  = `${offsetFrames * frameNum}/${frameDenom}s`;
  const assetDurFrames = Math.ceil(duration * fps);
  const assetDurStr  = `${assetDurFrames * frameNum}/${frameDenom}s`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.8">
  <resources>
    <format id="r0" frameDuration="${frameDuration}" width="1920" height="1080" />
    <asset id="r1" name="${escapeXml(cleanName)}" src="${srcUrl}" start="0/${frameDenom}s" duration="${assetDurStr}" hasVideo="1" hasAudio="1" audioSources="2" audioChannels="2" audioRate="48000" format="r0" />
  </resources>
  <library>
    <event name="${escapeXml(cleanName)}">
      <project name="${escapeXml(cleanName)} - Edited">
        <sequence format="r0" duration="${totalDurStr}" tcStart="0/${frameDenom}s" tcFormat="NDF">
          <spine>
${clipElements}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}
