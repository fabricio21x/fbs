import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectConfig } from "./config";
import { gitCommonDir } from "./git";
import { campMarkerPath } from "./guard";
import { featureUnits, isUnit, readFeature } from "./status";

export const DEFAULT_AUTO_FIX_ROUNDS = 2;

export const COUNTS = ["in", "fixed", "declined", "followups", "asked"] as const;
export type Counts = Record<(typeof COUNTS)[number], number>;

export interface Round extends Counts {
  /** Numbered within its unit, or within the camp when it has no unit. */
  number: number;
  date: string;
  unit?: string;
  note?: string;
}

/** The camp file: its existence is also the never-merge guard's switch. */
export interface CampState {
  autoFixRounds: number;
  rounds: Round[];
  /** The scopes (a unit's slug, else the camp's) whose checkpoint was held. */
  checkpoints: string[];
}

/** A valid finding left out of scope, kept beside the camp file so it outlives the camp until a ticket is filed. */
export interface Followup {
  /** 1-based, what `camp followup --filed` names. */
  number: number;
  thread: string;
  summary: string;
  why?: string;
  unit?: string;
  /** The round it came in: the scope's recorded rounds plus one. */
  round: number;
  at: string;
  /** open until the user files a ticket for it (filed, with its link) or declines it. */
  status: "open" | "filed" | "declined";
  link?: string;
}

export type Phase = "auto" | "checkpoint" | "blockers-only";

export class CampError extends Error {}

export function campPhase(state: CampState, scope: string, slug: string): Phase {
  const fixRounds = state.rounds.filter((round) => (round.unit ?? slug) === scope && round.fixed > 0).length;
  if (fixRounds < state.autoFixRounds) return "auto";
  return state.checkpoints.includes(scope) ? "blockers-only" : "checkpoint";
}

/** Create the camp, or on a resume keep its rounds; an explicit budget replaces the recorded one. */
export function startCamp(cwd: string, slug: string, autoFixRounds: number | undefined, warn: (s: string) => void): object {
  const rec = readFeature(cwd, slug);
  const units = isUnit(rec) ? [] : featureUnits(cwd, slug);
  // A camp file would switch the never-merge guard back on for work that is already merged.
  if (rec.landed !== undefined || (units.length > 0 && units.every((unit) => unit.landed !== undefined))) throw new CampError(`${slug} has landed; there is nothing to camp`);
  const path = campMarkerPath(gitCommonDir(cwd), slug);
  const existing = existsSync(path) ? readState(path, warn) : null;
  const budget = autoFixRounds ?? existing?.autoFixRounds ?? projectConfig(cwd).camp?.autoFixRounds ?? DEFAULT_AUTO_FIX_ROUNDS;
  const state: CampState = { autoFixRounds: budget, rounds: existing?.rounds ?? [], checkpoints: existing?.checkpoints ?? [] };
  writeState(path, state);
  return view(cwd, state, slug, undefined);
}

/** Append a round and say what the next one may do: continue, checkpoint (until it is recorded), or blockers-only. */
export function recordRound(cwd: string, slug: string, unit: string | undefined, counts: Counts, note: string | undefined, today: string, warn: (s: string) => void): "continue" | Exclude<Phase, "auto"> {
  const { path, state } = openCamp(cwd, slug, unit, warn);
  const scope = unit ?? slug;
  const number = state.rounds.filter((round) => (round.unit ?? slug) === scope).length + 1;
  state.rounds.push({ number, date: today, ...(unit !== undefined && { unit }), ...counts, ...(note !== undefined && { note }) });
  writeState(path, state);
  const phase = campPhase(state, scope, slug);
  return phase === "auto" ? "continue" : phase;
}

/** Record that the checkpoint was held, so later rounds (and a resume) are blockers-only. */
export function recordCheckpoint(cwd: string, slug: string, unit: string | undefined, warn: (s: string) => void): Phase {
  const { path, state } = openCamp(cwd, slug, unit, warn);
  const scope = unit ?? slug;
  const phase = campPhase(state, scope, slug);
  if (phase === "auto") throw new CampError(`no checkpoint is due for ${scope}: the budget is ${state.autoFixRounds} ${state.autoFixRounds === 1 ? "round" : "rounds"} that fixed something`);
  if (phase === "checkpoint") {
    state.checkpoints.push(scope);
    writeState(path, state);
  }
  return "blockers-only";
}

export function showCamp(cwd: string, slug: string, unit: string | undefined, warn: (s: string) => void): object {
  return view(cwd, openCamp(cwd, slug, unit, warn).state, slug, unit);
}

function view(cwd: string, state: CampState, slug: string, unit: string | undefined): object {
  const units = [...new Set(state.rounds.flatMap((round) => (round.unit === undefined ? [] : [round.unit])))];
  return {
    slug,
    ...(unit !== undefined && { unit }),
    autoFixRounds: state.autoFixRounds,
    phase: campPhase(state, unit ?? slug, slug),
    ...(units.length > 0 && { units: Object.fromEntries(units.map((name) => [name, campPhase(state, name, slug)])) }),
    checkpoints: state.checkpoints,
    rounds: state.rounds,
    ...followupLists(readFollowups(followupsPath(cwd, slug))),
  };
}

