import { LineDecision } from "@/lib/types";

export interface ParseIndexedDecisionsResult {
  decisions: LineDecision[];
  /** Indices that were absent from the LLM response and defaulted to KEEP. */
  missingIndices: number[];
}

/** Shape of a single decision from the tool call JSON. */
interface ToolDecision {
  index: number;
  action: "KEEP" | "REMOVE" | "TRIM";
  trimmed_text?: string;
}

/**
 * Parse the LLM's tool-call JSON output into LineDecision[].
 *
 * The response is now JSON from the submit_edit_decisions tool call:
 *   { "decisions": [{ "index": 0, "action": "KEEP" }, ...] }
 *
 * Falls back to the legacy regex parser for backward compatibility.
 *
 * Lines not listed default to KEEP (safe fallback — never silently cut content).
 * Missing indices are recorded in missingIndices so callers can warn/flag them.
 */
export function parseIndexedDecisions(
  response: string,
  totalLines: number,
  startIndex: number
): ParseIndexedDecisionsResult {
  // Try JSON (tool calling format) first
  const trimmed = response.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { decisions?: ToolDecision[] };
      if (Array.isArray(parsed.decisions)) {
        return buildFromToolDecisions(parsed.decisions, totalLines, startIndex);
      }
    } catch {
      // JSON parse failed — fall through to legacy parser
    }
  }

  // Legacy regex parser for backward compatibility
  return parseLegacyFormat(response, totalLines, startIndex);
}

function buildFromToolDecisions(
  toolDecisions: ToolDecision[],
  totalLines: number,
  startIndex: number
): ParseIndexedDecisionsResult {
  const decisionMap = new Map<number, LineDecision>();

  for (const d of toolDecisions) {
    const action = d.action.toLowerCase() as "keep" | "remove" | "trim";

    if (action === "trim" && !d.trimmed_text) {
      // TRIM without text => treat as KEEP (safe fallback)
      decisionMap.set(d.index, { index: d.index, action: "keep" });
    } else {
      decisionMap.set(d.index, {
        index: d.index,
        action,
        ...(action === "trim" && d.trimmed_text ? { text: d.trimmed_text } : {}),
      });
    }
  }

  return fillMissing(decisionMap, totalLines, startIndex);
}

function parseLegacyFormat(
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

  // Parse each line. Format: [index] ACTION[: text] [// rationale]
  const linePattern = /^\[(\d+)\]\s+(KEEP|REMOVE|TRIM)(.*)?$/i;

  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(linePattern);
    if (!match) continue;

    const index = parseInt(match[1], 10);
    const action = match[2].toLowerCase() as "keep" | "remove" | "trim";

    // Parse optional ": text" and optional "// rationale" from the rest of the line
    let rest = (match[3] ?? "").trim();
    let text: string | undefined;
    let rationale: string | undefined;

    if (rest.startsWith(":")) rest = rest.slice(1).trim();

    const commentIdx = rest.indexOf(" // ");
    if (commentIdx !== -1) {
      const beforeComment = rest.slice(0, commentIdx).trim();
      text = beforeComment || undefined;
      rationale = rest.slice(commentIdx + 4).trim() || undefined;
    } else if (rest.startsWith("// ")) {
      rationale = rest.slice(3).trim() || undefined;
    } else {
      text = rest || undefined;
    }

    if (action === "trim" && !text) {
      // TRIM without text => treat as KEEP (safe fallback)
      decisionMap.set(index, { index, action: "keep", ...(rationale ? { rationale } : {}) });
    } else {
      decisionMap.set(index, {
        index,
        action,
        ...(text ? { text } : {}),
        ...(rationale ? { rationale } : {}),
      });
    }
  }

  return fillMissing(decisionMap, totalLines, startIndex);
}

function fillMissing(
  decisionMap: Map<number, LineDecision>,
  totalLines: number,
  startIndex: number
): ParseIndexedDecisionsResult {
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
