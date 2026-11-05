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
  const blocks: { heading: string; lines: string[] }[] = [];
  for (const line of body) {
    const heading = HEADING.exec(line);
    if (heading?.[1].length === 3) blocks.push({ heading: heading[2].trim(), lines: [] });
    else blocks[blocks.length - 1]?.lines.push(line);
  }
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

/** One `- [ ]` or `- [x]` line of the spec's acceptance criteria; struck through (`~~`) it was dropped but keeps its position. */
export interface AcceptanceCriterion {
  text: string;
  dropped: boolean;
}

/** The spec's acceptance criteria in order, so `AC<i>` is the i-th. */
export function acceptanceCriteria(spec: string): AcceptanceCriterion[] {
  return (sectionLines(spec, "acceptance criteria") ?? []).flatMap((line) => {
    const text = /^- \[[ xX]\]\s+(.*)$/.exec(line)?.[1];
    return text === undefined ? [] : [{ text, dropped: text.startsWith("~~") }];
  });
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

/** The lines under the first `## <title>`, up to the next level 1 or 2 heading, without comments or fenced blocks; null when it's missing. */
function sectionLines(markdown: string, title: string): string[] | null {
  let lines: string[] | null = null;
  let fence: string | null = null;
  let inComment = false;
  for (const raw of rawLines(markdown)) {
    if (fence !== null) {
      if (closesFence(raw, fence)) fence = null;
      continue;
    }
    let line = raw;
    if (inComment) {
      const end = line.indexOf("-->");
      if (end === -1) continue;
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
    if (opener !== null) {
      fence = opener;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null && heading[1].length <= 2) {
      if (lines !== null) return lines;
      if (heading[1].length === 2 && heading[2].trim().toLowerCase() === title) lines = [];
      continue;
    }
    lines?.push(line);
  }
  return lines;
}
