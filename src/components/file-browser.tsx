"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { TranscriptEntry, WordTiming } from "@/lib/types";

function getUtteranceSpeaker(words: WordTiming[] | undefined): number | null {
  const counts = new Map<number, number>();
  for (const w of words ?? []) {
    if (w.speaker != null) counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

interface Props {
  onComplete: (
    transcript: TranscriptEntry[],
    duration: number,
    fps: number,
    videoPath: string,
    stereo?: boolean
  ) => void;
  fcpxmlPath: string;
  onFcpxmlSelected: (path: string) => void;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type Phase = "browse" | "transcribing";
type TxStatus = "extracting_audio" | "chunking_audio" | "transcribing" | "done" | "error";
type Mode = "single" | "multicam";

export default function FileBrowser({ onComplete, fcpxmlPath, onFcpxmlSelected }: Props) {
  const [videoPath, setVideoPath] = useState("");
  const [videoName, setVideoName] = useState("");
  const [mode, setMode] = useState<Mode>("single");

  const [phase, setPhase] = useState<Phase>("browse");

  const [txStatus, setTxStatus] = useState<TxStatus>("extracting_audio");
  const [txStatusText, setTxStatusText] = useState("");
  const [txProgress, setTxProgress] = useState(0);
  const [txError, setTxError] = useState<string | null>(null);

  const [isStereo, setIsStereo] = useState(false);
  const [leftChState, setLeftChState] = useState<"idle" | "extracting" | "transcribing" | "done">("idle");
  const [rightChState, setRightChState] = useState<"idle" | "extracting" | "transcribing" | "done">("idle");

  const [pendingComplete, setPendingComplete] = useState<{
    transcript: TranscriptEntry[];
    duration: number;
    fps: number;
    videoPath: string;
    stereo?: boolean;
  } | null>(null);

  const [pickerError, setPickerError] = useState<string | null>(null);

  const downloadTranscriptTxt = (transcript: TranscriptEntry[], stereo: boolean) => {
    const lines = transcript.map((entry, i) => {
      const spk = getUtteranceSpeaker(entry.words);
      const label = stereo
        ? (spk === 0 ? "Host" : spk === 1 ? "Caller" : spk != null ? `Speaker ${spk}` : "Speaker")
        : (spk != null ? `Speaker ${spk}` : "Speaker");
      return `[${i}] ${label}: ${entry.text.trim()}`;
    });
    const blob = new Blob([`## Transcript\n${lines.join("\n")}`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcript.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const openNativePicker = async (type: "xml" | "video") => {
    setPickerError(null);
    try {
      const res = await fetch(`/api/native-pick?type=${type}`);
      const data = await res.json();
      if (data.cancelled) return;
      if (data.error) { setPickerError(data.error); return; }
      if (type === "xml") {
        onFcpxmlSelected(data.path);
      } else {
        setVideoPath(data.path);
        setVideoName(data.path.split("/").pop() || data.path);
      }
    } catch (e: unknown) {
      setPickerError(e instanceof Error ? e.message : "Picker failed");
    }
  };

  const startTranscription = async () => {
    setPhase("transcribing");
    setTxStatus("extracting_audio");
    setTxStatusText("Extracting audio from video...");
    setTxProgress(10);
    setTxError(null);

    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: videoPath }),
      });
      if (!res.body) throw new Error("No response stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let stereo = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const msg = JSON.parse(raw);
            if (msg.error) { setTxStatus("error"); setTxError(msg.error); return; }
            if (msg.status === "extracting_channels") {
              stereo = true;
              setIsStereo(true);
              setLeftChState("extracting");
              setRightChState("extracting");
              setTxStatusText("Stereo detected — splitting channels...");
              setTxProgress(20);
            }
            else if (msg.status === "audio_extracted" && stereo) {
              setLeftChState("idle");
              setRightChState("idle");
              setTxProgress(35);
            }
            else if (msg.status === "extracting_audio") { setTxStatus("extracting_audio"); setTxStatusText("Extracting audio..."); setTxProgress(20); }
            else if (msg.status === "audio_extracted") { setTxStatusText(`Audio extracted (${msg.size_mb} MB)`); setTxProgress(35); }
            else if (msg.status === "chunking_audio") { setTxStatus("chunking_audio"); setTxStatusText("Splitting into chunks..."); setTxProgress(40); }
            else if (msg.status === "chunking_complete") { setTxStatusText(`Split into ${msg.chunks} chunks`); setTxProgress(45); }
            else if (msg.status === "transcribing_chunk") {
              setTxStatus("transcribing");
              const pct = msg.total > 1 ? Math.round(45 + (msg.chunk / msg.total) * 45) : 60;
              setTxProgress(pct);
              if (stereo && msg.total === 2) {
                if (msg.chunk === 1) {
                  setLeftChState("transcribing");
                  setTxStatusText("Transcribing host channel (left)...");
                } else {
                  setLeftChState("done");
                  setRightChState("transcribing");
                  setTxStatusText("Transcribing caller channel (right)...");
                }
              } else {
                setTxStatusText(msg.total > 1 ? `Transcribing chunk ${msg.chunk} / ${msg.total}...` : "Transcribing with Deepgram nova-3...");
              }
            }
            else if (msg.status === "done" && msg.transcript) {
              if (stereo) { setLeftChState("done"); setRightChState("done"); }
              setTxStatus("done");
              setTxProgress(100);
              const t: TranscriptEntry[] = msg.transcript;
              const d = typeof msg.duration === "number" && msg.duration > 0 ? msg.duration : t.length > 0 ? t[t.length - 1].end : 0;
              const f = typeof msg.fps === "number" && msg.fps > 0 ? msg.fps : 30;
              setTxStatusText(`Done — ${t.length} utterances, ${formatTime(d)}`);
              setPendingComplete({ transcript: t, duration: d, fps: f, videoPath, stereo: stereo || undefined });
            }
          } catch { /* ignore non-JSON */ }
        }
      }
    } catch (e: unknown) {
      setTxStatus("error");
      setTxError(e instanceof Error ? e.message : "Transcription failed");
    }
  };

  const canTranscribe = mode === "single" ? !!videoPath : !!(videoPath && fcpxmlPath);

  return (
    <div className="max-w-2xl mx-auto">

      {phase === "browse" && (
        <>
          <div className="mb-8">
            <h2 className="text-2xl font-bold mb-1">Select &amp; Transcribe</h2>
            <p className="text-neutral-400 text-sm">
              {mode === "single"
                ? "Select your video file to transcribe and edit."
                : "Select both inputs, then transcribe. Host and caller are identified separately."}
            </p>
          </div>

          {mode === "single" ? (
            <div className={`rounded-xl border-2 p-4 mb-6 transition-colors ${videoPath ? "border-emerald-500 bg-emerald-950/30" : "border-dashed border-neutral-700 bg-neutral-900/30"}`}>
              <div className="flex items-start justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Video File</span>
                {videoPath && <button onClick={() => { setVideoPath(""); setVideoName(""); }} className="text-neutral-500 hover:text-neutral-300 text-xs">✕</button>}
              </div>
              <p className="text-sm font-semibold text-white mb-1">MP4 / MOV</p>
              <p className="text-xs text-neutral-500 mb-3">Single camera video file</p>
              {videoPath ? (
                <div className="flex items-center gap-2 mb-3"><span className="text-lg">🎬</span><span className="text-xs text-emerald-300 font-mono truncate">{videoName}</span></div>
              ) : (
                <div className="flex items-center gap-2 text-neutral-600 mb-3"><span className="text-lg">🎬</span><span className="text-xs">No file selected</span></div>
              )}
              <Button size="sm" variant="outline" onClick={() => openNativePicker("video")}
                className="w-full text-xs border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-300">
                Browse...
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className={`rounded-xl border-2 p-4 transition-colors ${fcpxmlPath ? "border-violet-500 bg-violet-950/30" : "border-dashed border-neutral-700 bg-neutral-900/30"}`}>
                <div className="flex items-start justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Input 1</span>
                  {fcpxmlPath && <button onClick={() => onFcpxmlSelected("")} className="text-neutral-500 hover:text-neutral-300 text-xs">✕</button>}
                </div>
                <p className="text-sm font-semibold text-white mb-1">Multi-Cam XML</p>
                <p className="text-xs text-neutral-500 mb-3">All cameras + final audio track</p>
                {fcpxmlPath ? (
                  <div className="flex items-center gap-2 mb-3"><span className="text-lg">📋</span><span className="text-xs text-violet-300 font-mono truncate">{fcpxmlPath.split("/").pop()}</span></div>
                ) : (
                  <div className="flex items-center gap-2 text-neutral-600 mb-3"><span className="text-lg">📋</span><span className="text-xs">No file selected</span></div>
                )}
                <Button size="sm" variant="outline" onClick={() => openNativePicker("xml")}
                  className="w-full text-xs border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-300">
                  Browse...
                </Button>
              </div>

              <div className={`rounded-xl border-2 p-4 transition-colors ${videoPath ? "border-emerald-500 bg-emerald-950/30" : "border-dashed border-neutral-700 bg-neutral-900/30"}`}>
                <div className="flex items-start justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Input 2</span>
                  {videoPath && <button onClick={() => { setVideoPath(""); setVideoName(""); }} className="text-neutral-500 hover:text-neutral-300 text-xs">✕</button>}
                </div>
                <p className="text-sm font-semibold text-white mb-1">Final MP4</p>
                <p className="text-xs text-neutral-500 mb-3">Final video with mixed audio</p>
                {videoPath ? (
                  <div className="flex items-center gap-2 mb-3"><span className="text-lg">🎬</span><span className="text-xs text-emerald-300 font-mono truncate">{videoName}</span></div>
                ) : (
                  <div className="flex items-center gap-2 text-neutral-600 mb-3"><span className="text-lg">🎬</span><span className="text-xs">No file selected</span></div>
                )}
                <Button size="sm" variant="outline" onClick={() => openNativePicker("video")}
                  className="w-full text-xs border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-300">
                  Browse...
                </Button>
              </div>
            </div>
          )}

          {pickerError && (
            <div className="text-red-400 text-xs mb-4 p-3 bg-red-950/20 border border-red-900/30 rounded-lg">{pickerError}</div>
          )}

          <div className="mb-6">
            <Button
              onClick={startTranscription}
              disabled={!canTranscribe}
              className="w-full bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-30 disabled:cursor-not-allowed font-semibold"
            >
              {canTranscribe ? "Transcribe →" : mode === "single" ? "Select a video to transcribe" : "Select both files to transcribe"}
            </Button>
          </div>

          <div className="flex items-center gap-3 p-3 rounded-lg border border-neutral-800 bg-neutral-900/40">
            <span className="text-xs text-neutral-500 shrink-0">Mode:</span>
            <div className="flex gap-1 flex-1">
              <button
                onClick={() => { setMode("single"); onFcpxmlSelected(""); }}
                className={`flex-1 text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${mode === "single" ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-neutral-300"}`}
              >
                Single Camera
              </button>
              <button
                onClick={() => setMode("multicam")}
                className={`flex-1 text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${mode === "multicam" ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-neutral-300"}`}
              >
                Multi-Camera
              </button>
            </div>
          </div>
        </>
      )}

      {phase === "transcribing" && (
        <>
          <div className="mb-8">
            <h2 className="text-2xl font-bold mb-1">Transcribing</h2>
            <p className="text-neutral-400 text-sm">
              {isStereo
                ? "Stereo file — each channel sent to Deepgram separately for precise speaker identification."
                : "Deepgram nova-3 · word-level timestamps · speaker diarization"}
            </p>
          </div>

          {isStereo ? (
            <>
              <div className="flex gap-4 mb-4">
                {[
                  { label: "Left Channel", role: "Host", state: leftChState },
                  { label: "Right Channel", role: "Caller", state: rightChState },
                ].map(({ label, role, state }) => (
                  <div key={label} className="flex-1 rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs text-neutral-500 uppercase tracking-wider font-medium">{label}</span>
                      {state === "done" && <span className="text-xs text-green-400 font-medium">✓ Done</span>}
                    </div>
                    <p className="text-base font-semibold text-white mb-4">{role}</p>
                    <div className="flex items-center gap-2">
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        state === "done" ? "bg-green-500" :
                        state === "transcribing" ? "bg-blue-500 animate-pulse" :
                        state === "extracting" ? "bg-yellow-500 animate-pulse" :
                        "bg-neutral-700"
                      }`} />
                      <span className="text-sm text-neutral-400">
                        {state === "done" ? "Done" :
                         state === "transcribing" ? "Transcribing..." :
                         state === "extracting" ? "Extracting..." :
                         "Waiting"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <Progress value={txProgress} className="h-1.5 mb-4" />
            </>
          ) : (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-5 mb-4">
              <div className="flex items-center gap-3 mb-3">
                <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${txStatus === "done" ? "bg-green-500" : txStatus === "error" ? "bg-red-500" : "bg-violet-500 animate-pulse"}`} />
                <span className="text-sm text-neutral-200 flex-1">{txStatusText}</span>
              </div>
              {txStatus !== "error" && <Progress value={txProgress} className="h-1.5" />}
              {txStatus === "error" && txError && (
                <div className="text-red-400 text-sm mt-2 p-3 bg-red-950/20 border border-red-900/30 rounded-lg">{txError}</div>
              )}
            </div>
          )}

          {txStatus === "done" && pendingComplete && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950 overflow-hidden mb-4">
              <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800 bg-neutral-900">
                <span className="text-xs font-medium text-neutral-400">Transcript</span>
                <span className="text-xs text-neutral-600">{pendingComplete.transcript.length} utterances</span>
              </div>
              <div className="p-3 space-y-2 overflow-y-auto" style={{ maxHeight: "360px" }}>
                {pendingComplete.transcript.map((entry, i) => {
                  const spk = getUtteranceSpeaker(entry.words);
                  const label = isStereo
                    ? (spk === 0 ? "Host" : spk === 1 ? "Caller" : spk != null ? `Speaker ${spk}` : "Speaker")
                    : spk != null ? `Speaker ${spk}` : "Speaker";
                  const isRight = label !== "Host";
                  return (
                    <div key={i} className={`flex flex-col gap-0.5 ${isRight ? "items-end" : "items-start"}`}>
                      <span className="text-[9px] text-neutral-600 px-1">{label}</span>
                      <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                        isRight
                          ? "bg-violet-600 text-white rounded-br-sm"
                          : "bg-neutral-700 text-neutral-100 rounded-bl-sm"
                      }`}>
                        {entry.text}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {txStatus === "done" && pendingComplete && (
            <div className="flex gap-3 mt-4 mb-4">
              <button
                onClick={() => downloadTranscriptTxt(pendingComplete.transcript, pendingComplete.stereo ?? false)}
                className="flex-1 text-xs px-4 py-2 rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition-colors"
              >
                Download TXT
              </button>
              <button
                onClick={() => onComplete(pendingComplete.transcript, pendingComplete.duration, pendingComplete.fps, pendingComplete.videoPath, pendingComplete.stereo)}
                className="flex-1 text-xs px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors"
              >
                Continue to Edit →
              </button>
            </div>
          )}

          <div className={`grid gap-3 text-xs text-neutral-500 ${mode === "multicam" ? "grid-cols-2" : "grid-cols-1"}`}>
            {mode === "multicam" && (
              <div className="rounded-lg border border-neutral-800 px-3 py-2 flex items-center gap-2">
                <span>📋</span><span className="truncate font-mono">{fcpxmlPath.split("/").pop()}</span>
              </div>
            )}
            <div className="rounded-lg border border-neutral-800 px-3 py-2 flex items-center gap-2">
              <span>🎬</span><span className="truncate font-mono">{videoName}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
