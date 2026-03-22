# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

CLIPPER is an AI-powered video editing pipeline. It transcribes long-form video, uses Claude to make keep/remove/trim decisions on the transcript, then exports a Final Cut Pro XML timeline. The main UI is a Next.js app running locally on macOS.

**Core workflow:** Select video → Transcribe (Deepgram) → LLM editing (Claude, 3 parallel versions) → Word-level editor → Export FCPXML

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

No test suite — validation is done via manual testing and the built-in SSE streaming debug flow.

## Architecture

### Frontend State Machine (`src/app/page.tsx`)

The main `Home` component owns all application state and drives a 4-step flow: `browse → prompt → edit → export`. This file contains the most critical business logic:

- **`greedyMatch()`** — maps LLM TRIM text back to Deepgram word tokens (handles tokenization mismatches; tries direct → pool-concat → skip; falls back to keep-all if <80% match)
- **`buildEditableWords()`** — constructs the `EditableWord[]` array from LLM decisions
- **`stripFillerClips()`** — removes runs <1.5s, ≤3 words, all filler tokens
- **`repairBoundaryFragments()`** — auto-merges gaps ≤10 words when terminal punctuation is missing or clip B starts with lowercase/conjunction; flags longer gaps for review
- **`buildClipSegments()`** — collects contiguous KEEP runs with context

### LLM Integration

- **`src/app/api/clip-preview/route.ts`** — streams Claude editing decisions (3 parallel calls for 3 style variations)
- **`src/app/actions/validate-assembly.ts`** — server action that runs a coherence check on assembled clips via Claude (`claude-sonnet-4-20250514`); chunked in groups of 50 with 2-clip overlap
- **`src/lib/llm.ts`** — `buildCreativeMessage()` builds prompts; `parseIndexedDecisions()` parses `[index] KEEP/REMOVE/TRIM "text"` format
- **`src/prompts/default-edit.ts`** — default editing prompt (HOOK → MEAT → PAYOFF arc)

### Python Workers

- **`scripts/transcribe.py`** — ffmpeg audio extraction, Deepgram nova-3 transcription, stereo channel splitting, word-level timestamp output
- **`scripts/patch_fcpxml.py`** — overlays kept clips on original FCP timeline as a secondary track

### Export (`src/lib/xml.ts`, `src/lib/export.ts`)

`generateFCPXML()` builds standalone FCPXML from kept clip segments. When an original FCPXML is provided, `patch_fcpxml.py` is called instead to produce a dual-track multicam output.

## Key Types (`src/lib/types.ts`)

- `TranscriptEntry` — a Deepgram utterance with speaker, words, timing
- `EditableWord` — a word with `kept` boolean, filler flag, coherence warning
- `LineDecision` — parsed LLM output: `KEEP | REMOVE | TRIM`
- `WordTiming` — individual word with start/end timestamps

## API Routes

| Route | Purpose |
|-------|---------|
| `POST /api/transcribe` | Spawns `transcribe.py`, streams SSE |
| `POST /api/clip-preview` | Streams LLM editing decisions |
| `GET /api/browse` | Filesystem navigation |
| `GET /api/video` | Video/audio with HTTP range support |
| `POST /api/patch-fcpxml` | Calls `patch_fcpxml.py` |
| `GET /api/native-pick` | macOS native file picker |

## Environment Variables

```
DEEPGRAM_API_KEY       # required for transcription
ANTHROPIC_API_KEY      # required for LLM editing
OPENAI_API_KEY         # optional
ACCESS_USERNAME        # optional basic auth
ACCESS_PASSWORD        # optional basic auth
```
