"use client";

import { useState } from "react";
import {
  AppStep,
  TranscriptEntry,
  LineDecision,
  EditableWord,
  WordTiming,
  SpeakerMap,
} from "@/lib/types";
import { computeFinalClips } from "@/lib/export";
import { validateAssembledOutput, ValidationResult, ClipInput } from "@/app/actions/validate-assembly";
import { autoDetectSpeakers } from "@/lib/speaker-utils";
import FileBrowser from "@/components/file-browser";
import PromptStep from "@/components/prompt-step";
import VideoEditor from "@/components/video-editor";
import ExportStep from "@/components/export-step";

/** Strip punctuation + lowercase for fuzzy word matching */
function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Build a flat array of EditableWords from the transcript and LLM decisions.
 *
 * - "remove" utterances: all words marked removed=true
 * - "keep" utterances: all words marked removed=false
 * - "trim" utterances: greedy forward scan to match trimmed text against source
 *   words (non-contiguous OK); unmatched words marked removed; on failure keep all.
 *
 * If an utterance has no word-level data, timestamps are interpolated
 * evenly across the utterance duration as a fallback.
 */
/**
 * Greedy forward token matcher with concatenation fallback.
 *
 * Handles tokenization mismatches between the LLM's TRIM text and Deepgram's
 * word-level tokens. For example:
 *   LLM writes "530k"      — Deepgram has ["530", "k"]      → pool concat
 *   LLM writes "1,200,000" — Deepgram has ["1,200,000.0"]   → trim concat
 *
 * For each trim token, tries in order:
 *   1. Direct match
 *   2. Concatenate up to 3 consecutive pool tokens → trim token
 *   3. Concatenate up to 3 consecutive trim tokens → pool token
 *   4. Skip pool token (no match at this position)
 *
 * Returns a Set of pool indices that were matched (i.e., should be kept).
 */
function greedyMatch(trimTokens: string[], poolNorm: string[]): Set<number> {
  const kept = new Set<number>();
  let si = 0; // current pool position

  for (let ti = 0; ti < trimTokens.length; ti++) {
    const trimWord = trimTokens[ti];
    let matched = false;

    while (si < poolNorm.length && !matched) {
      if (poolNorm[si] === trimWord) {
        // 1. Direct match
        kept.add(si); si++; matched = true;
      } else {
        // 2. Pool concat: "530" + "k" === "530k"
        let poolConcat = poolNorm[si];
        let poolConcatMatched = false;
        for (let k = 1; k <= 2 && si + k < poolNorm.length; k++) {
          poolConcat += poolNorm[si + k];
          if (poolConcat === trimWord) {
            for (let m = 0; m <= k; m++) kept.add(si + m);
            si += k + 1;
            poolConcatMatched = true;
            break;
          }
        }
        if (poolConcatMatched) { matched = true; break; }

        // 3. Trim concat: "1,200,000" + "." === "1,200,000."
        let trimConcat = trimWord;
        let trimConcatMatched = false;
        for (let k = 1; k <= 2 && ti + k < trimTokens.length; k++) {
          trimConcat += trimTokens[ti + k];
          if (trimConcat === poolNorm[si]) {
            kept.add(si); si++;
            ti += k; // skip the consumed trim tokens
            trimConcatMatched = true;
            break;
          }
        }
        if (trimConcatMatched) { matched = true; break; }

        // 4. No match at this pool position — skip
        si++;
      }
    }
  }

  return kept;
}

