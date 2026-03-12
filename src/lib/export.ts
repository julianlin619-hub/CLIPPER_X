import { EditableWord, TranscriptEntry } from "@/lib/types";
import { getFrameTimeFormat } from "@/lib/timecode";

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

/**
 * Merge consecutive kept words into contiguous clips.
 *
 * A new clip starts wherever one or more removed words create a gap.
 * Words are processed in their original order, so the output is a
 * time-ordered list of { start, end, text } clips ready for FCPXML.
 */
export function computeFinalClips(
  words: EditableWord[]
): { start: number; end: number; text: string }[] {
  const clips: { start: number; end: number; text: string }[] = [];
  let current: { start: number; end: number; words: string[] } | null = null;

  for (const word of words) {
    if (word.removed) {
      if (current) {
        clips.push({ start: current.start, end: current.end, text: current.words.join(" ") });
        current = null;
      }
    } else {
      if (!current) {
        current = { start: word.start, end: word.end, words: [word.text] };
      } else {
        current.end = word.end;
        current.words.push(word.text);
      }
    }
  }
  if (current) {
    clips.push({ start: current.start, end: current.end, text: current.words.join(" ") });
  }

  return clips;
}

/**
 * Generate a plain-text transcript from all words (raw/original).
 */
export function generateRawTranscript(words: EditableWord[]): string {
  const lines: string[] = [];
  let lastSpeaker: number | null | undefined = undefined;

  for (const word of words) {
    if (word.speaker !== lastSpeaker) {
      if (lines.length > 0) lines.push("");
      lines.push(`Speaker ${word.speaker ?? "?"}:`);
      lastSpeaker = word.speaker;
    }
    // append word to the last line
    const last = lines.length - 1;
    lines[last] = lines[last] + " " + word.text;
  }

  return lines.map((l) => l.trim()).join("\n");
}

/**
 * Generate a plain-text transcript from only the kept (non-removed) words.
 */
export function generateEditedTranscript(words: EditableWord[]): string {
  return generateRawTranscript(words.filter((w) => !w.removed));
}

/**
 * Generate a human-readable debug report showing every kept vs cut block.
 */
export function generateDebugTXT(
  words: EditableWord[],
  fileName: string,
  totalDuration: number
): string {
  const clips = computeFinalClips(words);
  const exportedDuration = clips.reduce((a, c) => a + (c.end - c.start), 0);
  const cutDuration = totalDuration - exportedDuration;
  const pctKept = totalDuration > 0 ? Math.round((exportedDuration / totalDuration) * 100) : 0;
  const keptWords = words.filter((w) => !w.removed).length;
  const removedWords = words.filter((w) => w.removed).length;

  const lines: string[] = [];
  const hr = "─".repeat(60);

  lines.push("CLIPPER EXPORT DEBUG REPORT (word-level)");
  lines.push("═".repeat(60));
  lines.push(`File:              ${fileName}`);
  lines.push(`Original duration: ${fmt(totalDuration)}`);
  lines.push(`Exported duration: ${fmt(exportedDuration)}  (${pctKept}% kept)`);
  lines.push(`Cut:               ${fmt(cutDuration)}  (${100 - pctKept}% removed)`);
  lines.push(`Total words:       ${words.length}  (kept: ${keptWords}, removed: ${removedWords})`);
  lines.push(`Output clips:      ${clips.length}  (each clip = contiguous run of kept words)`);
  lines.push("");
  lines.push("═".repeat(60));
  lines.push("TIMELINE  (K=kept, X=cut)");
  lines.push(hr);

  // Group consecutive same-state words into blocks for readability
  type Block = { kind: "keep" | "cut"; words: EditableWord[] };
  const blocks: Block[] = [];
  let cur: Block | null = null;

  for (const word of words) {
    const kind: "keep" | "cut" = word.removed ? "cut" : "keep";
    if (!cur || cur.kind !== kind) {
      if (cur) blocks.push(cur);
      cur = { kind, words: [word] };
    } else {
      cur.words.push(word);
    }
  }
  if (cur) blocks.push(cur);

  let clipNum = 0;
  for (const block of blocks) {
    const start = block.words[0].start;
    const end = block.words[block.words.length - 1].end;
    const dur = (end - start).toFixed(2);
    const text = block.words.map((w) => w.text).join(" ");

    if (block.kind === "keep") {
      clipNum++;
      lines.push(`[K #${clipNum.toString().padStart(3, "0")}]  ${fmt(start)} → ${fmt(end)}  (${dur}s)`);
      lines.push(`         "${text}"`);
    } else {
      lines.push(`[X CUT]  ${fmt(start)} → ${fmt(end)}  (${dur}s)`);
      lines.push(`         "${text}"`);
    }
    lines.push("");
  }

  lines.push(hr);
  lines.push(`END — ${clipNum} clips · ${fmt(exportedDuration)} kept of ${fmt(totalDuration)} total`);

  return lines.join("\n");
}

