"use client";

import { useState } from "react";
import { EditableWord, TranscriptEntry, SpeakerMap } from "@/lib/types";
import { computeFinalClips, generateExampleTranscript, generateExampleDecisions } from "@/lib/export";
import { generateFCPXML } from "@/lib/xml";
import { Download } from "lucide-react";

interface Props {
  versionWords: EditableWord[][];
  fileName: string;
  filePath?: string;
  duration: number;
  fps?: number;
  transcript?: TranscriptEntry[];
  fcpxmlPath?: string;
  speakerMap?: SpeakerMap;
}

export default function ExportStep({ versionWords, fileName, filePath, duration, fps = 30, fcpxmlPath, transcript = [], speakerMap }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseName = fileName.replace(/\.\w+$/, "");
  const speakerLabels: [string, string] = [speakerMap?.[0] ?? "Speaker", speakerMap?.[1] ?? "Guest"];

  const downloadExample = (words: EditableWord[], versionIdx: number) => {
    const output =
      'RAW TRANSCRIPT:\n\n' + generateExampleTranscript(transcript, words) +
      '\n\nDECISIONS:\n\n' + generateExampleDecisions(words, transcript) + '\n';
    const blob = new Blob([output], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `example-v${versionIdx + 1}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h2 className="text-2xl font-bold mb-1">Export</h2>
        <p className="text-neutral-400 text-sm">Download your edited output.</p>
      </div>
      <div className="space-y-3">
        {fcpxmlPath ? (
          // Multicam mode: patch existing FCPXML via Python script
          <button
            onClick={async () => {
              setLoading(true); setError(null);
              try {
                const versions = versionWords.map(words =>
                  computeFinalClips(words).map(c => ({ start: c.start, end: c.end }))
                );
                const res = await fetch("/api/patch-fcpxml", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ fcpxmlPath, versions, videoPath: filePath }),
                });
                if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error(e.error); }
                const blob = new Blob([await res.text()], { type: "application/xml" });
                const suffix = versionWords.length > 1 ? `_clipper_${versionWords.length}v` : "_clipper";
                const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: baseName + suffix + '.fcpxml' });
                a.click();
              } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
              finally { setLoading(false); }
            }}
            disabled={loading}
            className="w-full flex items-center justify-between px-5 py-4 rounded-xl border border-violet-500/50 bg-violet-950/30 hover:bg-violet-950/50 hover:border-violet-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all group"
          >
            <div className="text-left">
              <p className="text-sm font-semibold text-violet-200">Export Multicam FCPXML</p>
              <p className="text-xs text-violet-400/70 mt-0.5">
                {versionWords.length > 1
                  ? `${versionWords.length} versions · original timeline duplicated with 1-min gaps · each has its overlay track`
                  : "Full original timeline preserved · kept clips placed as overlay track at original positions"}
              </p>
            </div>
            <span className="text-violet-400 group-hover:text-violet-200 transition-colors text-lg">
              {loading ? "⏳" : "⬇"}
            </span>
          </button>
        ) : (
          // Single-cam mode: generate FCPXML from scratch client-side
          <button
            onClick={() => {
              setError(null);
              try {
                versionWords.forEach((words, i) => {
                  const clips = computeFinalClips(words);
                  const xml = generateFCPXML(clips, fileName, duration, fps, filePath, speakerLabels);
                  const blob = new Blob([xml], { type: "application/xml" });
                  const suffix = versionWords.length > 1 ? `_clipper_v${i + 1}` : "_clipper";
                  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: baseName + suffix + '.fcpxml' });
                  a.click();
                });
              } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            }}
            disabled={loading}
            className="w-full flex items-center justify-between px-5 py-4 rounded-xl border border-violet-500/50 bg-violet-950/30 hover:bg-violet-950/50 hover:border-violet-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all group"
          >
            <div className="text-left">
              <p className="text-sm font-semibold text-violet-200">Export FCPXML</p>
              <p className="text-xs text-violet-400/70 mt-0.5">
                {versionWords.length > 1
                  ? `${versionWords.length} files · one FCPXML per version · generated from your edits`
                  : "FCPXML generated from your edits · ready to import into Final Cut Pro"}
              </p>
            </div>
            <span className="text-violet-400 group-hover:text-violet-200 transition-colors text-lg">⬇</span>
          </button>
        )}
        {error && <p className="text-sm text-red-400 px-1">{error}</p>}
      </div>

      <div className="mt-8">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-neutral-300">Prompt Examples</h3>
          <p className="text-xs text-neutral-500 mt-0.5">
            Download a before/after example file — paste into the prompt to improve future edits.
          </p>
        </div>
        <div className="space-y-2">
          {versionWords.map((words, i) => (
            <button
              key={i}
              onClick={() => downloadExample(words, i)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 hover:border-neutral-500 transition-all group"
            >
              <div className="text-left">
                <p className="text-sm font-medium text-neutral-200">
                  {versionWords.length > 1 ? `Version ${i + 1} Transcript` : "Full Transcript"}
                </p>
                <p className="text-xs text-neutral-500 mt-0.5">
                  {versionWords.length > 1 ? `example-v${i + 1}.txt` : "example-full.txt"}
                </p>
              </div>
              <Download className="w-4 h-4 text-neutral-500 group-hover:text-neutral-200 transition-colors shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
