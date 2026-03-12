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
export function generateFCPXML(
  segments: { start: number; end: number; text: string }[],
  sourceName: string,
  duration: number,
  fps: number = 30
): string {
  const { frameDuration, frameNum, frameDenom } = getFrameTimeFormat(fps);
  const trimmedSource = sourceName.trim();
  const cleanName = trimmedSource.replace(/\.\w+$/, "").trim();

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
    <asset id="r1" name="${escapeXml(cleanName)}" src="file://./${escapeXml(trimmedSource)}" start="0/${frameDenom}s" duration="${assetDurStr}" hasVideo="1" hasAudio="1" format="r0" />
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