// ─── Speaker-turn helpers ────────────────────────────────────────────────────

export interface SpeakerTurn {
  turnIdx: number;
  speaker: string;
  originalText: string; // full merged text of all utterances in this turn
  keptText: string;     // joined kept word tokens
  action: "keep" | "remove" | "trim";
}

/**
 * Merge consecutive same-speaker Deepgram utterances into speaker turns,
 * then compute a KEEP/REMOVE/TRIM action for each turn based on the
 * actual word-level state (post-editor).
 *
 * This mirrors the structure of the DEFAULT_EDIT_PROMPT examples, where
 * each [index] is a complete speaker turn rather than a Deepgram micro-utterance.
 */
function buildSpeakerTurns(
  transcript: TranscriptEntry[],
  words: EditableWord[]
): SpeakerTurn[] {
  // Map utteranceIdx → { kept[], total }
  const uttKept = new Map<number, string[]>();
  const uttTotal = new Map<number, number>();
  for (const word of words) {
    if (!uttTotal.has(word.utteranceIdx)) {
      uttTotal.set(word.utteranceIdx, 0);
      uttKept.set(word.utteranceIdx, []);
    }
    uttTotal.set(word.utteranceIdx, (uttTotal.get(word.utteranceIdx) ?? 0) + 1);
    if (!word.removed) uttKept.get(word.utteranceIdx)!.push(word.text);
  }

  // Speaker label per utterance
  const uttSpeaker = transcript.map((entry) => {
    const spk = entry.words?.[0]?.speaker ?? null;
    return spk != null ? `Speaker ${spk}` : "Speaker";
  });

  // Merge consecutive same-speaker utterances
  type Acc = {
    speaker: string;
    originalTexts: string[];
    keptWords: string[];
    totalWords: number;
  };

  const merged: Acc[] = [];
  for (let i = 0; i < transcript.length; i++) {
    const spk = uttSpeaker[i];
    const keptWds = uttKept.get(i) ?? [];
    const total = uttTotal.get(i) ?? 0;
    const last = merged[merged.length - 1];
    if (last && last.speaker === spk) {
      last.originalTexts.push(transcript[i].text);
      last.keptWords.push(...keptWds);
      last.totalWords += total;
    } else {
      merged.push({
        speaker: spk,
        originalTexts: [transcript[i].text],
        keptWords: [...keptWds],
        totalWords: total,
      });
    }
  }

  return merged.map((turn, idx) => {
    const action: "keep" | "remove" | "trim" =
      turn.keptWords.length === 0
        ? "remove"
        : turn.keptWords.length === turn.totalWords
        ? "keep"
        : "trim";
    return {
      turnIdx: idx,
      speaker: turn.speaker,
      originalText: turn.originalTexts.join(" "),
      keptText: turn.keptWords.join(" "),
      action,
    };
  });
}



// ─── Public generators ────────────────────────────────────────────────────────

/**
 * Generate a numbered raw transcript in the prompt-example format:
 *   [0] Speaker 0: Hello there.
 *   [1] Speaker 1: Right.
 * Consecutive same-speaker Deepgram utterances are merged into one turn.
 */
export function generateExampleTranscript(
  transcript: TranscriptEntry[],
  words: EditableWord[]
): string {
  return buildSpeakerTurns(transcript, words)
    .map((t) => `[${t.turnIdx}] ${t.speaker}: ${t.originalText}`)
    .join("\n");
}

/**
 * Generate the decisions block in the prompt-example format, derived from
 * speaker turns (so they match the Final Transcript Preview):
 *   [0] KEEP
 *   [1] REMOVE
 *   [2] TRIM: trimmed text here
 */
export function generateExampleDecisions(
  words: EditableWord[],
  transcript: TranscriptEntry[]
): string {
  return buildSpeakerTurns(transcript, words)
    .map((t) => {
      if (t.action === "keep") return `[${t.turnIdx}] KEEP`;
      if (t.action === "remove") return `[${t.turnIdx}] REMOVE`;
      return `[${t.turnIdx}] TRIM: ${t.keptText}`;
    })
    .join("\n");
}

// ─── XML alignment debug ─────────────────────────────────────────────────────

function toFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

function fmtFrameTime(frames: number, fps: number, frameDenom: number, frameNum: number): string {
  const secs = (frames / fps).toFixed(3);
  return `${frames * frameNum}/${frameDenom}s  (frame ${frames}, ${secs}s)`;
}

/**
 * Generate a word-level XML alignment debug file.
 * For every word shows: kept/cut status, source frame range, timeline offset,
 * and which clip number it lands in — so you can trace exactly how words
 * map into the FCPXML timeline.
 */
