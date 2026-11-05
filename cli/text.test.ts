import { expect, test } from "bun:test";
import { normalizeLines } from "./text";

const texts = (markdown: string) => normalizeLines(markdown).map((l) => l.text);

test("an inline comment is dropped and the line end trimmed", () =>
  expect(normalizeLines("a <!-- note -->  \nb")).toEqual([
    { text: "a", line: 1 },
    { text: "b", line: 2 },
  ]));

test("a multi-line comment keeps the line numbers of later lines", () =>
  expect(normalizeLines("a\n<!-- one\ntwo\nthree -->\nb")).toEqual([
    { text: "a", line: 1 },
    { text: "", line: 2 },
    { text: "", line: 3 },
    { text: "", line: 4 },
    { text: "b", line: 5 },
  ]));

test("an unclosed comment hides nothing: the opener and later lines come back as text", () =>
  expect(normalizeLines("a <!-- x --> b\nc <!-- open\n- [ ] hidden\n")).toEqual([
    { text: "a  b", line: 1 },
    { text: "c <!-- open", line: 2 },
    { text: "- [ ] hidden", line: 3 },
    { text: "", line: 4 },
  ]));

test("<!--> and <!---> are complete empty comments", () => {
  expect(texts("a<!-->b\n- [ ] B")).toEqual(["ab", "- [ ] B"]);
  expect(texts("a<!--->b\n- [ ] B")).toEqual(["ab", "- [ ] B"]);
  expect(texts("a<!---->b")).toEqual(["ab"]);
});

test("a leading BOM and CRLF are stripped", () =>
  expect(normalizeLines("﻿## Assumptions\r\n- [x] A\r\n")).toEqual([
    { text: "## Assumptions", line: 1 },
    { text: "- [x] A", line: 2 },
    { text: "", line: 3 },
  ]));

test("blank lines are kept and leading indentation survives", () =>
  expect(texts("a\n\n   \n  - b\n\t- c")).toEqual(["a", "", "", "  - b", "\t- c"]));
