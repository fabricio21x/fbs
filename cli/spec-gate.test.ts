import { expect, test } from "bun:test";
import { gatePasses, readGate } from "./spec-gate";

const ACCEPTED = "- [x] A (user, 2026-10-22)";
const FACTS_NONE = "## Facts\nNone\n";
const OQ_NONE = "## Open questions\nNone\n";
const PASSING_DOC = `${FACTS_NONE}## Assumptions\n${ACCEPTED}\n${OQ_NONE}`;
const CLEAN = { missingSections: [], emptySections: [], unsourced: [], unconfirmed: [], openQuestions: [], unsupported: [], workUnits: [] };
const facts = (body: string) => readGate(`## Facts\n${body}\n## Assumptions\nNone\n${OQ_NONE}`);
const assumptions = (body: string) => readGate(`${FACTS_NONE}## Assumptions\n${body}\n${OQ_NONE}`);

const ok = "## Facts\n- Two beta clients (.fbs/context.md)\n\n## Assumptions\nNone\n\n## Open questions\nNone\n";
test("sourced facts and None passes", () => expect(gatePasses(readGate(ok))).toBe(true));
test("an unchecked assumption blocks", () =>
  expect(readGate("## Assumptions\n- [ ] Many clients in prod\n## Open questions\nNone\n").unconfirmed).toEqual(["Many clients in prod"]));
test("an assumption without a checkbox counts as unconfirmed", () =>
  expect(readGate("## Assumptions\n- Stripe is the provider\n## Open questions\nNone\n").unconfirmed).toEqual(["Stripe is the provider"]));
test("a prose line in Assumptions counts as unconfirmed", () =>
  expect(readGate("## Assumptions\nWe assume Stripe.\n## Open questions\nNone\n").unconfirmed).toEqual(["We assume Stripe."]));
test("None alone in Assumptions passes", () =>
  expect(gatePasses(readGate(`${FACTS_NONE}## Assumptions\nNone\n## Open questions\nNone\n`))).toBe(true));
test("a nested line under an accepted item blocks", () =>
  expect(assumptions(`${ACCEPTED}\n  - source: alex`).unconfirmed).toEqual(["source: alex"]));
test("open question items block", () =>
  expect(readGate(`${FACTS_NONE}## Assumptions\nNone\n## Open questions\n- Annual billing?\n`).openQuestions).toEqual(["Annual billing?"]));
test("missing sections block, in the order Facts, Assumptions, Open questions", () =>
  expect(readGate("# Spec\n## Problem\nx\n").missingSections).toEqual(["Facts", "Assumptions", "Open questions"]));
test("headings match case-insensitively at level 2 or 3", () =>
  expect(gatePasses(readGate("### FACTS\nNONE\n### assumptions\n- [X] A (user, 2026-10-22)\n### OPEN QUESTIONS\nnone.\n"))).toBe(true));
test("every copy of a section is gated", () =>
  expect(readGate(`## Assumptions\n${ACCEPTED}\n## Design\n### Assumptions\n- [ ] B\n## Open questions\nNone\n`).unconfirmed).toEqual(["B"]));
test("template comments and CRLF are ignored", () =>
  expect(gatePasses(readGate(`## Facts\r\n<!-- each with its source -->\r\n- B (CLAUDE.md)\r\n## Assumptions\r\n<!-- list each -->\r\n${ACCEPTED}\r\n## Open questions\r\n<!-- or None -->\r\nNone\r\n`))).toBe(true));
test("a section ends at the next heading of the same or higher level", () =>
  expect(readGate(`## Assumptions\n${ACCEPTED}\n## Decision log\n- [ ] not an assumption\n## Open questions\nNone\n`).unconfirmed).toEqual([]));

test("a sourced fact passes, whatever the source", () => {
  expect(gatePasses(facts("- Closed beta with 2 clients (.fbs/context.md)\n- Ships by Nov 1 (user, 2026-10-22)"))).toBe(true);
  expect(gatePasses(facts("- Stripe is the provider ( CLAUDE.md )"))).toBe(true);
});

