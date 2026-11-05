import { expect, test } from "bun:test";
import { checkContext } from "./context";

const opts = { maxFacts: 3, staleDays: 30, today: "2026-10-21" };

test("parses fact lines", () => {
  const r = checkContext("# Context\n\n- Closed beta, 2 active clients. (2026-10-21, alex)\n", opts);
  expect(r.errors).toEqual([]);
  expect(r.facts[0]).toMatchObject({ text: "Closed beta, 2 active clients.", date: "2026-10-21", source: "alex", line: 3 });
});

test("CRLF, trailing spaces and html comments parse like clean input", () => {
  const r = checkContext("# Context\r\n<!-- one fact\r\nper line -->\r\n- A. (2026-10-01, alex)   \r\n", opts);
  expect(r.errors).toEqual([]);
  expect(r.facts).toEqual([{ text: "A.", date: "2026-10-01", source: "alex", line: 4 }]);
});

test("an inline comment leaves no stray space in the fact text", () => {
  const r = checkContext("- A. <!-- why --> (2026-10-01, alex)\n", opts);
  expect(r.errors).toEqual([]);
  expect(r.facts[0].text).toBe("A.");
});

test("a non-fact line is an error naming its line", () => {
  expect(checkContext("- no date here\n", opts).errors).toEqual(["line 1: not a fact line: - no date here"]);
});

test("an impossible date is an error", () => {
  for (const date of ["2026-13-40", "2026-02-30", "2100-02-29"]) {
    expect(checkContext(`- A. (${date}, alex)\n`, opts).errors).toEqual([`line 1: invalid date ${date}`]);
  }
});

test("a leap day in a leap year is a valid date", () => {
  expect(checkContext("- A. (2024-02-29, alex)\n", opts).errors).toEqual([]);
});

test("over the limit is an error that says prune or promote", () => {
  const md = ["A", "B", "C", "D"].map((t) => `- ${t}. (2026-10-21, alex)`).join("\n");
  expect(checkContext(md, opts).errors).toEqual(["4 facts, limit 3: prune a fact or promote it to CLAUDE.md"]);
});

test("facts older than staleDays are stale, not errors", () => {
  const r = checkContext("- Old. (2026-09-01, alex)\n- New. (2026-10-20, alex)\n", opts);
  expect(r.errors).toEqual([]);
  expect(r.stale.map((f) => f.text)).toEqual(["Old."]);
});
