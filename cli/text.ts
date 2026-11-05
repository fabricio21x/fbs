export function normalizeLines(markdown: string): { text: string; line: number }[] {
  return stripComments(markdown.replace(/^﻿/, "").replace(/\r/g, ""))
    .split("\n")
    .map((text, index) => ({ text: text.trimEnd(), line: index + 1 }));
}

function stripComments(source: string): string {
  let out = "";
  let pos = 0;
  while (true) {
    const start = source.indexOf("<!--", pos);
    if (start === -1) break;
    const end = commentEnd(source, start);
    // An unclosed comment is kept as literal text so the gate and the context check fail closed.
    if (end === -1) break;
    out += source.slice(pos, start) + source.slice(start, end).replace(/[^\n]/g, "");
    pos = end;
  }
  return out + source.slice(pos);
}

function commentEnd(source: string, start: number): number {
  const body = start + 4;
  if (source.startsWith(">", body)) return body + 1;
  if (source.startsWith("->", body)) return body + 2;
  const close = source.indexOf("-->", body);
  return close === -1 ? -1 : close + 3;
}