test("a fact without a source at the end blocks as unsourced", () => {
  expect(facts("- Two beta clients").unsourced).toEqual(["Two beta clients"]);
  expect(facts("We have two beta clients.").unsourced).toEqual(["We have two beta clients."]);
  for (const line of ["- Two clients ()", "- Two clients (  )", "- Two clients (a (b))", "- Two clients (CLAUDE.md) today", "- (CLAUDE.md)", "* Two clients (CLAUDE.md)"]) {
    expect(facts(line).unsourced).toHaveLength(1);
  }
});

test("a checkbox in Facts blocks", () =>
  expect(facts("- [x] Two clients (CLAUDE.md)\n- [ ] Stripe (CLAUDE.md)\n- [X] Spain (CLAUDE.md)").unsourced).toEqual([
    "[x] Two clients (CLAUDE.md)",
    "[ ] Stripe (CLAUDE.md)",
    "[X] Spain (CLAUDE.md)",
  ]));

test("a nested line under a sourced fact blocks", () =>
  expect(facts("- Two clients (CLAUDE.md)\n  - Stripe (CLAUDE.md)").unsourced).toEqual(["Stripe (CLAUDE.md)"]));

test("a missing Facts section blocks", () => {
  const r = readGate(`## Assumptions\nNone\n${OQ_NONE}`);
  expect(r.missingSections).toEqual(["Facts"]);
  expect(gatePasses(r)).toBe(false);
});

test("None in Facts passes, and an empty Facts section blocks", () => {
  expect(facts("None")).toEqual(CLEAN);
  expect(facts("<!-- each with its source -->").emptySections).toEqual(["Facts"]);
});

test("an accepted assumption needs the user and a date as its source", () => {
  expect(assumptions("- [x] Annual billing can wait (user, 2026-10-22)")).toEqual(CLEAN);
  expect(gatePasses(assumptions("- [X] Annual billing can wait ( user,2026-10-22 )"))).toBe(true);
});

test("an accepted assumption with another source blocks as unconfirmed", () =>
  expect(
    assumptions("- [x] Stripe is the provider (CLAUDE.md)\n- [x] Spain first (user)\n- [x] Two clients (user, Oct 22)\n- [x] Beta (alex, 2026-10-22)").unconfirmed,
  ).toEqual(["Stripe is the provider (CLAUDE.md)", "Spain first (user)", "Two clients (user, Oct 22)", "Beta (alex, 2026-10-22)"]));

test("an accepted assumption without a source blocks as unconfirmed", () =>
  expect(assumptions("- [x] Stripe is the provider").unconfirmed).toEqual(["Stripe is the provider"]));

test("a heading with both facts and assumptions is gated as Assumptions", () => {
  const r = readGate("## Facts and assumptions\n- Two clients (CLAUDE.md)\n## Open questions\nNone\n");
  expect(r.unconfirmed).toEqual(["Two clients (CLAUDE.md)"]);
  expect(r.unsourced).toEqual([]);
  expect(r.missingSections).toEqual(["Facts"]);
});

test("every copy of the Facts section is gated", () => {
  const r = readGate(`## Facts\n- A\n## Design\n### Facts\n- B\n## Assumptions\nNone\n${OQ_NONE}`);
  expect(r.unsourced).toEqual(["A", "B"]);
  expect(readGate(`## Facts\n- A (CLAUDE.md)\n## Design\n### Key facts\n- B\n## Assumptions\nNone\n${OQ_NONE}`).unsourced).toEqual(["B"]);
});

test("a Facts section with CRLF line breaks is gated line by line", () => {
  expect(gatePasses(readGate("## Facts\r\n- A (CLAUDE.md)\r\n## Assumptions\r\nNone\r\n## Open questions\r\nNone\r\n"))).toBe(true);
  expect(readGate("## Facts\r\n- A (CLAUDE.md)\r\n- B\r\n## Assumptions\r\nNone\r\n## Open questions\r\nNone\r\n").unsourced).toEqual(["B"]);
});

test("a nested unchecked box blocks under an accepted item", () => {
  expect(assumptions(`${ACCEPTED}\n  - [ ] B`).unconfirmed).toEqual(["B"]);
  expect(assumptions(`${ACCEPTED}\n    - [ ] B`).unconfirmed).toEqual(["B"]);
  expect(assumptions(`${ACCEPTED}\n\t- [ ] B`).unconfirmed).toEqual(["B"]);
});

