import { getFrameTimeFormat } from "@/lib/timecode";
import { Source } from "@/lib/types";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sanitizeRole(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "track";
}

function fileUrl(absPath: string): string {
  return `file://${absPath.startsWith("/") ? "" : "/"}${escapeXml(absPath)}`;
}

/**
 * Generate FCPXML 1.8 from kept segments.
 *
 * A-only (source.angles.length === 1): flat <asset-clip> spine — output is
 * byte-identical to the pre-refactor single-cam path.
 *
 * A+B (source.angles.length === 2): primary cam (audioSource:true) on the
 * spine; secondary cam as a lane-1 connected <asset-clip> child per segment.
 * Secondary has no <audio-channel-source> — only primary's audio plays.
 */
export function generateFCPXML(
  segments: { start: number; end: number; text: string }[],
  source: Source,
  speakerLabels?: [string, string]
): string {
  const primary = source.angles.find((a) => a.audioSource) ?? source.angles[0];
  const secondary = source.angles.find((a) => !a.audioSource);
  const { duration, fps } = source;

  const { frameDuration, frameNum, frameDenom } = getFrameTimeFormat(fps);
  const ch1Role = `dialogue.${sanitizeRole(speakerLabels?.[0] ?? "Speaker")}`;
  const ch2Role = `dialogue.${sanitizeRole(speakerLabels?.[1] ?? "Guest")}`;

  const primaryFileName = primary.filePath.split("/").pop() || primary.filePath;
  const trimmedSource = primaryFileName.trim();
  const cleanName = trimmedSource.replace(/\.\w+$/, "").trim();
  const srcUrl = fileUrl(primary.filePath);

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

      const bClipLine = secondary
        ? `\n              <asset-clip ref="r2" lane="1" offset="${offsetStr}" start="${startStr}" duration="${durStr}" />`
        : "";

      return `            <asset-clip ref="r1" offset="${offsetStr}" name="${escapeXml(seg.text.trim().substring(0, 60))}" start="${startStr}" duration="${durStr}" tcFormat="NDF">
              <audio-channel-source srcCh="1" role="${ch1Role}" />
              <audio-channel-source srcCh="2" role="${ch2Role}" />${bClipLine}
              <note>${escapeXml(seg.text)}</note>
            </asset-clip>`;
    })
    .join("\n");

  const totalDurStr  = `${offsetFrames * frameNum}/${frameDenom}s`;
  const assetDurFrames = Math.ceil(duration * fps);
  const assetDurStr  = `${assetDurFrames * frameNum}/${frameDenom}s`;

  const primaryAssetLine = `    <asset id="r1" name="${escapeXml(cleanName)}" src="${srcUrl}" start="0/${frameDenom}s" duration="${assetDurStr}" hasVideo="1" hasAudio="1" audioSources="2" audioChannels="2" audioRate="48000" format="r0" />`;

  let secondaryAssetLine = "";
  if (secondary) {
    const bFileName = secondary.filePath.split("/").pop() || secondary.filePath;
    const bCleanName = bFileName.trim().replace(/\.\w+$/, "").trim();
    const bSrcUrl = fileUrl(secondary.filePath);
    secondaryAssetLine = `\n    <asset id="r2" name="${escapeXml(bCleanName)}" src="${bSrcUrl}" start="0/${frameDenom}s" duration="${assetDurStr}" hasVideo="1" hasAudio="0" format="r0" />`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.8">
  <resources>
    <format id="r0" frameDuration="${frameDuration}" width="1920" height="1080" />
${primaryAssetLine}${secondaryAssetLine}
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