function buildEditableWords(
  transcript: TranscriptEntry[],
  decisions: LineDecision[],
  anchorRanges: Array<{ start: number; end: number }> = []
): EditableWord[] {
  const decisionMap = new Map(decisions.map((d) => [d.index, d]));
  const allWords: EditableWord[] = [];

  // Helper: get word timings for a transcript entry, synthesising if missing.
  const getSourceWords = (seg: TranscriptEntry): WordTiming[] =>
    seg.words && seg.words.length > 0
      ? seg.words
      : seg.text
          .split(/\s+/)
          .filter(Boolean)
          .map((w, i, arr) => {
            const d = (seg.end - seg.start) / arr.length;
            return { word: w, start: seg.start + i * d, end: seg.start + (i + 1) * d };
          });

  // ── Pre-compute removedIndices for every utterance ──────────────────────────
  //
  // When the LLM merges adjacent utterances it puts the combined TRIM text on
  // index N and marks N+1, N+2, … as REMOVE. The old matcher only looked at
  // utterance N's words, so the trim tokens that came from N+1/N+2 caused the
  // match to fail and fall back to "keep all". This pre-pass fixes that by
  // expanding the word pool through subsequent consecutive REMOVE'd utterances.
  //
  const LOOKAHEAD = 10;
  const MATCH_THRESHOLD = 0.8;
  type Removal = "all" | "none" | Set<number>;
  const resolvedRemovals = new Map<number, Removal>();

  for (let i = 0; i < transcript.length; i++) {
    if (resolvedRemovals.has(i)) continue; // already set by a prior expanded match

    const decision = decisionMap.get(i);
    const action = decision?.action ?? "keep";

    if (action === "remove") {
      resolvedRemovals.set(i, "all");
      continue;
    }

    if (action === "keep" || !decision?.text) {
      resolvedRemovals.set(i, "none");
      continue;
    }

    // action === "trim"
    const sourceWords = getSourceWords(transcript[i]);
    const trimTokens = decision.text.split(/\s+/).filter(Boolean).map(normalizeWord);
    const normSource = sourceWords.map((w) => normalizeWord(w.word));

    // Greedy forward scan against utterance i alone
    const kept = greedyMatch(trimTokens, normSource);
    const matchPct = trimTokens.length > 0 ? kept.size / trimTokens.length : 0;
    const matchPassed = matchPct >= MATCH_THRESHOLD;

    if (matchPassed) {
      const removed = new Set<number>();
      sourceWords.forEach((_, wi) => { if (!kept.has(wi)) removed.add(wi); });
      resolvedRemovals.set(i, removed);
      continue;
    }

    // ── Expanded match: absorb subsequent consecutive REMOVE'd utterances ────
    type PoolWord = { word: string; utterIdx: number; wordIdx: number };
    const pool: PoolWord[] = sourceWords.map((w, wi) => ({ word: w.word, utterIdx: i, wordIdx: wi }));
    let expandedCount = 0;

    for (let j = i + 1; j < transcript.length && j <= i + LOOKAHEAD; j++) {
      const jAction = (decisionMap.get(j)?.action) ?? "keep";
      if (jAction !== "remove") break;
      getSourceWords(transcript[j]).forEach((w, wi) =>
        pool.push({ word: w.word, utterIdx: j, wordIdx: wi })
      );
      expandedCount++;
    }

    if (expandedCount > 0) {
      const poolNorm = pool.map((pw) => normalizeWord(pw.word));
      const expandedKept = greedyMatch(trimTokens, poolNorm);
      const expandedMatchPct = trimTokens.length > 0 ? expandedKept.size / trimTokens.length : 0;
      const expandedPassed = expandedMatchPct >= MATCH_THRESHOLD;

      if (expandedPassed) {
        // Tally which pool positions are removed per utterance
        const uttWordCount = new Map<number, number>();
        const uttRemovedSet = new Map<number, Set<number>>();
        pool.forEach((pw, poolIdx) => {
          uttWordCount.set(pw.utterIdx, (uttWordCount.get(pw.utterIdx) ?? 0) + 1);
          if (!expandedKept.has(poolIdx)) {
            if (!uttRemovedSet.has(pw.utterIdx)) uttRemovedSet.set(pw.utterIdx, new Set());
            uttRemovedSet.get(pw.utterIdx)!.add(pw.wordIdx);
          }
        });

        for (const uttIdx of new Set(pool.map((pw) => pw.utterIdx))) {
          const total = uttWordCount.get(uttIdx) ?? 0;
          const removedSet = uttRemovedSet.get(uttIdx) ?? new Set<number>();
          if (removedSet.size === 0) resolvedRemovals.set(uttIdx, "none");
          else if (removedSet.size >= total) resolvedRemovals.set(uttIdx, "all");
          else resolvedRemovals.set(uttIdx, removedSet);
        }
        continue;
      }
    }

    // All match attempts failed — keep all words of utterance i
    resolvedRemovals.set(i, "none");
  }

  // ── Build EditableWord array using pre-computed removals ───────────────────
  transcript.forEach((seg, utteranceIdx) => {
    const decision = decisionMap.get(utteranceIdx);
    const sourceWords = getSourceWords(seg);
    const removedIndices: Removal = resolvedRemovals.get(utteranceIdx) ?? "none";
    const isAnchored = anchorRanges.some(
      (r) => utteranceIdx >= r.start && utteranceIdx <= r.end
    );

    sourceWords.forEach((w, wi) => {
      const removedByLLM =
        removedIndices === "all"
          ? true
          : removedIndices === "none"
          ? false
          : (removedIndices as Set<number>).has(wi);

      // Anchor ranges are always kept, regardless of LLM decision
      const removed = isAnchored ? false : removedByLLM;

      allWords.push({
        id: `${utteranceIdx}-${wi}`,
        text: w.word,
        removed,
        start: w.start,
        end: w.end,
        utteranceIdx,
        confidence: w.confidence,
        speaker: w.speaker,
        // Propagate fragment warning and rationale to the first word only
        ...(wi === 0 && decision?.fragmentWarning ? { fragmentWarning: true } : {}),
        ...(wi === 0 && decision?.rationale ? { rationale: decision.rationale } : {}),
        ...(isAnchored ? { anchored: true } : {}),
      });
    });
  });

  return allWords;
}


