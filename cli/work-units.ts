import { closesFence, fenceOpener, HEADING, NONE, rawLines } from "./spec-gate";

/** One PR of a stacked feature, from the design's `## Work units`. */
export interface WorkUnit {
  number: number;
  name: string;
  /** Acceptance criteria by their 1-based position in the spec. */
  covers: number[];
  dependsOn: number[];
}

/** `units` is null when the design has no Work units section and empty for `None`; `problems` lists what doesn't parse. */
export interface ParsedWorkUnits {
  units: WorkUnit[] | null;
  problems: string[];
}

const UNIT_HEADING = /^U([1-9][0-9]*):\s+(\S.*)$/;
const FIELDS = [
  { label: "Covers", item: /^AC([1-9][0-9]*)$/i, shape: "AC<i>" },
  { label: "Depends on", item: /^U([1-9][0-9]*)$/i, shape: "U<k>" },
] as const;

export function parseWorkUnits(design: string): ParsedWorkUnits {
  const body = sectionLines(design, "work units");
  if (body === null) return { units: null, problems: [] };
  const content = body.filter((line) => line.trim() !== "");
  if (content.length === 1 && NONE.test(content[0].trim())) return { units: [], problems: [] };

  const problems: string[] = [];
  const blocks = unitBlocks(body);
  if (blocks.length === 0) return { units: [], problems: ["write one ### U<n>: <name> per unit, or None when the feature ships as one PR"] };

  const units = blocks.map(({ heading, lines }, index): WorkUnit => {
    const expected = index + 1;
    const match = UNIT_HEADING.exec(heading);
    if (match === null) problems.push(`### ${heading} must be ### U${expected}: <name>`);
    else if (Number(match[1]) !== expected) problems.push(`### ${heading} is out of order: expected U${expected}`);
    const number = match === null ? expected : Number(match[1]);
    const [covers, dependsOn] = FIELDS.map(({ label, item, shape }) => {
      const prefix = new RegExp(`^- ${label}:(.*)$`, "i");
      const values = lines.flatMap((line) => prefix.exec(line)?.[1].trim() ?? []);
      if (values.length !== 1) {
        problems.push(`U${number} needs exactly one "- ${label}:" line, found ${values.length}`);
        return [];
      }
      if (/^none$/i.test(values[0])) return [];
      const items = values[0].split(",").map((part) => item.exec(part.trim()));
      if (items.some((found) => found === null)) {
        problems.push(`U${number} ${label}: "${values[0]}" must be ${shape} references separated by commas, or none`);
        return [];
      }
      return items.map((found) => Number((found as RegExpExecArray)[1]));
    });
    return { number, name: match?.[2] ?? heading, covers, dependsOn };
  });
  return { units, problems };
}

/** The `###` blocks of the Work units section, each with the lines under its heading. */
function unitBlocks(body: string[]): { heading: string; lines: string[] }[] {
  const blocks: { heading: string; lines: string[] }[] = [];
  for (const line of body) {
    const heading = HEADING.exec(line);
    if (heading?.[1].length === 3) blocks.push({ heading: heading[2].trim(), lines: [] });
    else blocks[blocks.length - 1]?.lines.push(line);
  }
  return blocks;
}

/**
 * Unit `n`'s block of the design's Work units as written, comments and fenced blocks included, without trailing blank
 * lines; null when no `### U<n>:` heading or more than one heads it.
 */
export function unitSection(design: string, n: number): string | null {
  const body = section(design, "work units") ?? [];
  const starts = body.flatMap(({ text }, i) => (text !== null && HEADING.exec(text)?.[1].length === 3 ? [i] : []));
  const own = starts.filter((i) => UNIT_HEADING.exec((HEADING.exec(body[i].text as string) as RegExpExecArray)[2].trim())?.[1] === String(n));
  if (own.length !== 1) return null;
  const end = starts.find((i) => i > own[0]) ?? body.length;
  return joinRaw(body.slice(own[0], end));
}

function joinRaw(lines: ScannedLine[]): string {
  const raw = lines.map((line) => line.raw);
  while (raw.length > 0 && raw[raw.length - 1].trim() === "") raw.pop();
  return raw.join("\n");
}

/**
 * One `- [ ]` or `- [x]` line of the spec's acceptance criteria; struck through (`~~`) it was dropped but keeps its
 * position, and starting with `(rollout)` it can only be checked after the deploy.
 */
