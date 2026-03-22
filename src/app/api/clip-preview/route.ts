import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { TranscriptEntry, SpeakerMap, WordTiming } from "@/lib/types";

/** Returns the dominant speaker ID across all words in an utterance (majority vote). */
function getUtteranceSpeaker(words: WordTiming[] | undefined): number | null {
  const counts = new Map<number, number>();
  for (const w of words ?? []) {
    if (w.speaker != null) counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const anthropic = new Anthropic();

export async function POST(req: NextRequest) {
  const { transcript, prompt, speakerMap, temperature } = await req.json() as {
    transcript: TranscriptEntry[];
    prompt: string;
    speakerMap?: Record<string, string>; // JSON keys are always strings
    temperature?: number;
  };

  if (!transcript || !prompt) {
    return new Response(JSON.stringify({ error: "transcript and prompt are required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const systemPrompt = prompt;

  // Build numbered utterance list (same format the DEFAULT_EDIT_PROMPT expects)
  // JSON serialization turns numeric keys to strings, so we re-parse them.
  const resolvedMap: SpeakerMap | undefined = speakerMap
    ? Object.fromEntries(Object.entries(speakerMap).map(([k, v]) => [Number(k), v]))
    : undefined;

  const lineList = transcript
    .map((t: TranscriptEntry, i: number) => {
      const rawSpeaker = getUtteranceSpeaker(t.words);
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
    temperature: temperature ?? 0.3,
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