// ─── Filler token set ────────────────────────────────────────────────────────

const FILLER_TOKENS = new Set([
  "yeah","okay","ok","mhmm","so","right","now","well","alright","yep","great",
  "perfect","cool","sure","wow","hmm","uh","um","oh","and","but","or","we",
  "wanna","value","got","it","absolutely","totally","exactly","correct",
  "nice","awesome","good","fine","yes","no","hey","hi","bye","cheers",
]);

/**
 * Returns true if ALL non-empty tokens in the text are filler words.
 */
function isAllFiller(text: string): boolean {
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => FILLER_TOKENS.has(t));
}

/**
 * FIX 1 — Filler clip strip pass.
 *
 * Scans kept word runs. If a run is:
 *   - shorter than 1.5 seconds, AND
 *   - 3 words or fewer, AND
 *   - composed entirely of filler tokens
 * → marks those words as removed.
 *
 * Runs AFTER buildEditableWords, BEFORE the editor renders.
 */
function stripFillerClips(words: EditableWord[]): EditableWord[] {
  const result = [...words];
  const n = result.length;

  let i = 0;
  while (i < n) {
    if (result[i].removed) { i++; continue; }

    // Find this kept run
    let j = i;
    while (j < n && !result[j].removed) j++;
    // run is result[i..j-1]

    const runWords = result.slice(i, j);
    const duration = (runWords[runWords.length - 1].end) - runWords[0].start;
    const text = runWords.map((w) => w.text).join(" ");

    if (duration < 1.5 && runWords.length <= 3 && isAllFiller(text) && !runWords.some((w) => w.anchored)) {
      for (let k = i; k < j; k++) result[k] = { ...result[k], removed: true };
    }

    i = j;
  }

  return result;
}


// ─── Sentence boundary repair ────────────────────────────────────────────────

/** True if the string ends with terminal punctuation (ignoring trailing quotes/parens). */
function hasTerminalPunctuation(text: string): boolean {
  return /[.?!][)"'\]]*\s*$/.test(text.trimEnd());
}

/** True if word is a conjunction/preposition that signals a fragment start. */
const FRAGMENT_STARTERS = new Set([
  "or","and","but","so","because","that","which","where","when","if","for",
  "with","about","after","before","nor","yet","as","than","though","although",
]);

/** Words that continue a number (e.g. "530 k", "145 leads"). */
const NUMBER_CONTINUATIONS = new Set([
  "k","m","b","million","billion","thousand","dollars","percent",
  "leads","sessions","months","weeks","days","years","people","customers",
  "calls","hours","minutes","percent","x","times","per","a","%",
]);

