import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askCheck, contextNeed, messageHasText } from "./ask-check";
import { run } from "./main";

const entry = (type: string, messageId: string, content: unknown[]) =>
  JSON.stringify({ parentUuid: "p", isSidechain: false, type, message: { id: messageId, role: type, content }, requestId: "r", uuid: "u" });
const thinking = (id: string, text = "") => entry("assistant", id, [{ type: "thinking", thinking: text }]);
const text = (id: string, t: string) => entry("assistant", id, [{ type: "text", text: t }]);
const call = (id: string, toolUseId: string) => entry("assistant", id, [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: {} }]);
const result = (toolUseId: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] } });

const question = (header: string, q = "Which one?") => ({ questions: [{ header, question: q, options: [{ label: "A" }, { label: "B" }] }] });

describe("contextNeed", () => {
  test.each(["Assuming", "Confirm", "Approve", "approve"])("a %p question relies on the chat", (header) => {
    expect(contextNeed(question(header))).toContain(header);
  });

  test.each(["Confirm the list (shown above)?", "Do the assumptions above hold?", "Approve the plan as above?"])("%p relies on the chat", (q) => {
    expect(contextNeed(question("Shape", q))).toContain("above");
  });

  test.each(["Should the CTA sit above the fold?", "Will you have above 1,000 spaces?"])("%p doesn't", (q) => {
    expect(contextNeed(question("Layout", q))).toBeNull();
  });

  test("a go-ahead with Request changes relies on the chat, whatever its header", () => {
    const goAhead = { questions: [{ header: "CLAUDE.md", question: "Add these notes?", options: [{ label: "Approve" }, { label: "Request changes" }] }] };
    expect(contextNeed(goAhead)).toContain("CLAUDE.md");
  });

  test("a decision that stands on its own doesn't", () => {
    expect(contextNeed(question("Shape", "Should the org search become one shared hook?"))).toBeNull();
    expect(contextNeed({})).toBeNull();
    expect(contextNeed(null)).toBeNull();
  });
});

describe("messageHasText", () => {
  test("only thinking before the call is no text", () => {
    const transcript = [result("t0"), thinking("m1"), thinking("m1", "The org picker only loads ten."), call("m1", "t1")].join("\n");
    expect(messageHasText(transcript, "t1")).toBe(false);
  });

  test("text in the same message counts", () => {
    expect(messageHasText([thinking("m1"), text("m1", "**Assuming:**\n- one"), call("m1", "t1")].join("\n"), "t1")).toBe(true);
  });

  test("text in an earlier message of the turn doesn't", () => {
    const transcript = [text("m0", "Reading the ticket."), call("m0", "t0"), result("t0"), call("m1", "t1")].join("\n");
    expect(messageHasText(transcript, "t1")).toBe(false);
  });

  test("whitespace-only text doesn't count", () => {
    expect(messageHasText([text("m1", "\n\n"), call("m1", "t1")].join("\n"), "t1")).toBe(false);
  });

  test("a tool result written between parallel calls doesn't hide the message's text", () => {
    const transcript = [text("m1", "The list."), call("m1", "t0"), result("t0"), call("m1", "t1")].join("\n");
    expect(messageHasText(transcript, "t1")).toBe(true);
  });

  test("a call missing from the transcript is unknown", () => {
    expect(messageHasText(["not json", thinking("m1")].join("\n"), "t1")).toBeNull();
  });
});

describe("askCheck", () => {
  const hookInput = (transcript: string, toolInput: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), "fbs-ask-")), "t.jsonl");
    writeFileSync(path, transcript);
    return JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "t1", transcript_path: path, tool_input: toolInput });
  };

  test("denies a Confirm asked with nothing in the chat", () => {
    expect(askCheck(hookInput([thinking("m1"), call("m1", "t1")].join("\n"), question("Confirm")))).toContain("wrote nothing in the chat");
  });

  test("allows it once the message wrote the list", () => {
    expect(askCheck(hookInput([text("m1", "**Decisions:** …"), call("m1", "t1")].join("\n"), question("Confirm")))).toBeNull();
  });

  test("denies when the text went out in an earlier message, before a tool call", () => {
    const transcript = [text("m0", "**Overview** …"), call("m0", "t0"), result("t0"), call("m1", "t1")].join("\n");
    expect(askCheck(hookInput(transcript, question("Approve")))).toContain("wrote nothing in the chat");
  });

  test("allows a question that stands on its own, with or without text", () => {
    expect(askCheck(hookInput(call("m1", "t1"), question("Shape")))).toBeNull();
  });

  test("allows what it can't read", () => {
    expect(askCheck("garbage")).toBeNull();
    expect(askCheck(JSON.stringify({ tool_name: "AskUserQuestion", tool_use_id: "t1", transcript_path: "/nonexistent/t.jsonl", tool_input: question("Confirm") }))).toBeNull();
    expect(askCheck(hookInput(thinking("m1"), question("Confirm")))).toBeNull();
  });
});

describe("fbs ask-check", () => {
  const cli = (stdin: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(["ask-check"], { cwd: tmpdir(), today: "2026-11-04", out: (l) => out.push(l), err: (l) => err.push(l) }, {
      gh: () => ({ code: 1, stdout: "", stderr: "" }),
      now: () => 0,
      sleep: () => {},
      stdin: () => stdin,
    });
    return { code, out, err };
  };

  test("exits 2 with the reason on stderr to deny, 0 silently to allow", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fbs-ask-")), "t.jsonl");
    writeFileSync(path, [thinking("m1"), call("m1", "t1")].join("\n"));
    const input = (header: string) => JSON.stringify({ tool_name: "AskUserQuestion", tool_use_id: "t1", transcript_path: path, tool_input: question(header) });
    const denied = cli(input("Approve"));
    expect(denied.code).toBe(2);
    expect(denied.err[0]).toStartWith("blocked by fbs:");
    expect(cli(input("Shape"))).toEqual({ code: 0, out: [], err: [] });
    expect(cli("garbage")).toEqual({ code: 0, out: [], err: [] });
  });

  test("wrong arguments allow rather than deny every question", () => {
    const code = run(["ask-check", "--typo"], { cwd: tmpdir(), today: "2026-11-04", out: () => {}, err: () => {} }, {
      gh: () => ({ code: 1, stdout: "", stderr: "" }),
      now: () => 0,
      sleep: () => {},
      stdin: () => "",
    });
    expect(code).toBe(0);
  });

  test("hooks.json runs it on AskUserQuestion with no arguments, and without blocking on failure", () => {
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, "..", "hooks", "hooks.json"), "utf8")).hooks.PreToolUse;
    const entry = hooks.find((h: { matcher: string }) => new RegExp(h.matcher).test("AskUserQuestion"));
    expect(entry.hooks).toEqual([{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/fbs", args: ["ask-check"], timeout: 10 }]);
    expect(hooks.filter((h: { matcher: string }) => new RegExp(h.matcher).test("AskUserQuestion"))).toHaveLength(1);
  });
});
