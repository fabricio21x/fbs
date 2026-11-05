import { isValidDate } from "./date";
import { normalizeLines } from "./text";

export interface Fact {
  text: string;
  date: string;
  source: string;
  line: number;
}

export interface ContextReport {
  facts: Fact[];
  errors: string[];
  stale: Fact[];
  maxFacts: number;
}

const FACT_LINE = /^- (.+?) \((\d{4}-\d{2}-\d{2}), ([^()]+)\)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function checkContext(markdown: string, opts: { maxFacts: number; staleDays: number; today: string }): ContextReport {
  const facts: Fact[] = [];
  const errors: string[] = [];

  for (const { text, line } of normalizeLines(markdown)) {
    if (text === "" || text.startsWith("#")) continue;
    const match = FACT_LINE.exec(text);
    if (!match) {
      errors.push(`line ${line}: not a fact line: ${text}`);
      continue;
    }
    const [, factText, date, source] = match;
    if (!isValidDate(date)) {
      errors.push(`line ${line}: invalid date ${date}`);
      continue;
    }
    facts.push({ text: factText.trim(), date, source, line });
  }

  if (facts.length > opts.maxFacts) {
    errors.push(`${facts.length} facts, limit ${opts.maxFacts}: prune a fact or promote it to CLAUDE.md`);
  }

  const today = Date.parse(opts.today);
  const stale = facts.filter((fact) => Math.floor((today - Date.parse(fact.date)) / DAY_MS) > opts.staleDays);

  return { facts, errors, stale, maxFacts: opts.maxFacts };
}
