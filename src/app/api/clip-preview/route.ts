import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { TranscriptEntry, SpeakerMap } from "@/lib/types";

const anthropic = new Anthropic();

/**
 * Format instructions appended to custom prompts that don't already specify
 * the structured decision output format.
 */
const DECISION_FORMAT = `

## OUTPUT FORMAT
For each utterance in the transcript, output exactly one decision line:
\`[index] KEEP\` — keep this utterance verbatim
\`[index] REMOVE\` — cut this utterance entirely
\`[index] TRIM: <trimmed text>\` — keep only this specific text from the utterance

Rules:
- Output one decision per line, in index order
- Every index from the input MUST have a decision (no gaps)
- TRIM text must use ONLY words from the original utterance (no new words)
- No commentary, no headers, no explanations — ONLY decision lines`;

export async function POST(req: NextRequest) {
  const { transcript, prompt, speakerMap } = await req.json() as {
    transcript: TranscriptEntry[];
    prompt: string;
    speakerMap?: Record<string, string>; // JSON keys are always strings
  };

  if (!transcript || !prompt) {
    return new Response(JSON.stringify({ error: "transcript and prompt are required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Append output format instructions if the prompt doesn't already define them
  const systemPrompt = prompt.includes("OUTPUT FORMAT") ? prompt : prompt + DECISION_FORMAT;

  // Build numbered utterance list (same format the DEFAULT_EDIT_PROMPT expects)
  // JSON serialization turns numeric keys to strings, so we re-parse them.
  const resolvedMap: SpeakerMap | undefined = speakerMap
    ? Object.fromEntries(Object.entries(speakerMap).map(([k, v]) => [Number(k), v]))
    : undefined;

  const lineList = transcript
    .map((t: TranscriptEntry, i: number) => {
      const rawSpeaker = t.words?.[0]?.speaker ?? null;
      const label =
        rawSpeaker != null
          ? (resolvedMap?.[rawSpeaker] ?? `Speaker ${rawSpeaker}`)
          : "Speaker";
      return `[${i}] ${label}: ${t.text.trim()}`;
    })
    .filter(Boolean)
    .join("\n");

  const userMessage = `## Transcript\n${lineList}`;

  // Stream Claude's structured decision response to the client
  const claudeStream = anthropic.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    temperature: 0.3,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of claudeStream) {
          if (
            chunk.type === "content_block_delta" &&
            chunk.delta.type === "text_delta"
          ) {
            controller.enqueue(new TextEncoder().encode(chunk.delta.text));
          }
        }
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    },
  });
}