export function generateXmlAlignmentDebug(
  words: EditableWord[],
  fileName: string,
  duration: number,
  fps: number = 30
): string {
  const { frameDuration, frameNum, frameDenom } = getFrameTimeFormat(fps);

  const clips = computeFinalClips(words);
  const assetDurFrames = Math.ceil(duration * fps);

  // Map word id → clip index
  const wordToClip = new Map<string, number>();
  {
    let clipIdx = 0;
    let inClip = false;
    for (const word of words) {
      if (!word.removed) {
        if (!inClip) { inClip = true; }
        wordToClip.set(word.id, clipIdx);
      } else {
        if (inClip) { clipIdx++; inClip = false; }
      }
    }
  }

  // Pre-compute per-clip timeline offset (in frames)
  const clipOffsets: number[] = [];
  let offsetFrames = 0;
  for (let i = 0; i < clips.length; i++) {
    clipOffsets.push(offsetFrames);
    const startF = toFrames(clips[i].start, fps);
    const rawEnd = Math.ceil(clips[i].end * fps);
    const endF = i === clips.length - 1 ? Math.min(rawEnd, assetDurFrames) : rawEnd;
    offsetFrames += Math.max(1, endF - startF);
  }

  const hr = "─".repeat(90);
  const dhr = "═".repeat(90);
  const lines: string[] = [];

  lines.push("CLIPPER — XML ALIGNMENT DEBUG");
  lines.push(dhr);
  lines.push(`File:         ${fileName}`);
  lines.push(`Duration:     ${fmt(duration)}`);
  lines.push(`FPS:          ${fps}  (frameDuration=${frameDuration})`);
  lines.push(`Asset frames: ${assetDurFrames}  = ${assetDurFrames * frameNum}/${frameDenom}s`);
  lines.push(`Total words:  ${words.length}  |  Output clips: ${clips.length}`);
  lines.push("");
  lines.push("CLIP SUMMARY");
  lines.push(hr);

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const startF = toFrames(c.start, fps);
    const rawEnd = Math.ceil(c.end * fps);
    const endF = i === clips.length - 1 ? Math.min(rawEnd, assetDurFrames) : rawEnd;
    const dur = Math.max(1, endF - startF);
    lines.push(`Clip #${String(i + 1).padStart(3, "0")}  source [${startF}→${endF}]  dur=${dur}f  timeline_offset=${clipOffsets[i]}f`);
    lines.push(`         FCPXML: start="${startF * frameNum}/${frameDenom}s"  duration="${dur * frameNum}/${frameDenom}s"  offset="${clipOffsets[i] * frameNum}/${frameDenom}s"`);
    lines.push(`         text: "${c.text.substring(0, 100)}"`);
    lines.push("");
  }

  lines.push(dhr);
  lines.push("WORD-BY-WORD ALIGNMENT");
  lines.push("  STATUS   CLIP  | SRC_START→SRC_END (frames / seconds)      | TIMELINE_OUT_FRAME | WORD");
  lines.push(hr);

  let prevClipIdx = -1;
  let wordInClip = 0;

  for (const word of words) {
    const startF = toFrames(word.start, fps);
    const endF = Math.ceil(word.end * fps);

    if (word.removed) {
      lines.push(
        `  [CUT]   ----  | ${String(startF).padStart(6)}→${String(endF).padStart(6)}` +
        `  (${word.start.toFixed(3)}s→${word.end.toFixed(3)}s)  | ------             | "${word.text}"`
      );
    } else {
      const clipIdx = wordToClip.get(word.id) ?? 0;

      if (clipIdx !== prevClipIdx) {
        if (prevClipIdx !== -1) lines.push("");
        lines.push(
          `  ┌── CLIP #${String(clipIdx + 1).padStart(3, "0")}  ` +
          `FCPXML offset="${clipOffsets[clipIdx] * frameNum}/${frameDenom}s"  ` +
          `(frame ${clipOffsets[clipIdx]})  source_start="${toFrames(clips[clipIdx].start, fps) * frameNum}/${frameDenom}s"`
        );
        prevClipIdx = clipIdx;
        wordInClip = 0;
      }

      wordInClip++;
      const clipSrcStart = toFrames(clips[clipIdx].start, fps);
      const wordOffsetInClip = startF - clipSrcStart;
      const wordTimelineFrame = clipOffsets[clipIdx] + wordOffsetInClip;

      lines.push(
        `  [KEPT]  #${String(clipIdx + 1).padStart(3, "0")}  | ${String(startF).padStart(6)}→${String(endF).padStart(6)}` +
        `  (${word.start.toFixed(3)}s→${word.end.toFixed(3)}s)  | ≈${String(wordTimelineFrame).padStart(6)}f          | w${wordInClip}: "${word.text}"`
      );
    }
  }

  lines.push(hr);
  lines.push(`END — ${clips.length} clips | ${words.filter(w => !w.removed).length} kept words | ${words.filter(w => w.removed).length} cut words`);

  return lines.join("\n");
}

