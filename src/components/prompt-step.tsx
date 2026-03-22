"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { TranscriptEntry, LineDecision, SpeakerMap, WordTiming } from "@/lib/types";
import { parseIndexedDecisions } from "@/lib/llm";
import { Button } from "@/components/ui/button";
import { DEFAULT_EDIT_PROMPT } from "@/prompts/default-edit";

interface Props {
  transcript: TranscriptEntry[];
  speakerMap?: SpeakerMap;
  onComplete: (allDecisions: LineDecision[][]) => void;
}

interface PreviewMessage {
  speaker: number | null;
  text: string;
}

type SubStep = "idle" | "streaming" | "done";

/** Decision line regex — matches [N] KEEP / REMOVE / TRIM: text */
const DECISION_RE = /^\[(\d+)\]\s+(KEEP|REMOVE|TRIM)(?:\s*:\s*(.*))?$/i;

/** Returns the dominant speaker ID across all words in an utterance (majority vote). */
function getUtteranceSpeaker(words: WordTiming[] | undefined): number | null {
  const counts = new Map<number, number>();
  for (const w of words ?? []) {
    if (w.speaker != null) counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Milliseconds between each revealed word */
const WORD_INTERVAL_MS = 35;

export default function PromptStep({ transcript, speakerMap, onComplete }: Props) {
  const [subStep, setSubStep] = useState<SubStep>("idle");
  const [previewMessages, setPreviewMessages] = useState<PreviewMessage[]>([]);
  const [displayTexts, setDisplayTexts] = useState<string[]>([]);
  const [rawDecision, setRawDecision] = useState<string>("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Scroll to bottom when a new bubble appears
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [previewMessages.length]);

  // Word-by-word reveal for the latest message
  useEffect(() => {
    if (previewMessages.length === 0) return;

    if (animTimerRef.current) {
      clearTimeout(animTimerRef.current);
      animTimerRef.current = null;
    }

    const newIdx = previewMessages.length - 1;
    const words = previewMessages[newIdx].text.split(/\s+/).filter(Boolean);
    let wordIdx = 0;

    setDisplayTexts(() => previewMessages.map((m, i) => (i < newIdx ? m.text : "")));

    const tick = () => {
      wordIdx++;
      setDisplayTexts(prev => {
        const next = [...prev];
        next[newIdx] = words.slice(0, wordIdx).join(" ");
        return next;
      });
      if (wordIdx < words.length) {
        animTimerRef.current = setTimeout(tick, WORD_INTERVAL_MS);
      } else {
        animTimerRef.current = null;
      }
    };

    animTimerRef.current = setTimeout(tick, WORD_INTERVAL_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMessages.length]);

  // Snap display texts when streaming ends
  useEffect(() => {
    if (!streaming) {
      if (animTimerRef.current) {
        clearTimeout(animTimerRef.current);
        animTimerRef.current = null;
      }
      setDisplayTexts(previewMessages.map(m => m.text));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  // ── Generate edit using default prompt ───────────────────────────────────
  const handleGenerate = useCallback(async () => {
    setError(null);
    setPreviewMessages([]);
    setDisplayTexts([]);
    setRawDecision("");
    setStreaming(true);
    setSubStep("streaming");

    try {
      const res = await fetch("/api/clip-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, prompt: DEFAULT_EDIT_PROMPT, speakerMap, temperature: 0.3 }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let lineBuffer = "";
      let accumulated = "";

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const match = trimmed.match(DECISION_RE);
        if (!match) return;

        const idx = parseInt(match[1], 10);
        const action = match[2].toUpperCase();
        const trimText = match[3]?.trim();
        const speaker = idx < transcript.length ? getUtteranceSpeaker(transcript[idx].words) : null;

        if (action === "KEEP" && idx < transcript.length) {
          setPreviewMessages(prev => [...prev, { speaker, text: transcript[idx].text }]);
        } else if (action === "TRIM" && trimText) {
          setPreviewMessages(prev => [...prev, { speaker, text: trimText }]);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      if (lineBuffer.trim()) processLine(lineBuffer);

      setRawDecision(accumulated);
      setSubStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setSubStep("idle");
    } finally {
      setStreaming(false);
    }
  }, [transcript, speakerMap]);

  // ── Confirm ───────────────────────────────────────────────────────────────
  const handleConfirm = useCallback(() => {
    const { decisions } = parseIndexedDecisions(rawDecision, transcript.length, 0);
    onComplete([decisions]);
  }, [rawDecision, transcript.length, onComplete]);

  // ── Reset to idle ─────────────────────────────────────────────────────────
  const handleRestart = useCallback(() => {
    if (animTimerRef.current) {
      clearTimeout(animTimerRef.current);
      animTimerRef.current = null;
    }
    setSubStep("idle");
    setPreviewMessages([]);
    setDisplayTexts([]);
    setRawDecision("");
    setStreaming(false);
    setError(null);
  }, []);

  // ── Render: idle ──────────────────────────────────────────────────────────
  if (subStep === "idle") {
    return (
      <div>
        <h2 className="text-2xl font-bold mb-1">Build Your Clip</h2>
        <p className="text-neutral-400 mb-6 text-sm">
          AI edits the transcript into clips for you to review.
        </p>
        {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
        <Button onClick={handleGenerate} className="px-6">
          Generate Edit
        </Button>
      </div>
    );
  }

  // ── Render: streaming / done ──────────────────────────────────────────────
  const isDone = subStep === "done";
  const origWordCount = transcript
    .map(t => t.text.trim().split(/\s+/).filter(Boolean).length)
    .reduce((a, b) => a + b, 0);
  const keptWordCount = previewMessages.reduce(
    (acc, m) => acc + m.text.trim().split(/\s+/).filter(Boolean).length, 0
  );

  return (
    <div>
      <h2 className="text-2xl font-bold mb-1">Clip Preview</h2>
      <p className="text-neutral-400 mb-4 text-sm">
        {streaming ? "Generating clip…" : isDone ? "Review the clip below, then continue to editing." : ""}
      </p>

      {/* Chat preview */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-950 overflow-hidden mb-5">
        <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 bg-neutral-900 shrink-0">
          <span className="text-xs font-medium text-neutral-400">Preview</span>
          {isDone && (
            <span className="text-xs text-neutral-600">
              {keptWordCount}/{origWordCount} ({origWordCount > 0 ? Math.round((keptWordCount / origWordCount) * 100) : 0}%)
            </span>
          )}
        </div>

        <div className="p-3 space-y-2 overflow-y-auto" style={{ maxHeight: "400px" }}>
          {previewMessages.length === 0 ? (
            <div className="flex items-center gap-2 text-neutral-600 text-xs py-2">
              <span className="inline-block w-0.5 h-3.5 bg-violet-400 animate-pulse align-middle" />
              <span>Waiting…</span>
            </div>
          ) : (
            previewMessages.map((msg, i) => {
              const isRight = msg.speaker != null && speakerMap?.[msg.speaker] !== "Host";
              const isLast = i === previewMessages.length - 1;
              const text = displayTexts[i] ?? "";
              const speakerLabel =
                msg.speaker != null
                  ? (speakerMap?.[msg.speaker] ?? `Speaker ${msg.speaker}`)
                  : "Speaker";
              const isAnimating = text.length < msg.text.length;

              return (
                <div
                  key={i}
                  className={`flex flex-col gap-0.5 ${isRight ? "items-end" : "items-start"}`}
                >
                  <span className="text-[9px] text-neutral-600 px-1">{speakerLabel}</span>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                      isRight
                        ? "bg-violet-600 text-white rounded-br-sm"
                        : "bg-neutral-700 text-neutral-100 rounded-bl-sm"
                    }`}
                  >
                    {text}
                    {(isAnimating || (isLast && streaming)) && (
                      <span className="inline-block w-0.5 h-3 bg-current animate-pulse ml-1 align-middle opacity-70" />
                    )}
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

      {/* Actions */}
      <div
        className="flex gap-3 transition-opacity duration-500"
        style={{ opacity: isDone ? 1 : 0, pointerEvents: isDone ? "auto" : "none" }}
      >
        <Button onClick={handleConfirm} disabled={!rawDecision} className="px-6">
          Looks good — continue to edit
        </Button>
        <Button
          variant="outline"
          onClick={handleRestart}
          className="px-6 border-neutral-700 text-neutral-300 hover:text-white"
        >
          Start over
        </Button>
      </div>

      {isDone && (
        <p className="text-xs text-neutral-600 mt-4">
          On the next step you can fine-tune individual words before exporting.
        </p>
      )}
    </div>
  );
}