/**
 * FIX 2 — Sentence boundary repair pass.
 *
 * For each pair of adjacent kept runs separated by a removed gap:
 *  - If gap ≤ 10 words: auto-merge by un-removing the gap words.
 *  - If gap > 10 words: set boundaryWarning on the first word of clip B.
 *
 * Triggers when:
 *  1. Clip A ends without terminal punctuation, OR
 *  2. Clip B starts with a lowercase word (not "I") or a FRAGMENT_STARTER, OR
 *  3. Clip A ends with a bare number and gap starts with a number-continuation token.
 */
function repairBoundaryFragments(words: EditableWord[]): EditableWord[] {
  const result = [...words];
  const n = result.length;

  // Build list of kept runs: { start, end } indices (inclusive)
  const runs: { start: number; end: number }[] = [];
  let i = 0;
  while (i < n) {
    if (result[i].removed) { i++; continue; }
    let j = i;
    while (j < n && !result[j].removed) j++;
    runs.push({ start: i, end: j - 1 });
    i = j;
  }

  for (let r = 0; r + 1 < runs.length; r++) {
    const a = runs[r];
    const b = runs[r + 1];

    const gapStart = a.end + 1;
    const gapEnd = b.start - 1;
    const gapWords = result.slice(gapStart, gapEnd + 1);

    if (gapWords.length === 0) continue; // adjacent — no gap

    const clipAText = result.slice(a.start, a.end + 1).map((w) => w.text).join(" ");
    const clipBFirstWord = result[b.start].text;
    const clipBFirstNorm = clipBFirstWord.toLowerCase().replace(/[^a-z]/g, "");

    const aEndsWithoutPunct = !hasTerminalPunctuation(clipAText);
    const bStartsFragment =
      (clipBFirstWord !== "I" && clipBFirstWord === clipBFirstWord.toLowerCase() && /^[a-z]/.test(clipBFirstWord)) ||
      FRAGMENT_STARTERS.has(clipBFirstNorm);

    // Number-continuation check: last word of A is a digit string
    const aLastWord = result[a.end].text.replace(/[^0-9]/g, "");
    const gapFirstNorm = gapWords[0]?.text.toLowerCase().replace(/[^a-z%]/g, "") ?? "";
    const aEndsWithNumber = /^\d+$/.test(aLastWord);
    const gapStartsWithContinuation = NUMBER_CONTINUATIONS.has(gapFirstNorm);

    const shouldMerge =
      (aEndsWithoutPunct || bStartsFragment || (aEndsWithNumber && gapStartsWithContinuation));

    if (!shouldMerge) continue;

    if (gapWords.length <= 10) {
      // Auto-merge: un-remove the gap
      const gapText = gapWords.map((w) => w.text).join(" ");

      for (let k = gapStart; k <= gapEnd; k++) {
        result[k] = { ...result[k], removed: false };
      }
      // Extend run A to cover the newly kept gap + B so we don't re-check it
      runs[r] = { start: a.start, end: b.end };
      runs.splice(r + 1, 1);
      r--; // re-check this run against its new next neighbor
    } else {
      // Gap too large to auto-merge — flag clip B for editor review
      result[b.start] = { ...result[b.start], boundaryWarning: true };
    }
  }

  return result;
}


// ─── Assembly validation helpers ─────────────────────────────────────────────

const GAP_CONTEXT_WORDS = 20; // how many removed words to show as context

interface ClipSegment {
  clipIndex: number;       // 0-based sequential index
  startWordIdx: number;
  endWordIdx: number;
  durationSeconds: number;
  text: string;
  beforeContext: string | null; // last ≤20 words of removed content before this clip
  afterContext: string | null;  // first ≤20 words of removed content after this clip
}

/**
 * Build an ordered list of kept-word runs from the current word state.
 * Includes surrounding removed-word context for use by the coherence validator.
 * Pure read — does not mutate anything.
 */