test("an indented line with no top-level line above blocks", () => {
  expect(assumptions("  - [ ] Many clients").unconfirmed).toEqual(["Many clients"]);
  expect(assumptions("  We assume Stripe.").unconfirmed).toEqual(["We assume Stripe."]);
  expect(readGate("## Assumptions\nNone\n## Open questions\n  - Annual billing?\n").openQuestions).toEqual(["Annual billing?"]);
});

test("None followed by a nested item is not empty", () => {
  expect(gatePasses(assumptions("None\n  - [ ] B"))).toBe(false);
  expect(assumptions("None\n  - [ ] B").unconfirmed).toContain("B");
});

test("None followed by an indented line is not empty", () =>
  expect(gatePasses(assumptions("None\n  but maybe Stripe"))).toBe(false));

test("any heading containing the word opens a gate section", () => {
  expect(readGate(`## Assumptions\n${ACCEPTED}\n### Design assumptions\n- [ ] X\n${OQ_NONE}`).unconfirmed).toEqual(["X"]);
  expect(readGate(`## Assumptions (unconfirmed)\n- [ ] X\n${OQ_NONE}`).unconfirmed).toEqual(["X"]);
  expect(readGate(`## Assumptions\n${ACCEPTED}\n#### Key assumption\n- [ ] Y\n${OQ_NONE}`).unconfirmed).toEqual(["Y"]);
  expect(readGate("## Assumptions\nNone\n###### Open question\n- Annual?\n").openQuestions).toEqual(["Annual?"]);
  expect(readGate("## Facts\n- A (CLAUDE.md)\n##### Business fact\n- Z\n").unsourced).toEqual(["Z"]);
});

test("a heading with both words is gated as open questions and does not count as assumptions", () => {
  const r = readGate(`## Assumptions and open questions\n${ACCEPTED}\n`);
  expect(r.openQuestions).toEqual(["[x] A (user, 2026-10-22)"]);
  expect(r.missingSections).toEqual(["Facts", "Assumptions"]);
  expect(readGate("## Facts and open questions\n- A (CLAUDE.md)\n").openQuestions).toEqual(["A (CLAUDE.md)"]);
});

test("a section with no content lines is empty and blocks", () => {
  const blank = readGate(`${FACTS_NONE}## Assumptions\n${ACCEPTED}\n## Open questions\n\n\n`);
  expect(blank.emptySections).toEqual(["Open questions"]);
  expect(gatePasses(blank)).toBe(false);
  expect(readGate(`## Assumptions\n${ACCEPTED}\n## Open questions\n<!-- list them, or None -->\n`).emptySections).toEqual(["Open questions"]);
  expect(readGate("## Assumptions\n## Open questions\nNone\n").emptySections).toEqual(["Assumptions"]);
});

test("only `- [x] ` at column 0 accepts: other list markers block", () => {
  for (const item of ["* [x] A (user, 2026-10-22)", "+ [x] A (user, 2026-10-22)", "1. [x] A (user, 2026-10-22)", "2) [X] A (user, 2026-10-22)"]) {
    expect(assumptions(item).unconfirmed).toEqual([item]);
  }
  expect(assumptions("-  [x] A (user, 2026-10-22)\n- [x]  B (user, 2026-10-22)").unconfirmed).toEqual([
    "[x] A (user, 2026-10-22)",
    "B (user, 2026-10-22)",
  ]);
  expect(readGate("## Assumptions\nNone\n## Open questions\n* Q1\n1) Q2\n").openQuestions).toEqual(["* Q1", "1) Q2"]);
});

test("only a bare None, with an optional period, passes as None", () => {
  for (const none of ["None", "none.", "NONE"]) {
    expect(gatePasses(readGate(`## Facts\n${none}\n## Assumptions\n${none}\n## Open questions\n${none}\n`))).toBe(true);
  }
  for (const none of ["- None", "_None._", "**None**", "* none.", "1. *None*", "  None", "None!"]) {
    expect(gatePasses(readGate(`## Facts\nNone\n## Assumptions\n${none}\n## Open questions\n${none}\n`))).toBe(false);
    expect(gatePasses(readGate(`## Facts\n${none}\n## Assumptions\nNone\n## Open questions\nNone\n`))).toBe(false);
  }
});

