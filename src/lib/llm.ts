import { LineDecision } from "@/lib/types";

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

