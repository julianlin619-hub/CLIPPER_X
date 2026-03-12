# ✂️ CLIPPER

AI-powered video transcript editor. Transcribe a video, segment it by topic, use an LLM to cut filler and fluff, then export a clean FCPXML timeline for Final Cut Pro.

## What it does

1. **Select** a video file from your local filesystem
2. **Transcribe** with Deepgram (word-level timestamps + speaker diarization)
3. **Segment** the transcript into topic sections with Claude
4. **LLM Edit** — Claude reviews each segment and marks lines to keep, trim, or remove
5. **Post-processing** — automatic filler strip, sentence boundary repair, and coherence validation
6. **Edit** — word-level editor to fine-tune cuts per segment
7. **Export** — downloads an FCPXML file ready for Final Cut Pro

## Requirements

- Node.js 18+
- Python 3.9+
- ffmpeg (for audio extraction)

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd CLIPPER
npm install
```

### 2. Python dependencies

```bash
pip3 install -r requirements.txt
```

### 3. Install ffmpeg

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg
```

### 4. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in your API keys:

| Key | Where to get it |
|-----|----------------|
| `DEEPGRAM_API_KEY` | [console.deepgram.com](https://console.deepgram.com) |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) (optional) |

### 5. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Pipeline (in depth)

### Step 1 — Transcription

Deepgram transcribes the video with word-level timestamps and speaker diarization. Each word carries `start`, `end`, `confidence`, and `speaker` fields. The transcript is split into utterances (sentences / speaker turns).

### Step 2 — Segmentation (optional)

Claude splits the transcript into logical topic segments. You can edit, merge, or add segment breaks manually before proceeding. Skipping segmentation processes the entire transcript as a single segment.

### Step 3 — LLM Editing

Each segment is sent to Claude as a separate, parallel API call (up to 3 concurrent). Claude outputs a decision per utterance line:

- `[N] KEEP` — include as-is
- `[N] REMOVE` — cut entirely
- `[N] TRIM: <text>` — keep only the specified portion

**Prompt rules enforced:**
- **Filler rule** — lines whose entire content is discourse markers (Okay, Yeah, Mhmm, etc.) are always REMOVE
- **Minimum length rule** — lines under 8 words must end with terminal punctuation or be REMOVE
- **Boundary rule** — every KEEP line following a REMOVE is checked: if it starts mid-sentence, the LLM must KEEP the prior line or TRIM to include the opener
- **TRIM sentence boundary rule** — trimmed text must begin at a sentence boundary, never mid-clause

**Reliability features:**
- Missing indices (LLM skips a line) default to **KEEP** (never silently cut)
- 429 rate-limit errors retry up to 2× with exponential backoff (1s → 2s)
- Failed segments fall back to KEEP-all so no content is lost

### Step 4 — Post-processing passes

After LLM decisions are applied, three deterministic passes run in order:

#### 4a. Filler clip strip
Scans every contiguous kept-word run. If a run is:
- shorter than **1.5 seconds**, AND
- **3 words or fewer**, AND
- composed entirely of filler tokens

→ auto-removed. Logged to console for audit.

#### 4b. Sentence boundary repair
For every adjacent pair of kept clips, checks:
- Does clip A end without terminal punctuation?
- Does clip B start with a lowercase word (not "I") or a conjunction/preposition (Or, And, But, So, Because, That, Which…)?
- Does clip A end with a bare number and the gap starts with a number-continuation word (k, million, leads, %…)?

If any trigger fires:
- **Gap ≤ 10 words** → auto-merge: un-remove the gap words
- **Gap > 10 words** → set `boundaryWarning` flag on clip B for editor review (orange `⚡ boundary?` badge)

#### 4c. Fragment validation (LLM)
A lightweight secondary LLM call reviews boundary lines — any TRIM output and any KEEP line that follows a substantial REMOVE (≥ 5 words removed). Returns `[N] VALID` or `[N] FRAGMENT`. Fragments get `fragmentWarning: true` flagged on the first word (yellow `⚠ fragment?` badge in the editor).

### Step 5 — Coherence validation

After all post-processing, a final LLM call reviews the **assembled output as a viewer would hear it**. Each kept clip is sent in order with surrounding cut context:

```
[0] My name is Matthew... And if I don't solve this,
  ↳ CUT AFTER: "I either say no to demand in summer..."

[1] Well, I guess the problem we're trying to solve here...
```

The validator checks every clip's **first and last sentence independently**:
- Incomplete endings (`"And if I don't solve this,"` — conditional with no resolution) → REMOVE or FLAG
- Incomplete starts (`"Or I am overstuffed in winter."` — "Or" continues a removed sentence) → REMOVE or FLAG
- Contextless references (a number or concept only established in cut content) → FLAG
- Isolated filler (`"Okay."`, `"Yeah. Touché."`) → REMOVE

Results:
- `removeClips` → words marked removed (still visible and restorable in editor)
- `flagClips` → words marked `coherenceWarning: true`, rendered amber in editor with `👁 review` badge

A dismissible summary banner shows: *"Coherence check: X clips auto-removed · Y clips flagged for review"*

For long videos (100+ clips), clips are automatically chunked into groups of 50 with 2-clip overlap for boundary context.

### Step 6 — Word-level editor

The editor shows the full transcript with all kept/removed/flagged words. Visual indicators:

| Badge | Meaning |
|-------|---------|
| `⚠ fragment?` yellow | LLM fragment validator flagged this utterance |
| `⚡ boundary?` orange | Large removed gap before this line — possible split sentence |
| `👁 review` amber | Coherence validator flagged this clip |

Words are colour-coded:
- **White** — kept
- **Amber** — kept but flagged for coherence review
- **Strikethrough grey** — removed (click to restore)

Keyboard shortcuts: `Backspace` / `Delete` to cut selection, `R` to restore, `Space` to play from selected word, click speaker label to restore entire utterance.

**↓ Debug TXT** button downloads a word-level debug report showing every kept/cut block with timestamps — useful for diagnosing fragment issues.

### Step 7 — Export

**If you provided a multicam FCPXML** (your original FCP timeline), the export patches that file and downloads `{name}_master.fcpxml`. The structure is a dual-track overlay:

```
Timeline:
Lane 2 (overlay):  [KEPT SEG A]       [KEPT SEG B]    [KEPT SEG C]
Lane 1 (primary):  [=====ORIGINAL FULL FOOTAGE — split at kept-segment boundaries=====]
```

- **Lane 1** — your original footage, intact but split at every kept-segment in/out point so edit marks are visible
- **Lane 2** — the kept segments only, as connected clips sitting on top at their original source timecodes

Both layers play simultaneously. To get your clean edit, **disable or delete Lane 1** — Lane 2 alone gives you the kept segments back-to-back.

**If no original FCPXML was provided**, a standalone FCPXML is generated with only the kept clips placed consecutively on a single track (no original footage reference).

In both cases, word-level timestamps from Deepgram drive the exact in/out points — no re-encoding required. Works with Final Cut Pro 10.6+.

**Additional downloads available on the Export tab:**
- **Prompt example** (`example-full.txt`) — raw transcript + LLM decisions, useful for iterating on prompts
- **Debug report** — word-level before/after breakdown with timestamps, useful for diagnosing cut decisions

---

## Basic Auth (optional)

By default the app is open with no login. If you want to protect it (e.g. when sharing via Tailscale), set these in `.env.local`:

```
ACCESS_USERNAME=admin
ACCESS_PASSWORD=yourpassword
```

To disable auth entirely, delete `src/proxy.ts`.

---

## Notes

- Video files are read directly from your local filesystem — nothing is uploaded to external storage
- API calls go to Deepgram (transcription) and Anthropic (segmentation + editing + validation)
- FCPXML export works with Final Cut Pro 10.6+
- All post-processing (filler strip, boundary repair, coherence validation) only flips `removed` flags on existing word objects — word-level timestamps are never altered