test("None next to another content line blocks", () => {
  expect(assumptions(`None\n${ACCEPTED}`).unconfirmed).toEqual(["None"]);
  expect(facts("None\n- A (CLAUDE.md)").unsourced).toEqual(["None"]);
  expect(readGate("## Assumptions\nNone\n## Open questions\nNone\n- Annual?\n").openQuestions).toEqual(["None", "Annual?"]);
});

test("thematic breaks are skipped", () =>
  expect(gatePasses(readGate(`## Facts\nNone\n---\n## Assumptions\n${ACCEPTED}\n\n---\n\n## Open questions\nNone\n***\n___\n`))).toBe(true));

test("a tab-indented note under an accepted item blocks", () =>
  expect(assumptions(`${ACCEPTED}\n\t- source: alex`).unconfirmed).toEqual(["source: alex"]));

test("any box other than [x] is unconfirmed", () =>
  expect(assumptions(`${ACCEPTED}\n  - [~] B\n  - [-] C\n  - [] D\n- [x]E`).unconfirmed).toEqual(["[~] B", "[-] C", "[] D", "[x]E"]));

test("a checked box in open questions still counts as an open question", () =>
  expect(readGate("## Assumptions\nNone\n## Open questions\n- [x] Annual billing?\n  - [ ] Seats?\n").openQuestions).toEqual(["[x] Annual billing?", "[ ] Seats?"]));

test("a fence inside a gate section blocks, and headings inside a fence are not headings", () => {
  const example = readGate(`## Problem\n\`\`\`md\n${PASSING_DOC}\`\`\`\n`);
  expect(example.missingSections).toEqual(["Facts", "Assumptions", "Open questions"]);
  expect(example.openQuestions).toEqual([]);
  expect(gatePasses(example)).toBe(false);
  expect(assumptions(`${ACCEPTED}\n\`\`\`sh\nnpm i\n\`\`\``).unconfirmed).toEqual(["```sh", "npm i", "```"]);
  expect(assumptions(`${ACCEPTED}\n\`\`\`md\n## Open questions\nNone\n\`\`\``).unconfirmed).toEqual(["```md", "## Open questions", "None", "```"]);
  expect(facts("- A (CLAUDE.md)\n```\n- B\n```").unsourced).toEqual(["```", "B", "```"]);
});

test("an unclosed template comment hides nothing", () =>
  expect(gatePasses(readGate(`${FACTS_NONE}## Assumptions\n${ACCEPTED}\n<!-- list them\n- [ ] B\n## Open questions\nNone\n`))).toBe(false));

test("a leading BOM does not hide the first heading", () =>
  expect(gatePasses(readGate(`﻿${PASSING_DOC}`))).toBe(true));

test("a nested line under an accepted item blocks even when it reads like a note", () =>
  expect(assumptions(`${ACCEPTED}\n  - Also assumes B`).unconfirmed).toEqual(["Also assumes B"]));

test.each(["  - [✔️] B", "  - [🟥] B", "  - [ x ] B", "  - **[ ]** B", "  [ ] B"])("nested %p under an accepted item blocks", (line) => {
  const r = assumptions(`${ACCEPTED}\n${line}`);
  expect(gatePasses(r)).toBe(false);
  expect(r.unconfirmed).toHaveLength(1);
});

test("an unclosed fence is unsupported markup even when it hides a later gate heading", () => {
  const r = readGate(`${PASSING_DOC}## Notes\n\`\`\`\n### Design assumptions\n- [ ] B\n`);
  expect(r.unsupported).toEqual(["```"]);
  expect(gatePasses(r)).toBe(false);
});

test("any heading with the word question opens an open questions section", () => {
  const r = readGate(`${PASSING_DOC}## Unresolved questions\n- Annual?\n`);
  expect(r.openQuestions).toEqual(["Annual?"]);
});

test("a level 1 heading never opens a gate section", () => {
  const r = readGate(`${PASSING_DOC}# Assumptions\n- [ ] B\n# Facts\n- C\n`);
  expect(r.unconfirmed).toEqual([]);
  expect(r.unsourced).toEqual([]);
  expect(gatePasses(r)).toBe(true);
});

