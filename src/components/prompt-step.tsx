"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { TranscriptEntry, LineDecision, SpeakerMap } from "@/lib/types";
import { parseIndexedDecisions } from "@/lib/llm";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { DEFAULT_EDIT_PROMPT } from "@/prompts/default-edit";

const NUM_VERSIONS = 3;

interface Props {
  transcript: TranscriptEntry[];
  speakerMap?: SpeakerMap;
  onComplete: (allDecisions: LineDecision[][]) => void;
}

interface PreviewMessage {
  speaker: number | null;
  text: string;
}

type PromptMode = "default" | "custom";
type SubStep = "prompt" | "preview";

/** Decision line regex — matches [N] KEEP / REMOVE / TRIM: text */
const DECISION_RE = /^\[(\d+)\]\s+(KEEP|REMOVE|TRIM)(?:\s*:\s*(.*))?$/i;

/** Milliseconds between each revealed word */
const WORD_INTERVAL_MS = 35;

export default function PromptStep({
  transcript,
  speakerMap,
  onComplete,
}: Props) {
  const [mode, setMode] = useState<PromptMode>("default");
  const [customPrompt, setCustomPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [subStep, setSubStep] = useState<SubStep>("prompt");
  // Per-version streaming state
  const [streaming, setStreaming] = useState(false);
  const [previewMessages, setPreviewMessages] = useState<PreviewMessage[][]>(
    Array.from({ length: NUM_VERSIONS }, () => [])
  );
  const [displayTexts, setDisplayTexts] = useState<string[][]>(
    Array.from({ length: NUM_VERSIONS }, () => [])
  );
  const [rawDecisions, setRawDecisions] = useState<string[]>(Array(NUM_VERSIONS).fill(""));
  const [doneFlags, setDoneFlags] = useState<boolean[]>(Array(NUM_VERSIONS).fill(false));

  const messagesEndRefs = useRef<(HTMLDivElement | null)[]>(Array(NUM_VERSIONS).fill(null));
  const animTimerRefs = useRef<(ReturnType<typeof setTimeout> | null)[]>(Array(NUM_VERSIONS).fill(null));

  const activePrompt = mode === "default" ? DEFAULT_EDIT_PROMPT : customPrompt;
  const allDone = doneFlags.every(Boolean) && !streaming;

  // Scroll each column to bottom when a new bubble appears
  useEffect(() => {
    for (let v = 0; v < NUM_VERSIONS; v++) {
      messagesEndRefs.current[v]?.scrollIntoView({ behavior: "smooth" });
    }
  }, [previewMessages.map(m => m.length).join(",")]);

  // Word-by-word reveal per version
  useEffect(() => {
    for (let v = 0; v < NUM_VERSIONS; v++) {
      const msgs = previewMessages[v];
      if (msgs.length === 0) continue;

      if (animTimerRefs.current[v]) {
        clearTimeout(animTimerRefs.current[v]!);
        animTimerRefs.current[v] = null;
      }

      const newIdx = msgs.length - 1;
      const words = msgs[newIdx].text.split(/\s+/).filter(Boolean);
      let wordIdx = 0;

      setDisplayTexts(prev => {
        const next = prev.map((col, vi) =>
          vi === v ? msgs.map((m, i) => (i < newIdx ? m.text : "")) : col
        );
        return next;
      });

      const tick = (version: number) => () => {
        wordIdx++;
        setDisplayTexts(prev => {
          const next = prev.map((col, vi) => {
            if (vi !== version) return col;
            const updated = [...col];
            updated[newIdx] = words.slice(0, wordIdx).join(" ");
            return updated;
          });
          return next;
        });
        if (wordIdx < words.length) {
          animTimerRefs.current[version] = setTimeout(tick(version), WORD_INTERVAL_MS);
        } else {
          animTimerRefs.current[version] = null;
        }
      };

      animTimerRefs.current[v] = setTimeout(tick(v), WORD_INTERVAL_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMessages.map(m => m.length).join(",")]);

  // Snap display texts when a version finishes streaming
  useEffect(() => {
    if (!streaming) {
      for (let v = 0; v < NUM_VERSIONS; v++) {
        if (animTimerRefs.current[v]) {
          clearTimeout(animTimerRefs.current[v]!);
          animTimerRefs.current[v] = null;
        }
      }
      setDisplayTexts(previewMessages.map(msgs => msgs.map(m => m.text)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  // ── Stream one version ────────────────────────────────────────────────────
  const streamVersion = useCallback(async (versionIdx: number, prompt: string): Promise<string> => {
    const res = await fetch("/api/clip-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, prompt, speakerMap }),
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
      const speaker = idx < transcript.length ? (transcript[idx].words?.[0]?.speaker ?? null) : null;

      if (action === "KEEP" && idx < transcript.length) {
        setPreviewMessages(prev => prev.map((col, vi) =>
          vi === versionIdx ? [...col, { speaker, text: transcript[idx].text }] : col
        ));
      } else if (action === "TRIM" && trimText) {
        setPreviewMessages(prev => prev.map((col, vi) =>
          vi === versionIdx ? [...col, { speaker, text: trimText }] : col
        ));
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

    setDoneFlags(prev => prev.map((d, i) => i === versionIdx ? true : d));
    return accumulated;
  }, [transcript, speakerMap]);

  // ── Apply prompt — fires all 3 in parallel ────────────────────────────────
  const handleApplyPrompt = useCallback(async () => {
    if (!activePrompt.trim()) return;
    setError(null);
    setPreviewMessages(Array.from({ length: NUM_VERSIONS }, () => []));
    setDisplayTexts(Array.from({ length: NUM_VERSIONS }, () => []));
    setRawDecisions(Array(NUM_VERSIONS).fill(""));
    setDoneFlags(Array(NUM_VERSIONS).fill(false));
    setStreaming(true);
    setSubStep("preview");

    try {
      const results = await Promise.all(
        Array.from({ length: NUM_VERSIONS }, (_, i) => streamVersion(i, activePrompt))
      );
      setRawDecisions(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setSubStep("prompt");
    } finally {
      setStreaming(false);
    }
  }, [activePrompt, streamVersion]);

  // ── Confirm ───────────────────────────────────────────────────────────────
  const handleConfirmPreview = useCallback(() => {
    const allDecisions = rawDecisions.map(raw => {
      const { decisions } = parseIndexedDecisions(raw, transcript.length, 0);
      return decisions;
    });
    onComplete(allDecisions);
  }, [rawDecisions, transcript, onComplete]);

  const handleRerun = useCallback(() => {
    for (let v = 0; v < NUM_VERSIONS; v++) {
      if (animTimerRefs.current[v]) {
        clearTimeout(animTimerRefs.current[v]!);
        animTimerRefs.current[v] = null;
      }
    }
    setSubStep("prompt");
    setPreviewMessages(Array.from({ length: NUM_VERSIONS }, () => []));
    setDisplayTexts(Array.from({ length: NUM_VERSIONS }, () => []));
    setRawDecisions(Array(NUM_VERSIONS).fill(""));
    setDoneFlags(Array(NUM_VERSIONS).fill(false));
    setError(null);
  }, []);

  // ── Render: prompt entry ──────────────────────────────────────────────────
  if (subStep === "prompt") {
    return (
      <div>
        <h2 className="text-2xl font-bold mb-1">LLM Edit Prompt</h2>
        <p className="text-neutral-400 mb-6 text-sm">
          The transcript will be sent as numbered utterances. The LLM returns
          per-line keep/remove/trim decisions — run 3× in parallel to generate 3 versions.
        </p>

        <Card className="p-6 border-neutral-800 bg-neutral-900/50 mb-6">
          <div className="flex gap-2 mb-5">
            <button
              onClick={() => setMode("default")}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                mode === "default"
                  ? "bg-violet-600 text-white"
                  : "bg-neutral-800 text-neutral-400 hover:text-white"
              }`}
            >
              Default Prompt
            </button>
            <button
              onClick={() => setMode("custom")}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                mode === "custom"
                  ? "bg-violet-600 text-white"
                  : "bg-neutral-800 text-neutral-400 hover:text-white"
              }`}
            >
              Custom Prompt
            </button>
          </div>

          {mode === "default" ? (
            <div className="bg-neutral-950 border border-neutral-700 rounded-md p-4 mb-4 max-h-[240px] overflow-y-auto">
              <p className="text-xs text-neutral-500 mb-2 uppercase tracking-wider font-medium">
                Default editing prompt
              </p>
              <pre className="text-sm text-neutral-300 whitespace-pre-wrap font-sans leading-relaxed">
                {DEFAULT_EDIT_PROMPT}
              </pre>
            </div>
          ) : (
            <>
              <label className="block text-sm font-medium text-neutral-300 mb-2">
                Your editing instruction
              </label>
              <Textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="e.g., Remove all filler content and small talk. Keep only substantive discussion."
                className="min-h-[160px] bg-neutral-950 border-neutral-700 text-white placeholder:text-neutral-600 mb-4"
              />
            </>
          )}

          {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

          <Button
            onClick={handleApplyPrompt}
            disabled={!activePrompt.trim()}
            className="px-6"
          >
            Apply Prompt × 3
          </Button>
        </Card>

        <Card className="p-4 border-neutral-800 bg-neutral-900/30">
          <p className="text-xs text-neutral-500">
            <strong className="text-neutral-400">How it works:</strong> Three independent LLM
            runs fire in parallel. You&apos;ll see all 3 clips generate live, then move to
            word-level editing for each version before exporting.
          </p>
        </Card>
      </div>
    );
  }

  // ── Render: 3-column streaming preview ───────────────────────────────────
  const origWordCount = transcript
    .map((t) => t.text.trim().split(/\s+/).filter(Boolean).length)
    .reduce((a, b) => a + b, 0);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-1">Clip Preview</h2>
      <p className="text-neutral-400 mb-4 text-sm">
        {streaming
          ? "Generating 3 versions in parallel…"
          : "Review the versions, then continue to line-by-line editing."}
      </p>

      {/* 3-column preview */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        {Array.from({ length: NUM_VERSIONS }, (_, v) => {
          const msgs = previewMessages[v];
          const dtexts = displayTexts[v];
          const vDone = doneFlags[v];
          const wordCount = msgs.reduce(
            (acc, m) => acc + m.text.trim().split(/\s+/).filter(Boolean).length, 0
          );

          return (
            <div key={v} className="rounded-xl border border-neutral-800 bg-neutral-950 overflow-hidden flex flex-col">
              {/* Title bar */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 bg-neutral-900 shrink-0">
                <span className="text-xs font-medium text-neutral-400">
                  Version {v + 1}
                </span>
                {vDone && (
                  <span className="text-xs text-neutral-600">
                    {wordCount}/{origWordCount} ({origWordCount > 0 ? Math.round((wordCount / origWordCount) * 100) : 0}%)
                  </span>
                )}
              </div>

              {/* Messages */}
              <div className="p-3 space-y-2 flex-1 overflow-y-auto" style={{ maxHeight: "360px" }}>
                {msgs.length === 0 ? (
                  <div className="flex items-center gap-2 text-neutral-600 text-xs py-2">
                    <span className="inline-block w-0.5 h-3.5 bg-violet-400 animate-pulse align-middle" />
                    <span>Waiting…</span>
                  </div>
                ) : (
                  msgs.map((msg, i) => {
                    const isRight = msg.speaker === 1;
                    const isLast = i === msgs.length - 1;
                    const text = dtexts[i] ?? "";
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
                          {(isAnimating || (isLast && streaming && !vDone)) && (
                            <span className="inline-block w-0.5 h-3 bg-current animate-pulse ml-1 align-middle opacity-70" />
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={(el) => { messagesEndRefs.current[v] = el; }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div
        className="flex gap-3 transition-opacity duration-500"
        style={{ opacity: allDone ? 1 : 0, pointerEvents: allDone ? "auto" : "none" }}
      >
        <Button
          onClick={handleConfirmPreview}
          disabled={rawDecisions.some(r => !r)}
          className="px-6"
        >
          Looks good — continue to edit
        </Button>
        <Button
          variant="outline"
          onClick={handleRerun}
          className="px-6 border-neutral-700 text-neutral-300 hover:text-white"
        >
          Re-run with different prompt
        </Button>
      </div>

      <p
        className="text-xs text-neutral-600 mt-4 transition-opacity duration-500"
        style={{ opacity: allDone ? 1 : 0 }}
      >
        On the next step you can fine-tune individual words in each version before exporting.
      </p>
    </div>
  );
}