export interface AcceptanceCriterion {
  text: string;
  dropped: boolean;
  rollout: boolean;
}

/** The spec's acceptance criteria in order, so `AC<i>` is the i-th. */
export function acceptanceCriteria(spec: string): AcceptanceCriterion[] {
  return criterionItems(spec).map(({ text }) => ({ text, dropped: text.startsWith("~~"), rollout: /^\(rollout\)\s/i.test(text) }));
}

/** Each acceptance criterion as written, with every line under it up to the next criterion; `AC<i>` is the i-th. */
export function criterionBlocks(spec: string): string[] {
  return criterionItems(spec).map(({ lines }) => joinRaw(lines));
}

function criterionItems(spec: string): { text: string; lines: ScannedLine[] }[] {
  const items: { text: string; lines: ScannedLine[] }[] = [];
  for (const line of section(spec, "acceptance criteria") ?? []) {
    const text = line.text === null ? undefined : /^- \[[ xX]\]\s+(.*)$/.exec(line.text)?.[1];
    if (text !== undefined) items.push({ text, lines: [line] });
    else items[items.length - 1]?.lines.push(line);
  }
  return items;
}

/** The design's work-unit problems: parsing, then references, then each criterion still in the spec covered by exactly one unit. */
export function workUnitProblems(design: string, spec: string): string[] {
  const { units, problems } = parseWorkUnits(design);
  if (units === null || units.length === 0) return problems;
  const criteria = acceptanceCriteria(spec);
  const numbers = units.map((unit) => unit.number);
  for (const unit of units) {
    for (const ac of unit.covers) {
      if (ac > criteria.length) problems.push(`U${unit.number} covers AC${ac}, but the spec has ${criteria.length} acceptance criteria`);
      else if (criteria[ac - 1].dropped) problems.push(`U${unit.number} covers AC${ac}, which the spec dropped`);
    }
    for (const dep of unit.dependsOn) {
      if (!numbers.includes(dep)) problems.push(`U${unit.number} depends on U${dep}, which isn't a unit`);
      else if (dep >= unit.number) problems.push(`U${unit.number} depends on U${dep}; a unit depends only on lower-numbered units`);
    }
  }
  for (let ac = 1; ac <= criteria.length; ac++) {
    if (criteria[ac - 1].dropped) continue;
    const by = units.filter((unit) => unit.covers.includes(ac)).map((unit) => `U${unit.number}`);
    if (by.length === 0) problems.push(`AC${ac} isn't covered by any unit`);
    if (by.length > 1) problems.push(`AC${ac} is covered by ${by.join(", ")}; each criterion belongs to exactly one unit`);
  }
  return problems;
}

/** A raw line, and its text outside comments and fenced blocks; null for a line in a fence or a comment, or a fence line. */
interface ScannedLine {
  raw: string;
  text: string | null;
}

function scan(markdown: string): ScannedLine[] {
  const lines: ScannedLine[] = [];
  let fence: string | null = null;
  let inComment = false;
  for (const raw of rawLines(markdown)) {
    const hidden = () => lines.push({ raw, text: null });
    if (fence !== null) {
      if (closesFence(raw, fence)) fence = null;
      hidden();
      continue;
    }
    let line = raw;
    if (inComment) {
      const end = line.indexOf("-->");
      if (end === -1) {
        hidden();
        continue;
      }
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--.*?-->/g, "");
    const open = line.indexOf("<!--");
    if (open !== -1) {
      line = line.slice(0, open);
      inComment = true;
    }
    line = line.trimEnd();
    const opener = fenceOpener(line);
    if (opener !== null) fence = opener;
    lines.push({ raw, text: opener === null ? line : null });
  }
  return lines;
}

/** The lines under the first `## <title>`, up to the next level 1 or 2 heading; null when it's missing. */
function section(markdown: string, title: string): ScannedLine[] | null {
  const lines = scan(markdown);
  let start: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].text === null ? null : HEADING.exec(lines[i].text as string);
    if (heading === null || heading[1].length > 2) continue;
    if (start !== null) return lines.slice(start, i);
    if (heading[1].length === 2 && heading[2].trim().toLowerCase() === title) start = i + 1;
  }
  return start === null ? null : lines.slice(start);
}

/** The text of the lines under the first `## <title>`, without comments or fenced blocks; null when it's missing. */
function sectionLines(markdown: string, title: string): string[] | null {
  return section(markdown, title)?.flatMap(({ text }) => (text === null ? [] : [text])) ?? null;
}
