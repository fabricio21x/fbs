export interface GateResult {
  missingSections: string[];
  emptySections: string[];
  unsourced: string[];
  unconfirmed: string[];
  openQuestions: string[];
  unsupported: string[];
  /** Problems with the design's work units, checked against the spec; always empty for a spec. */
  workUnits: string[];
}

type SectionKind = "Facts" | "Assumptions" | "Open questions";

interface Section {
  kind: SectionKind;
  level: number;
  lines: string[];
  hasNested: boolean;
}

// The gate is a strict allow-list over raw lines, so a line it doesn't recognise blocks rather than passes.
export const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const FENCE_OPEN = /^(`{3,}(?!.*`)|~{3,})/;
const IGNORED = /^(?:|-{3,}|\*{3,}|_{3,}|<!--(?:(?!-->).)*-->)$/;
export const NONE = /^none\.?$/i;

// A source is the user on a date, the spec, a URL, or a file path (optionally :line), then optional ", <detail>".
const SOURCE = String.raw`(?:user,\s*\d{4}-\d{2}-\d{2}|spec|https?://[^\s()]+|[\w.\-/]*[\w-]\.[A-Za-z]\w*(?::\d+(?:-\d+)?)?)(?:,[^()]*)?`;

// The one passing line shape per kind: a sourced fact without a checkbox, or an unknown the user accepted on a date.
const PASSING: Record<SectionKind, RegExp | null> = {
  Facts: new RegExp(String.raw`^- (?!\[.?\])\S.*\(\s*${SOURCE}\s*\)$`),
  Assumptions: /^- \[[xX]\] \S.*\(\s*user,\s*\d{4}-\d{2}-\d{2}\s*\)$/,
  "Open questions": null,
};
const PREFIX: Record<SectionKind, RegExp> = { Facts: /^- /, Assumptions: /^- (?:\[[ xX]\] )?/, "Open questions": /^- / };
const FIELD = { Facts: "unsourced", Assumptions: "unconfirmed", "Open questions": "openQuestions" } as const;

function gateKind(title: string): SectionKind | null {
  if (/\bquestions?\b/i.test(title)) return "Open questions";
  if (/\bassumptions?\b/i.test(title)) return "Assumptions";
  if (/\bfacts?\b/i.test(title)) return "Facts";
  return null;
}

export function rawLines(markdown: string): string[] {
  return markdown
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd());
}

export function fenceOpener(line: string): string | null {
  return FENCE_OPEN.exec(line)?.[1] ?? null;
}

export function closesFence(line: string, fence: string): boolean {
  const close = /^ {0,3}(`{3,}|~{3,})$/.exec(line);
  return close !== null && close[1][0] === fence[0] && close[1].length >= fence.length;
}

function opensUnclosedComment(line: string): boolean {
  const start = line.lastIndexOf("<!--");
  return start !== -1 && !line.includes("-->", start + 4);
}

function collectSections(markdown: string): { sections: Section[]; unsupported: string[] } {
  const sections: Section[] = [];
  const unsupported: string[] = [];
  const open: Section[] = [];
  let fence: { marker: string; line: string } | null = null;
  for (const line of rawLines(markdown)) {
    const opener: string | null = fence ? null : fenceOpener(line);
    const fenceLine = fence !== null || opener !== null;
    if (fence) {
      if (closesFence(line, fence.marker)) fence = null;
    } else if (opener) {
      fence = { marker: opener, line };
    } else if (opensUnclosedComment(line)) {
      unsupported.push(line);
    }
    const heading = fenceLine ? null : HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      while (open.length > 0 && open[open.length - 1].level >= level) open.pop();
      // Level 1 is the document title, which may say "questions" without being a gate section.
      const kind = level === 1 ? null : gateKind(heading[2]);
      if (kind) {
        const parent = open[open.length - 1];
        if (parent) parent.hasNested = true;
        const section: Section = { kind, level, lines: [], hasNested: false };
        sections.push(section);
        open.push(section);
      }
      continue;
    }
    open[open.length - 1]?.lines.push(line);
  }
  if (fence) unsupported.push(fence.line);
  return { sections, unsupported };
}

function blockerText(line: string, kind: SectionKind): string {
  const trimmed = line.trim();
  return trimmed.replace(PREFIX[kind], "").trim() || trimmed;
}

/** Return the blocking lines of a section, or null when it has no content at all. */
function blockers(section: Section): string[] | null {
  const content = section.lines.filter((line) => !IGNORED.test(line));
  if (content.length === 0 && !section.hasNested) return null;
  if (content.length === 1 && !section.hasNested && NONE.test(content[0])) return [];
  const passing = PASSING[section.kind];
  const passes = (line: string) => passing !== null && passing.test(line);
  return content.filter((line) => !passes(line)).map((line) => blockerText(line, section.kind));
}

export function readGate(markdown: string): GateResult {
  const { sections, unsupported } = collectSections(markdown);
  const result: GateResult = { missingSections: [], emptySections: [], unsourced: [], unconfirmed: [], openQuestions: [], unsupported, workUnits: [] };
  for (const section of sections) {
    const lines = blockers(section);
    if (lines === null) result.emptySections.push(section.kind);
    else result[FIELD[section.kind]].push(...lines);
  }
  const kinds: SectionKind[] = ["Facts", "Assumptions", "Open questions"];
  result.missingSections = kinds.filter((kind) => !sections.some((s) => s.kind === kind));
  return result;
}

export function gatePasses(r: GateResult): boolean {
  return r.missingSections.length + r.emptySections.length + r.unsourced.length + r.unconfirmed.length + r.openQuestions.length + r.unsupported.length + r.workUnits.length === 0;
}
