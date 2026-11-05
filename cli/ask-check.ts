import { readFileSync } from "node:fs";

const CONTEXT_HEADERS = new Set(["assuming", "confirm", "approve"]);
const POINTS_ABOVE = /\b(shown|listed|written|given|described|as|see|list|lines|block|summary|overview|assumptions|table)\s+above\b/i;

/** Why this AskUserQuestion input relies on text in the chat, or null when it stands on its own. */
export function contextNeed(toolInput: unknown): string | null {
  const questions = (toolInput as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return null;
  for (const q of questions) {
    const header = typeof q?.header === "string" ? q.header.trim() : "";
    if (CONTEXT_HEADERS.has(header.toLowerCase())) return `its \`${header}\` question is judged from what the chat shows`;
    const options = Array.isArray(q?.options) ? q.options : [];
    if (options.some((o: { label?: unknown }) => o?.label === "Request changes")) return `its go-ahead \`${header}\` is judged from what the chat shows`;
    if (typeof q?.question === "string" && POINTS_ABOVE.test(q.question)) return `the question "${q.question}" points at text above it`;
  }
  return null;
}

/** Whether the assistant message holding this tool call has visible text; null when the call isn't in the transcript. */
export function messageHasText(transcript: string, toolUseId: string): boolean | null {
  const blocksByMessage = new Map<string, { type?: string; id?: string; text?: string }[]>();
  let callMessage: string | null = null;
  for (const line of transcript.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let entry: { type?: string; message?: { id?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const id = entry.message?.id;
    const content = entry.message?.content;
    if (entry.type !== "assistant" || typeof id !== "string" || !Array.isArray(content)) continue;
    blocksByMessage.set(id, [...(blocksByMessage.get(id) ?? []), ...content]);
    if (content.some((b) => b?.type === "tool_use" && b.id === toolUseId)) callMessage = id;
  }
  if (callMessage === null) return null;
  return (blocksByMessage.get(callMessage) ?? []).some((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
}

/**
 * The PreToolUse check on AskUserQuestion: deny a question that relies on the chat when its message wrote nothing there.
 * Returns the reason to deny, or null to allow; anything it can't read allows.
 */
export function askCheck(raw: string): string | null {
  try {
    const input = JSON.parse(raw);
    if (input?.tool_name !== "AskUserQuestion" || typeof input.tool_use_id !== "string" || typeof input.transcript_path !== "string") return null;
    const need = contextNeed(input.tool_input);
    if (need === null) return null;
    if (messageHasText(readFileSync(input.transcript_path, "utf8"), input.tool_use_id) !== false) return null;
    return `${need}, but this message wrote nothing in the chat before the call (thinking isn't shown as a message). Write what the user needs to answer as formatted text in the message that makes the call, after any other tool call, then ask again; if you showed it earlier in this turn, show it again here, shortened if it was long.`;
  } catch {
    return null;
  }
}
