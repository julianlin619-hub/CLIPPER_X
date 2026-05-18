"use client";

import { useState } from "react";
import {
  AppStep,
  TranscriptEntry,
  LineDecision,
  EditableWord,
  SpeakerMap,
} from "@/lib/types";
import { computeFinalClips } from "@/lib/export";
import { autoDetectSpeakers } from "@/lib/speaker-utils";
import { buildEditableWords, filterShortClips } from "@/lib/editor";
import FileBrowser from "@/components/file-browser";
import PromptStep from "@/components/prompt-step";
import VideoEditor from "@/components/video-editor";
import ExportStep from "@/components/export-step";


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
