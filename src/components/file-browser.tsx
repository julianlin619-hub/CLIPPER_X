"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { TranscriptEntry } from "@/lib/types";

interface BrowseEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
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

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"];
const XML_EXTENSIONS = [".xml", ".fcpxml"];

function isVideo(name: string): boolean {
  return VIDEO_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}
function isXml(name: string): boolean {
  return XML_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

type Phase = "browse" | "transcribing";
type TxStatus = "extracting_audio" | "chunking_audio" | "transcribing" | "done" | "error";

export default function FileBrowser({ onComplete, fcpxmlPath, onFcpxmlSelected }: Props) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [parent, setParent] = useState("");
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  const [videoPath, setVideoPath] = useState("");
  const [videoName, setVideoName] = useState("");

  const [phase, setPhase] = useState<Phase>("browse");

  const [txStatus, setTxStatus] = useState<TxStatus>("extracting_audio");
  const [txStatusText, setTxStatusText] = useState("");
  const [txProgress, setTxProgress] = useState(0);
  const [txError, setTxError] = useState<string | null>(null);

  const [isStereo, setIsStereo] = useState(false);
  const [leftChState, setLeftChState] = useState<"idle" | "extracting" | "transcribing" | "done">("idle");
  const [rightChState, setRightChState] = useState<"idle" | "extracting" | "transcribing" | "done">("idle");

  const browse = async (targetDir?: string) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const params = targetDir ? `?dir=${encodeURIComponent(targetDir)}` : "";
      const res = await fetch(`/api/browse${params}`);
      const data = await res.json();
      if (data.error) setBrowseError(data.error);
      else {
        setDir(data.dir);
        setParent(data.parent);
        setEntries(data.entries || []);
      }
    } catch (e: unknown) {
      setBrowseError(e instanceof Error ? e.message : "Browse failed");
    } finally {
      setBrowseLoading(false);
    }
  };

  useEffect(() => { browse(); }, []);

  const handleFileClick = (entry: BrowseEntry) => {
    if (isXml(entry.name)) onFcpxmlSelected(entry.path);
    else if (isVideo(entry.name)) { setVideoPath(entry.path); setVideoName(entry.name); }
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
              // Go straight to LLM edit — no segmentation step
              onComplete(t, d, f, videoPath, stereo || undefined);
            }
          } catch { /* ignore non-JSON */ }
        }
      }
    } catch (e: unknown) {
      setTxStatus("error");
      setTxError(e instanceof Error ? e.message : "Transcription failed");
    }
  };

  const videoFiles = entries.filter((e) => e.type === "file" && isVideo(e.name));
  const xmlFiles = entries.filter((e) => e.type === "file" && isXml(e.name));
  const dirs = entries.filter((e) => e.type === "directory" && !e.name.startsWith("."));
  const hasRelevantFiles = videoFiles.length > 0 || xmlFiles.length > 0 || dirs.length > 0;

  const canTranscribe = !!(videoPath && fcpxmlPath);

  return (
    <div className="max-w-2xl mx-auto">

      {phase === "browse" && (
        <>
          <div className="mb-8">
            <h2 className="text-2xl font-bold mb-1">Select &amp; Transcribe</h2>
            <p className="text-neutral-400 text-sm">Select both inputs, then transcribe. Host and caller are identified separately.</p>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className={`rounded-xl border-2 p-4 transition-colors ${fcpxmlPath ? "border-violet-500 bg-violet-950/30" : "border-dashed border-neutral-700 bg-neutral-900/30"}`}>
              <div className="flex items-start justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Input 1</span>
                {fcpxmlPath && <button onClick={() => onFcpxmlSelected("")} className="text-neutral-500 hover:text-neutral-300 text-xs">✕</button>}
              </div>
              <p className="text-sm font-semibold text-white mb-1">Multi-Cam XML</p>
              <p className="text-xs text-neutral-500 mb-3">All cameras + final audio track</p>
              {fcpxmlPath ? (
                <div className="flex items-center gap-2"><span className="text-lg">📋</span><span className="text-xs text-violet-300 font-mono truncate">{fcpxmlPath.split("/").pop()}</span></div>
              ) : (
                <div className="flex items-center gap-2 text-neutral-600"><span className="text-lg">📋</span><span className="text-xs">No file selected</span></div>
              )}
            </div>

            <div className={`rounded-xl border-2 p-4 transition-colors ${videoPath ? "border-emerald-500 bg-emerald-950/30" : "border-dashed border-neutral-700 bg-neutral-900/30"}`}>
              <div className="flex items-start justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Input 2</span>
                {videoPath && <button onClick={() => { setVideoPath(""); setVideoName(""); }} className="text-neutral-500 hover:text-neutral-300 text-xs">✕</button>}
              </div>
              <p className="text-sm font-semibold text-white mb-1">Final MP4</p>
              <p className="text-xs text-neutral-500 mb-3">Final video with mixed audio</p>
              {videoPath ? (
                <div className="flex items-center gap-2"><span className="text-lg">🎬</span><span className="text-xs text-emerald-300 font-mono truncate">{videoName}</span></div>
              ) : (
                <div className="flex items-center gap-2 text-neutral-600"><span className="text-lg">🎬</span><span className="text-xs">No file selected</span></div>
              )}
            </div>
          </div>

          <div className="mb-8">
            <Button
              onClick={startTranscription}
              disabled={!canTranscribe}
              className="w-full bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-30 disabled:cursor-not-allowed font-semibold"
            >
              {canTranscribe ? "Transcribe →" : "Select both files to transcribe"}
            </Button>
          </div>

          <div className="border border-neutral-800 rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-neutral-900/60 border-b border-neutral-800">
              <span className="text-xs text-neutral-500 font-mono truncate flex-1">{dir || "Loading..."}</span>
              {parent && parent !== dir && (
                <button onClick={() => browse(parent)} disabled={browseLoading} className="text-xs text-neutral-400 hover:text-white shrink-0">↑ Up</button>
              )}
            </div>
            {browseError && <div className="text-red-400 text-xs p-4 bg-red-950/20">{browseError}</div>}
            {browseLoading && <div className="text-neutral-500 text-sm py-10 text-center">Loading...</div>}
            {!browseLoading && (
              <div className="divide-y divide-neutral-800/50">
                {dirs.map((entry) => (
                  <button key={entry.path} onClick={() => browse(entry.path)} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-800/40 transition-colors text-left">
                    <span className="text-base">📁</span>
                    <span className="flex-1 text-sm text-neutral-300 truncate">{entry.name}</span>
                    <span className="text-neutral-600 text-xs">›</span>
                  </button>
                ))}
                {xmlFiles.map((entry) => (
                  <button key={entry.path} onClick={() => handleFileClick(entry)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 transition-all text-left ${fcpxmlPath === entry.path ? "bg-violet-950/40 hover:bg-violet-950/60" : "hover:bg-neutral-800/40"}`}>
                    <span className="text-base">📋</span>
                    <span className="flex-1 text-sm text-white truncate">{entry.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {fcpxmlPath === entry.path
                        ? <span className="text-xs text-violet-400">Selected ✓</span>
                        : <Badge variant="outline" className="text-xs border-violet-800/50 text-violet-500 bg-violet-950/20">XML</Badge>}
                      {entry.size && <span className="text-xs text-neutral-500">{formatSize(entry.size)}</span>}
                    </div>
                  </button>
                ))}
                {videoFiles.map((entry) => (
                  <button key={entry.path} onClick={() => handleFileClick(entry)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 transition-all text-left ${videoPath === entry.path ? "bg-emerald-950/40 hover:bg-emerald-950/60" : "hover:bg-neutral-800/40"}`}>
                    <span className="text-base">🎬</span>
                    <span className="flex-1 text-sm text-white truncate">{entry.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {videoPath === entry.path
                        ? <span className="text-xs text-emerald-400">Selected ✓</span>
                        : <Badge variant="outline" className="text-xs border-emerald-800/50 text-emerald-500 bg-emerald-950/20">MP4</Badge>}
                      {entry.size && <span className="text-xs text-neutral-500">{formatSize(entry.size)}</span>}
                    </div>
                  </button>
                ))}
                {!hasRelevantFiles && <div className="text-neutral-600 text-sm py-10 text-center">No relevant files here</div>}
              </div>
            )}
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

          <div className="grid grid-cols-2 gap-3 text-xs text-neutral-500">
            <div className="rounded-lg border border-neutral-800 px-3 py-2 flex items-center gap-2">
              <span>📋</span><span className="truncate font-mono">{fcpxmlPath.split("/").pop()}</span>
            </div>
            <div className="rounded-lg border border-neutral-800 px-3 py-2 flex items-center gap-2">
              <span>🎬</span><span className="truncate font-mono">{videoName}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
