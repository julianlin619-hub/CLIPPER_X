import { LineDecision, SpeakerMap } from "@/lib/types";

/**
 * Build the user message for the LLM edit step.
 * Each line is prefixed with [index] and its speaker label so the LLM
 * can reference utterances by index in its decision output.
 *
 * If a speakerMap is provided (e.g. {0: "Host", 1: "Guest"}), resolved names
 * are used instead of the raw "Speaker N" fallback.
 */
export function buildCreativeMessage(
  lines: { index: number; text: string; speaker?: number | null }[],
  segmentTitle?: string,
  segmentSummary?: string,
  speakerMap?: SpeakerMap
): string {
  const context = segmentTitle
    ? `## Segment: ${segmentTitle}${segmentSummary ? `\n${segmentSummary}` : ""}\n\n`
    : "";

  const lineList = lines
    .map((l) => {
      const label =
        l.speaker != null
          ? (speakerMap?.[l.speaker] ?? `Speaker ${l.speaker}`)
          : "Speaker";
      return `[${l.index}] ${label}: ${l.text}`;
    })
    .join("\n");

  return `${context}## Transcript\n${lineList}`;
}

export interface ParseIndexedDecisionsResult {
  decisions: LineDecision[];
  /** Indices that were absent from the LLM response and defaulted to KEEP. */
  missingIndices: number[];
}

/**
 * Parse the LLM's index-based decision output into LineDecision[].
 *
 * Expected format (one per line):
 *   [0] REMOVE
 *   [1] KEEP
 *   [2] TRIM: Some trimmed text here
 *
 * Lines not listed default to KEEP (safe fallback — never silently cut content).
 * Missing indices are recorded in missingIndices so callers can warn/flag them.
 * Robust: ignores blank lines, commentary, and markdown fences.
 */
export function parseIndexedDecisions(
  response: string,
  totalLines: number,
  startIndex: number
): ParseIndexedDecisionsResult {
  const decisionMap = new Map<number, LineDecision>();

  // Strip markdown code fences if present
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
  }

  // Parse each line
  const linePattern = /^\[(\d+)\]\s+(KEEP|REMOVE|TRIM)(?:\s*:\s*(.*))?$/i;

  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(linePattern);
    if (!match) continue;

    const index = parseInt(match[1], 10);
    const action = match[2].toLowerCase() as "keep" | "remove" | "trim";
    const text = match[3]?.trim() || undefined;

    if (action === "trim" && !text) {
      // TRIM without text => treat as KEEP (safe fallback)
      decisionMap.set(index, { index, action: "keep" });
    } else {
      decisionMap.set(index, { index, action, ...(text ? { text } : {}) });
    }
  }

  // Fill in missing indices as KEEP (safe default -- never silently cut content)
  const decisions: LineDecision[] = [];
  const missingIndices: number[] = [];

  for (let i = 0; i < totalLines; i++) {
    const idx = startIndex + i;
    if (decisionMap.has(idx)) {
      decisions.push(decisionMap.get(idx)!);
    } else {
      missingIndices.push(idx);
      decisions.push({ index: idx, action: "keep" });
    }
  }

  if (missingIndices.length > 0) {
    console.warn(
      `Warning: ${missingIndices.length} ${missingIndices.length === 1 ? "index" : "indices"} had no LLM decision, defaulting to KEEP: [${missingIndices.join(", ")}]`
    );
  }

  return { decisions, missingIndices };
}
