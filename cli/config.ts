import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileInTree, rootFor } from "./git";

export interface FbsConfig {
  featuresDir: string;
  context: { maxFacts: number; staleDays: number };
  afk?: AfkConfig;
  tracker?: Tracker;
  camp?: { autoFixRounds?: number };
}

/** The project's issue tracker; `none` says it has none, which differs from unset. */
export type Tracker = { kind: "linear"; team: string } | { kind: "github" } | { kind: "none" };

/** Extra globs for afk-guard's migration, infra and check-config flags, and the commands the afk guard denies. */
export interface AfkConfig {
  migrations?: string[];
  infra?: string[];
  checkConfig?: string[];
  deny?: string[];
}

export const DEFAULT_CONFIG: FbsConfig = {
  featuresDir: "docs/features",
  context: { maxFacts: 25, staleDays: 30 },
};

export class ConfigError extends Error {}

export const CONFIG_PATH = ".fbs/config.json";

export function loadConfig(repoRoot: string): FbsConfig {
  const path = join(repoRoot, CONFIG_PATH);
  return existsSync(path) ? parseConfig(readFileSync(path, "utf8"), path) : structuredClone(DEFAULT_CONFIG);
}

/** The config of the repo `cwd` is in, read from the main worktree when git ignores it. */
export function projectConfig(cwd: string): FbsConfig {
  return loadConfig(rootFor(cwd, CONFIG_PATH));
}

/** The config committed at `commit`, which edits made after it can't loosen. */
export function configAt(cwd: string, commit: string): FbsConfig {
  const file = fileInTree(cwd, commit, CONFIG_PATH);
  return file.kind === "file" ? parseConfig(file.content, `${CONFIG_PATH} at ${commit.slice(0, 12)}`) : structuredClone(DEFAULT_CONFIG);
}

function parseConfig(text: string, path: string): FbsConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`invalid config ${path}: ${(e as Error).message}`);
  }
  const invalid = (reason: string) => new ConfigError(`invalid config ${path}: ${reason}`);
  if (!isObject(raw)) throw invalid("expected a JSON object");

  const config = structuredClone(DEFAULT_CONFIG);
  if (raw.featuresDir !== undefined) {
    if (typeof raw.featuresDir !== "string") throw invalid("featuresDir must be a string");
    if (!isSafeFeaturesDir(raw.featuresDir)) throw invalid("featuresDir must be a relative path inside the repo, without .. and outside .git");
    config.featuresDir = raw.featuresDir;
  }
  if (raw.context !== undefined) {
    if (!isObject(raw.context)) throw invalid("context must be an object");
    for (const key of ["maxFacts", "staleDays"] as const) {
      const value = raw.context[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || (value as number) < 0) throw invalid(`context.${key} must be a non-negative integer`);
      config.context[key] = value as number;
    }
  }
  if (raw.afk !== undefined) {
    if (!isObject(raw.afk)) throw invalid("afk must be an object");
    const afk: AfkConfig = {};
    for (const key of ["migrations", "infra", "checkConfig", "deny"] as const) {
      const value = raw.afk[key];
      if (value === undefined) continue;
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw invalid(`afk.${key} must be an array of strings`);
      afk[key] = value;
    }
    config.afk = afk;
  }
  if (raw.tracker !== undefined) config.tracker = parseTracker(raw.tracker, invalid);
  if (raw.camp !== undefined) {
    if (!isObject(raw.camp)) throw invalid("camp must be an object");
    const rounds = raw.camp.autoFixRounds;
    if (rounds !== undefined && (!Number.isInteger(rounds) || (rounds as number) < 1)) throw invalid("camp.autoFixRounds must be a positive integer");
    config.camp = rounds === undefined ? {} : { autoFixRounds: rounds as number };
  }
  return config;
}

function parseTracker(tracker: unknown, invalid: (reason: string) => ConfigError): Tracker {
  const shape = 'tracker must be {"kind": "linear", "team": "<key>"}, {"kind": "github"} or {"kind": "none"}';
  if (!isObject(tracker)) throw invalid(shape);
  const keys = Object.keys(tracker).sort().join();
  if (tracker.kind === "linear" && keys === "kind,team" && typeof tracker.team === "string" && tracker.team.trim() !== "") return { kind: "linear", team: tracker.team };
  if ((tracker.kind === "github" || tracker.kind === "none") && keys === "kind") return { kind: tracker.kind };
  throw invalid(shape);
}

function isSafeFeaturesDir(dir: string): boolean {
  return !posix.isAbsolute(dir) && !dir.includes("..") && !hasGitSegment(dir);
}

/** True when any segment of the slash-separated path is `.git`, in any case. */
export function hasGitSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.toLowerCase() === ".git");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
