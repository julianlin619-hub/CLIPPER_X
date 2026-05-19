# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

CLIPPER is an AI-powered video editing pipeline. It transcribes long-form video, uses Claude to make keep/remove/trim decisions on the transcript, then exports a Final Cut Pro XML timeline. The main UI is a Next.js app running locally on macOS.

**Core workflow:** Select video(s) → Transcribe (Deepgram) → LLM editing (Claude) → Word-level editor → Export FCPXML

**Inputs:** raw camera files. A-only (single cam) or A+B (dual cam, **pre-synced upstream** — segmenter handles sync, the app trusts that A and B share the same timeline). The app never accepts or modifies an external FCPXML — it always generates one from scratch.

## Setup

```bash
npm install
pip3 install -r requirements.txt
cp .env.example .env.local  # fill in DEEPGRAM_API_KEY and ANTHROPIC_API_KEY
```

Requires: Node.js 18+, Python 3.9+, ffmpeg

## Commands

```bash
npm run dev    # start dev server at http://localhost:3000
npm run build  # production build
npm run lint   # ESLint check
```

No test suite — validation is done via manual end-to-end testing (process a real video, verify FCPXML in Resolve/FCP).

## Architecture

### Frontend State Machine (`src/app/page.tsx`)

The `Home` component owns app-level state and drives a 4-step flow: `browse → prompt → edit → export`. State is a single `source: Source | null`, plus `transcript`, `speakerMap`, and per-version `versionWords`. All editor logic lives in `src/lib/editor/`; `Home` is orchestration only.

### Editor module (`src/lib/editor/`)

Pure functions that map a transcript + LLM decisions into editable words and final clips. Used from `Home` and from the `ExportStep`.

- **`normalize.ts`** — `normalizeWord()` strips punctuation + lowercases for fuzzy matching
- **`greedy-match.ts`** — `greedyMatch()` maps LLM TRIM text back to Deepgram word tokens. Tries direct match → pool concat (`"530" + "k" === "530k"`) → trim concat (`"1,200,000" + "." === "1,200,000."`) → skip. Match rate <80% triggers a keep-all fallback at the caller (`buildEditableWords`).
- **`build-editable-words.ts`** — `buildEditableWords()` consumes `LineDecision[]` and produces `EditableWord[]`. Handles LLM "merge" cases by expanding the word pool through subsequent consecutive REMOVE'd utterances (lookahead window: 10). Anchor ranges, if passed, are always kept.
- **`filter.ts`** — `filterShortClips()` drops sub-second runs that survived after trimming.
- **`index.ts`** — barrel re-exports.

### A+B multi-cam model

**Types** (`src/lib/types.ts`): a `Source` is a list of `CamAngle`s plus shared duration/fps. Each `CamAngle` has a `filePath` and an `audioSource: boolean` flag. Exactly one angle has `audioSource: true` — that's the cam whose audio gets transcribed and whose audio is routed in the exported FCPXML. The other angle is video-only.

**Picker UI** (`src/components/file-browser.tsx`): A-cam is required; "+ Add Camera B" reveals an optional second picker. No mode toggle — presence/absence of B-cam is the only signal.

**Export** (`src/lib/xml.ts`): `generateFCPXML(segments, source, speakerLabels)` branches on `source.angles.length`:
- 1 angle: flat `<asset-clip>` spine — primary cam's audio routed via `<audio-channel-source>` x2.
- 2 angles: A on the spine; B as a connected `<asset-clip lane="1">` child of each spine clip. B is declared `hasAudio="0"` and carries no `<audio-channel-source>` — only A's audio plays.

**Connected-clip offset semantics (load-bearing detail):** A connected clip's `offset` is in the **parent clip's source-TC frame**, not the sequence timeline. For pre-synced 1:1 A+B, B's `offset` and `start` are the same value — both equal A's `start`. See the comment block in `src/lib/xml.ts` where this is emitted.

### LLM Integration

- **`src/app/api/clip-preview/route.ts`** — streams Claude editing decisions via forced tool-use (`submit_edit_decisions`). Model: `claude-sonnet-4-6`. Streams `input_json_delta` chunks to the client; the client accumulates and parses with `parseIndexedDecisions` on Continue. Gated `CLIPPER_DUMP_FIXTURE=1` writes the captured tool input to `src/lib/editor/__fixtures__/` (debug aid; no-op without the env var).
- **`src/app/actions/validate-assembly.ts`** — server action that runs a coherence check on assembled clips via Claude (forced tool-use, `claude-sonnet-4-6`). Chunked in groups of 50 with 2-clip overlap. Throws on missing tool block; the action's outer non-blocking handler logs and returns empty arrays so export isn't blocked by a validation failure.
- **`src/lib/llm.ts`** — `parseIndexedDecisions()` parses the JSON tool-call output (`{ decisions: [{ index, action, trimmed_text? }] }`). **Throws** on malformed input (non-JSON, partial JSON, invalid action, missing/duplicate/out-of-range index, TRIM without `trimmed_text`). Omitted indices default to KEEP (safe; never silently deletes content). No legacy text-format fallback.
- **`src/prompts/default-edit.ts`** — default editing prompt.

### Python Workers

- **`scripts/transcribe.py`** — ffmpeg audio extraction, Deepgram nova-3 transcription, stereo channel splitting (detects stereo and sends L/R separately for Host/Caller diarization), word-level timestamp output via SSE.

### Export (`src/lib/xml.ts`, `src/lib/export.ts`)

`generateFCPXML()` builds standalone FCPXML 1.8. `computeFinalClips()` in `export.ts` merges consecutive kept `EditableWord`s into contiguous clip segments that `generateFCPXML` consumes.

## Key Types (`src/lib/types.ts`)

- `WordTiming` — individual word with start/end timestamps (Deepgram output)
- `TranscriptEntry` — a Deepgram utterance with words, start/end, text
- `LineDecision` — `{ index, action: "keep"|"remove"|"trim", text?, fragmentWarning?, rationale? }` (LLM output, post-parse)
- `EditableWord` — `{ id, text, removed, start, end, utteranceIdx, confidence?, speaker?, fragmentWarning?, anchored?, rationale? }` — word-level state, mutable
- `CamAngle` — `{ id: "A"|"B", filePath, audioSource: boolean }`
- `Source` — `{ angles: CamAngle[], duration, fps }` — 1 (A-only) or 2 (A+B) angles
- `SpeakerMap` — `Record<number, string>` mapping Deepgram speaker IDs to display labels
- `AppStep` — `"browse" | "prompt" | "edit" | "export"`

## API Routes

| Route | Purpose |
|-------|---------|
| `POST /api/transcribe` | Spawns `transcribe.py`, streams SSE |
| `POST /api/clip-preview` | Streams LLM tool-call JSON |
| `GET /api/video` | Video/audio with HTTP range support |
| `GET /api/native-pick` | macOS native file picker (single video file) |

## Environment Variables

```
DEEPGRAM_API_KEY        # required for transcription
ANTHROPIC_API_KEY       # required for LLM editing
CLIPPER_DUMP_FIXTURE=1  # optional: dump clip-preview tool input to src/lib/editor/__fixtures__/
```