/** Remove the camp file, which switches the never-merge guard off; its follow-ups stay. */
export function stopCamp(cwd: string, slug: string): void {
  readFeature(cwd, slug);
  rmSync(campMarkerPath(gitCommonDir(cwd), slug), { force: true });
}

export function addFollowup(cwd: string, slug: string, unit: string | undefined, found: Pick<Followup, "thread" | "summary" | "why">, today: string, warn: (s: string) => void): Followup {
  const { state } = openCamp(cwd, slug, unit, warn);
  const scope = unit ?? slug;
  const path = followupsPath(cwd, slug);
  const followups = readFollowups(path);
  const followup: Followup = {
    number: followups.length + 1,
    thread: found.thread,
    summary: found.summary,
    ...(found.why !== undefined && { why: found.why }),
    ...(unit !== undefined && { unit }),
    round: state.rounds.filter((round) => (round.unit ?? slug) === scope).length + 1,
    at: today,
    status: "open",
  };
  writeJson(path, [...followups, followup]);
  return followup;
}

/** Close follow-up `number`: filed with the ticket's link, or declined; works after the camp stopped. */
export function closeFollowup(cwd: string, slug: string, number: number, link: string | null): Followup {
  readFeature(cwd, slug);
  const path = followupsPath(cwd, slug);
  const followups = readFollowups(path);
  const followup = followups[number - 1];
  if (followup === undefined) throw new CampError(`${slug} has no follow-up ${number}; it has ${followups.length}`);
  const status = link === null ? "declined" : "filed";
  if (followup.status !== "open" && followup.status !== status) throw new CampError(`follow-up ${number} of ${slug} is already ${followup.status}`);
  followup.status = status;
  if (link !== null) followup.link = link;
  writeJson(path, followups);
  return followup;
}

/** Every follow-up, and apart the open ones, which are all a green camp still proposes. */
function followupLists(followups: Followup[]): { followups: Followup[]; openFollowups: Followup[] } {
  return { followups, openFollowups: followups.filter((followup) => followup.status === "open") };
}

function followupsPath(cwd: string, slug: string): string {
  return join(dirname(campMarkerPath(gitCommonDir(cwd), slug)), `${slug}.followups.json`);
}

function readFollowups(path: string): Followup[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw) || !raw.every(isFollowup)) throw new CampError(`invalid follow-ups file ${path}`);
  return raw;
}

function isFollowup(value: unknown): value is Followup {
  const optional = (key: string) => isObject(value) && (value[key] === undefined || typeof value[key] === "string");
  return (
    isObject(value) &&
    isCount(value.number) &&
    isCount(value.round) &&
    ["thread", "summary", "at"].every((key) => typeof value[key] === "string") &&
    ["open", "filed", "declined"].includes(value.status as string) &&
    ["why", "unit", "link"].every(optional)
  );
}

function openCamp(cwd: string, slug: string, unit: string | undefined, warn: (s: string) => void): { path: string; state: CampState } {
  readFeature(cwd, slug);
  if (unit !== undefined && !featureUnits(cwd, slug).some((rec) => rec.slug === unit)) throw new CampError(`${unit} is not a unit of ${slug}`);
  const path = campMarkerPath(gitCommonDir(cwd), slug);
  if (!existsSync(path)) throw new CampError(`no camp for ${slug}; start it with fbs camp start ${slug}`);
  const state = readState(path, warn) ?? { autoFixRounds: projectConfig(cwd).camp?.autoFixRounds ?? DEFAULT_AUTO_FIX_ROUNDS, rounds: [], checkpoints: [] };
  return { path, state };
}

// Camp files written before the CLI kept them have no fixed shape; they count as empty rather than failing a camp.
function readState(path: string, warn: (s: string) => void): CampState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = null;
  }
  const state = parseState(raw);
  if (state === null) warn(`note: ${path} isn't a camp state fbs wrote; starting from an empty one`);
  return state;
}

function parseState(raw: unknown): CampState | null {
  if (!isObject(raw) || !isCount(raw.autoFixRounds) || raw.autoFixRounds < 1 || !Array.isArray(raw.rounds) || !Array.isArray(raw.checkpoints)) return null;
  if (!raw.checkpoints.every((scope) => typeof scope === "string")) return null;
  if (!raw.rounds.every(isRound)) return null;
  return { autoFixRounds: raw.autoFixRounds, rounds: raw.rounds, checkpoints: raw.checkpoints };
}

function isRound(value: unknown): value is Round {
  return (
    isObject(value) &&
    isCount(value.number) &&
    typeof value.date === "string" &&
    (value.unit === undefined || typeof value.unit === "string") &&
    (value.note === undefined || typeof value.note === "string") &&
    COUNTS.every((key) => isCount(value[key]))
  );
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeState(path: string, state: CampState): void {
  writeJson(path, state);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}