function buildClipSegments(words: EditableWord[]): ClipSegment[] {
  const segments: ClipSegment[] = [];
  let clipIndex = 0;
  let i = 0;
  while (i < words.length) {
    if (words[i].removed) { i++; continue; }
    let j = i;
    while (j < words.length && !words[j].removed) j++;

    const run = words.slice(i, j);

    // Collect up to GAP_CONTEXT_WORDS removed words immediately before this run
    const beforeWords: string[] = [];
    for (let k = i - 1; k >= 0 && beforeWords.length < GAP_CONTEXT_WORDS; k--) {
      if (!words[k].removed) break; // hit a kept word = different clip, stop
      beforeWords.unshift(words[k].text);
    }

    // Collect up to GAP_CONTEXT_WORDS removed words immediately after this run
    const afterWords: string[] = [];
    for (let k = j; k < words.length && afterWords.length < GAP_CONTEXT_WORDS; k++) {
      if (!words[k].removed) break;
      afterWords.push(words[k].text);
    }

    segments.push({
      clipIndex,
      startWordIdx: i,
      endWordIdx: j - 1,
      durationSeconds: run[run.length - 1].end - run[0].start,
      text: run.map((w) => w.text).join(" "),
      beforeContext: beforeWords.length > 0 ? beforeWords.join(" ") : null,
      afterContext:  afterWords.length  > 0 ? afterWords.join(" ")  : null,
    });

    clipIndex++;
    i = j;
  }
  return segments;
}

/**
 * Apply coherence validation results to the word array.
 *
 * - removeClips  → flip removed=true for all words in that clip range
 * - flagClips    → set coherenceWarning=true on all words in that clip range
 *
 * Word-level timestamps are never touched.
 */
function applyCoherenceResults(
  words: EditableWord[],
  segments: ClipSegment[],
  result: ValidationResult
): EditableWord[] {
  if (result.removeClips.length === 0 && result.flagClips.length === 0) return words;

  const removeSet = new Set(result.removeClips);
  const flagSet = new Set(result.flagClips);

  // Build word-index → clip-index for kept words
  const wordToClip = new Map<number, number>();
  for (const seg of segments) {
    for (let wi = seg.startWordIdx; wi <= seg.endWordIdx; wi++) {
      wordToClip.set(wi, seg.clipIndex);
    }
  }

  return words.map((w, wi) => {
    if (w.removed) return w;
    const clipIdx = wordToClip.get(wi);
    if (clipIdx === undefined) return w;
    if (removeSet.has(clipIdx)) return { ...w, removed: true };
    if (flagSet.has(clipIdx))   return { ...w, coherenceWarning: true };
    return w;
  });
}

