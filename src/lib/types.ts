// Word-level timestamp from Deepgram
export interface WordTiming {
  word: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: number | null;
}

// Transcript entry (utterance from Deepgram)
export interface TranscriptEntry {
  start: number;
  end: number;
  text: string;
  words?: WordTiming[];
}

// LLM edit decisions — per transcript utterance
export type SegmentAction = "keep" | "remove" | "trim";

export interface LineDecision {
  index: number;
  action: SegmentAction;
  text?: string; // trimmed text when action === "trim"
  /** Set by the fragment-validation pass when the output text appears to start mid-sentence. */
  fragmentWarning?: boolean;
  /** Brief rationale from the LLM explaining the decision, parsed from inline // comment. */
  rationale?: string;
}

// A single word in the editable transcript.
// Every word carries its own Deepgram start/end timestamp.
// Removing a word excludes exactly that time range from the FCPXML.
export interface EditableWord {
  id: string;
  text: string;
  removed: boolean;
  start: number;           // word-level timestamp from Deepgram (required)
  end: number;             // word-level timestamp from Deepgram (required)
  utteranceIdx: number;    // which source utterance this word belongs to (display grouping only)
  confidence?: number;
  speaker?: number | null;
  /** Propagated from LineDecision.fragmentWarning — marks the first word of a potentially mid-sentence utterance. */
  fragmentWarning?: boolean;
  /** Set when this word belongs to a user-selected hook or payoff anchor — cannot be removed. */
  anchored?: boolean;
/** LLM rationale for this word's utterance decision, propagated to the first word of each utterance. */
  rationale?: string;
}

// Speaker name map: Deepgram speaker ID → human-readable label (e.g. "Host", "Guest")
export type SpeakerMap = Record<number, string>;

// App step flow
export type AppStep = "browse" | "prompt" | "edit" | "export";