test("a level 1 heading still ends a gate section", () =>
  expect(readGate(`## Assumptions\n${ACCEPTED}\n# Appendix\n- [ ] B\n## Open questions\nNone\n`).unconfirmed).toEqual([]));

test("a spec titled with the word questions passes with valid sections", () => {
  const spec = `# Pre-booking access questions\n\n- Size: mid\n- Feature: access-questions\n\n## Problem\nHosts learn about access needs too late.\n\n## Facts\n- Two beta clients (.fbs/context.md)\n\n## Assumptions\n${ACCEPTED}\n\n## Open questions\nNone\n\n## Decision log\n- 2026-10-22: Ask before the booking. Why: hosts prepare.\n`;
  expect(gatePasses(readGate(spec))).toBe(true);
});

test("a heading indented up to three spaces is gated", () => {
  const r = readGate(`${PASSING_DOC}## Notes\n  ### Design assumptions\n- [ ] B\n`);
  expect(r.unconfirmed).toEqual(["B"]);
});

test("a multi-line comment inside Assumptions blocks", () => {
  const r = assumptions(`${ACCEPTED}\n<!--\n- [ ] B\n-->`);
  expect(gatePasses(r)).toBe(false);
  expect(r.unconfirmed).toEqual(["<!--", "B", "-->"]);
});

test("an indented single-line comment blocks", () =>
  expect(assumptions(`${ACCEPTED}\n  <!-- note -->`).unconfirmed).toEqual(["<!-- note -->"]));

test("a nested gate section counts as content for its parent", () => {
  expect(readGate(`${FACTS_NONE}## Assumptions\n### Billing assumptions\n${ACCEPTED}\n## Open questions\nNone\n`)).toEqual(CLEAN);
  expect(readGate(`## Facts\n### Billing facts\n- A (CLAUDE.md)\n## Assumptions\nNone\n${OQ_NONE}`)).toEqual(CLEAN);
});

test("a deeper heading that is not a gate heading is skipped and the section continues", () => {
  expect(assumptions(`${ACCEPTED}\n### Billing\n- [ ] B`).unconfirmed).toEqual(["B"]);
  expect(gatePasses(assumptions(`${ACCEPTED}\n### Billing\n- [x] B (user, 2026-10-22)`))).toBe(true);
  expect(facts("- A (CLAUDE.md)\n### Billing\n- B").unsourced).toEqual(["B"]);
});

test("a nested gate section ends at a sibling heading and the parent continues", () =>
  expect(assumptions(`### Billing assumptions\n${ACCEPTED}\n### Notes\nsee the design`).unconfirmed).toEqual(["see the design"]));

test("a lone carriage return is a line break", () => {
  const r = readGate(`${FACTS_NONE}## Assumptions\n${ACCEPTED}\r- [ ] Many clients in prod\n## Open questions\nNone\n`);
  expect(r.unconfirmed).toEqual(["Many clients in prod"]);
  expect(gatePasses(r)).toBe(false);
});

test("a heading needs a space or tab after the hashes, so an NBSP line stays in the section", () => {
  const r = readGate(`${FACTS_NONE}## Assumptions\n${ACCEPTED}\n## Notes\n- [ ] Many clients\n## Open questions\nNone\n`);
  expect(r.unconfirmed).toEqual(["## Notes", "Many clients"]);
  expect(gatePasses(r)).toBe(false);
  expect(gatePasses(readGate(`##\tFacts\nNone\n##\tAssumptions\n${ACCEPTED}\n## \t Open questions\nNone\n`))).toBe(true);
});

const FENCED_EXAMPLE = `${PASSING_DOC}## End\n`;

test.each([
  ["a closed backtick fence", "```md\n", "```\n"],
  ["a closed tilde fence", "~~~md\n", "~~~\n"],
  ["a longer closing fence", "```md\n", "`````\n"],
])("gate headings inside %s do not count, and the real sections are missing", (_, open, close) => {
  const r = readGate(`# Spec\n## Design\n${open}${FENCED_EXAMPLE}${close}## Risks\n- [ ] We assume many clients\n`);
  expect(r.missingSections).toEqual(["Facts", "Assumptions", "Open questions"]);
  expect(r.unsupported).toEqual([]);
  expect(gatePasses(r)).toBe(false);
});