export default function Home() {
  const [step, setStep] = useState<AppStep>("browse");
  const [filePath, setFilePath] = useState("");
  const [fileName, setFileName] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [duration, setDuration] = useState(0);
  const [fps, setFps] = useState(30);
  const [speakerMap, setSpeakerMap] = useState<SpeakerMap>({});
  const [versionWords, setVersionWords] = useState<EditableWord[][]>([[], [], []]);
  const [activeVersion, setActiveVersion] = useState(0);
  const [fcpxmlPath, setFcpxmlPath] = useState<string>("");
  const [coherenceChecking, setCoherenceChecking] = useState(false);

  const handleTranscribeComplete = (
    t: TranscriptEntry[],
    d: number,
    frameRate: number = 30,
    videoPath: string = "",
    stereo?: boolean
  ) => {
    if (videoPath) {
      setFilePath(videoPath);
      setFileName(videoPath.split("/").pop() || videoPath);
    }
    setTranscript(t);
    setDuration(d);
    setFps(frameRate);
    if (stereo) {
      setSpeakerMap({ 0: "Host", 1: "Caller" });
    } else {
      const detected = autoDetectSpeakers(t);
      const remapped: SpeakerMap = Object.fromEntries(
        Object.entries(detected).map(([k, v]) => [Number(k), v === "Guest" ? "Caller" : v])
      );
      setSpeakerMap(remapped);
    }
    setStep("prompt");
  };

  const handlePromptComplete = async (allDecisions: LineDecision[][]) => {
    setCoherenceChecking(true);
    setActiveVersion(0);

    // Build all versions
    const perVersion = allDecisions.map((decisions) => {
      const raw = buildEditableWords(transcript, decisions);
      const defiltered = stripFillerClips(raw);
      const repaired = repairBoundaryFragments(defiltered);
      const segments = buildClipSegments(repaired);
      const clipInputs: ClipInput[] = segments.map((s) => ({
        clipIndex: s.clipIndex,
        text: s.text,
        beforeContext: s.beforeContext,
        afterContext: s.afterContext,
      }));
      return { repaired, segments, clipInputs };
    });

    // Run coherence validation
    const validationResults = await Promise.all(
      perVersion.map(({ clipInputs }) => validateAssembledOutput(clipInputs))
    );

    const cleanedVersions = perVersion.map(({ repaired, segments }, i) =>
      applyCoherenceResults(repaired, segments, validationResults[i])
    );

    setCoherenceChecking(false);
    setVersionWords(cleanedVersions);
    setStep("edit");
  };


  const stepLabels: { key: AppStep; label: string }[] = [
    { key: "browse", label: "1. Transcribe" },
    { key: "prompt", label: "2. Clip" },
    { key: "edit", label: "3. Edit" },
    { key: "export", label: "4. Export" },
  ];

  const stepOrder = stepLabels.map((s) => s.key);
  const currentIdx = stepOrder.indexOf(step);

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      {/* Top bar */}
      <div className="border-b border-neutral-800 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center gap-4">
          <span className="text-lg font-bold tracking-tight">✂️ CLIPPER</span>
          <div className="flex items-center gap-1.5 ml-4">
            {stepLabels.map((s, i) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    const targetIdx = stepOrder.indexOf(s.key);
                    if (targetIdx <= currentIdx) setStep(s.key);
                  }}
                  disabled={stepOrder.indexOf(s.key) > currentIdx}
                  className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                    step === s.key
                      ? "bg-violet-600 text-white font-medium"
                      : stepOrder.indexOf(s.key) < currentIdx
                      ? "text-neutral-400 hover:text-neutral-200 cursor-pointer"
                      : "text-neutral-700 cursor-not-allowed"
                  }`}
                >
                  {s.label}
                </button>
                {i < stepLabels.length - 1 && (
                  <span className="text-neutral-800">→</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Coherence checking overlay — shown while validation runs after prompt step */}
      {coherenceChecking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 px-8 py-6 rounded-xl bg-neutral-900 border border-neutral-700">
            <div className="w-5 h-5 rounded-full border-2 border-violet-500 border-t-transparent animate-spin" />
            <span className="text-sm text-neutral-200 font-medium">Checking coherence…</span>
            <span className="text-xs text-neutral-500">Reviewing the assembled edit as a viewer would see it</span>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        {step === "browse" && (
          <FileBrowser onComplete={handleTranscribeComplete} fcpxmlPath={fcpxmlPath} onFcpxmlSelected={setFcpxmlPath} />
        )}

        {step === "prompt" && (
          <PromptStep
            transcript={transcript}

            speakerMap={speakerMap}
            onComplete={handlePromptComplete}
          />
        )}

        {step === "edit" && (
          <>
            {/* Version tabs */}
            {versionWords.length > 1 && (
              <div className="flex gap-1 mb-4">
                {versionWords.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveVersion(i)}
                    className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
                      activeVersion === i
                        ? "bg-violet-600 text-white"
                        : "bg-neutral-800 text-neutral-400 hover:text-white"
                    }`}
                  >
                    Version {i + 1}
                  </button>
                ))}
              </div>
            )}
            <VideoEditor
              words={versionWords[activeVersion] ?? []}
              onChange={(updated) =>
                setVersionWords((prev) => prev.map((v, i) => (i === activeVersion ? updated : v)))
              }
              onContinue={() => setStep("export")}
              videoSrc={filePath ? `/api/video?path=${encodeURIComponent(filePath)}` : undefined}
              fileName={fileName}
              duration={duration}
            />
          </>
        )}

        {step === "export" && (
          <ExportStep
            versionWords={versionWords}
            fileName={fileName}
            filePath={filePath}
            fps={fps}
            duration={duration}
            transcript={transcript}
            fcpxmlPath={fcpxmlPath}
            speakerMap={speakerMap}
          />
        )}
      </div>
    </main>
  );
}
