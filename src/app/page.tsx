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





const MIN_CLIP_DURATION = 0.5; // seconds — drop sub-second word fragments from over-aggressive TRIMs

function filterShortClips(words: EditableWord[]): EditableWord[] {
  const result = [...words];
  let i = 0;
  while (i < result.length) {
    if (result[i].removed) { i++; continue; }
    let j = i;
    while (j < result.length && !result[j].removed) j++;
    const duration = result[j - 1].end - result[i].start;
    if (duration < MIN_CLIP_DURATION) {
      for (let k = i; k < j; k++) result[k] = { ...result[k], removed: true };
    }
    i = j;
  }
  return result;
}

export default function Home() {
  const [step, setStep] = useState<AppStep>("browse");
  const [filePath, setFilePath] = useState("");
  const [fileName, setFileName] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [duration, setDuration] = useState(0);
  const [fps, setFps] = useState(30);
  const [speakerMap, setSpeakerMap] = useState<SpeakerMap>({});
  const [versionWords, setVersionWords] = useState<EditableWord[][]>([[]]);
  const [fcpxmlPath, setFcpxmlPath] = useState<string>("");

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

  const handlePromptComplete = (decisions: LineDecision[]) => {
    setVersionWords([filterShortClips(buildEditableWords(transcript, decisions))]);
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
            <VideoEditor
              words={versionWords[0] ?? []}
              onChange={(updated) =>
                setVersionWords([updated])
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