test.each([
  ["an unclosed backtick fence", "```md"],
  ["an unclosed tilde fence", "~~~md"],
])("%s at end of file is unsupported markup", (_, open) => {
  const r = readGate(`# Spec\n## Design\n${open}\n${FENCED_EXAMPLE}## Risks\n- [ ] We assume many clients\n`);
  expect(r.unsupported).toEqual([open]);
  expect(r.missingSections).toEqual(["Facts", "Assumptions", "Open questions"]);
  expect(gatePasses(r)).toBe(false);
});

test("a fence only closes on its own character, at its length or longer, alone on the line", () => {
  for (const notAClose of ["~~~", "``", "```` x", "```js"]) {
    const r = readGate(`## Design\n\`\`\`\`\n${notAClose}\n${FENCED_EXAMPLE}`);
    expect(r.unsupported).toEqual(["````"]);
    expect(r.missingSections).toEqual(["Facts", "Assumptions", "Open questions"]);
  }
});

test("a backtick line with a backtick in its info string does not open a fence", () => {
  const r = readGate(`${FACTS_NONE}## Assumptions\n${ACCEPTED}\n## Notes\n\`\`\`inline\`\`\` code\n## Open questions\nNone\n`);
  expect(r).toEqual(CLEAN);
});

test("a valid spec with a fenced block in a non-gate section passes", () => {
  const spec = `## Design\n\`\`\`sh\n# install the deps\nnpm i\n## Assumptions\n- [ ] not real\n## Facts\n- not sourced\n\`\`\`\n${PASSING_DOC}`;
  expect(readGate(spec)).toEqual(CLEAN);
});

test("an indented fence is not tracked as an opener", () => {
  const r = readGate("- Example:\n  ```\nx\n## Assumptions\n- [ ] Many clients\n```\n");
  expect(r.unconfirmed).toEqual(["Many clients", "```"]);
  expect(r.unsupported).toEqual(["```"]);
  expect(gatePasses(r)).toBe(false);
});

test("a multi-line comment outside a fence is unsupported markup", () => {
  const r = readGate(`## Design\n<!--\n${PASSING_DOC}`);
  expect(r.unsupported).toEqual(["<!--"]);
  expect(gatePasses(r)).toBe(false);
});

test("a comment closed by a line the gate ignores is still unsupported markup", () => {
  const r = readGate(`## Design\n<!--\n${PASSING_DOC}<!-- -->\n## Risks\n- [ ] Many clients\n`);
  expect(r.unsupported).toEqual(["<!--"]);
  expect(gatePasses(r)).toBe(false);
});

test("a comment opened after text and left open is unsupported markup", () =>
  expect(readGate(`${PASSING_DOC}## Notes\nsee below <!-- todo\n`).unsupported).toEqual(["see below <!-- todo"]));

test("an unclosed comment inside a fence is fence content, not unsupported markup", () =>
  expect(readGate(`## Design\n\`\`\`html\n<!--\n\`\`\`\n${PASSING_DOC}`).unsupported).toEqual([]));

test("a valid spec with single-line comments passes", () => {
  const spec = `<!-- template v1 -->\n## Design\ntext <!-- note --> more\n## Facts\n<!-- each with its source -->\n- B (CLAUDE.md)\n## Assumptions\n<!-- list each -->\n${ACCEPTED}\n## Open questions\n<!-- or None -->\nNone\n`;
  expect(gatePasses(readGate(spec))).toBe(true);
});

test("a fact's source must be the user on a date, the spec, a URL or a file path", () => {
  for (const line of [
    "- A (CLAUDE.md)",
    "- A (.fbs/context.md, alex, 2026-10-22)",
    "- A (user, 2026-10-22)",
    "- A (spec)",
    "- A (docs/features/x/spec.md:47)",
    "- A (src/a.ts:3-9)",
    "- A (https://example.com/docs)",
  ])
    expect(facts(line).unsourced).toEqual([]);
  for (const line of ["- Runs only on localhost (single user)", "- A (the spec)", "- A (user)", "- A (Stripe docs)", "- A (user, 2026-10-22)."])
    expect(facts(line).unsourced).toHaveLength(1);
});
