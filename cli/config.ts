import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileInTree, remoteUrl, rootFor } from "./git";

export interface FbsConfig {
  featuresDir: string;
  context: { maxFacts: number; staleDays: number };
  afk?: AfkConfig;
  tracker?: Tracker;
  camp?: { autoFixRounds?: number };
  /** `types` is the only branch types `fbs branch` creates here. */
  branches?: { types?: string[] };
  verify?: VerifyConfig;
  docs?: DocsConfig;
}

/**
 * The command verify and implement run as the suite, and whether green CI runs of `ciWorkflows` (required with it) on
 * the exact head count as its evidence.
 */
export interface VerifyConfig {
  suite?: string;
  ciEvidence: boolean;
  ciWorkflows?: string[];
}

/** The project's issue tracker; `none` says it has none, which differs from unset. */
export type Tracker = { kind: "linear"; team: string } | { kind: "github" } | { kind: "none" };

/** Whether feature documents are committed or stay local, and the documentation tool they are mirrored to; unset asks. */
export interface DocsConfig {
  store?: "tracked" | "local";
  publish?: Publish;
}

/** `kind` names the tool (`notion`, `confluence`, `google-docs`, …) and `parent` the page, space or folder to publish under. */
export type Publish = { kind: "none" } | { kind: string; parent: string };

/** Extra globs for afk-guard's migration, infra and check-config flags, and the commands the afk guard denies. */
export interface AfkConfig {
  migrations?: string[];
  infra?: string[];
  checkConfig?: string[];
  deny?: string[];
}

/** The conventional branch format's types, and the Conventional Commit types some repos name branches by instead. */
export const BRANCH_FAMILY: readonly string[] = ["feature", "bugfix", "hotfix", "chore"];
export const COMMIT_FAMILY: readonly string[] = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];
export const BRANCH_TYPES: readonly string[] = [...new Set([...BRANCH_FAMILY, ...COMMIT_FAMILY])];

export const DEFAULT_CONFIG: FbsConfig = {
  featuresDir: "docs/features",
  context: { maxFacts: 25, staleDays: 30 },
};

/** Every top-level key and the fields a level merges one by one; null for a key that is replaced whole. */
const KEYS: Record<string, readonly string[] | null> = {
  featuresDir: null,
  context: ["maxFacts", "staleDays"],
  afk: ["migrations", "infra", "checkConfig", "deny"],
  tracker: null,
  camp: ["autoFixRounds"],
  branches: ["types"],
  verify: ["suite", "ciEvidence", "ciWorkflows"],
  docs: ["store", "publish"],
};

/** Keys only the repo's file may set: they decide what counts as verified or allowed, so reviewers see them in the repo. */
const REPO_ONLY: readonly string[] = ["featuresDir", "afk", "verify"];

export class ConfigError extends Error {}

export const CONFIG_PATH = ".fbs/config.json";

type Raw = Record<string, unknown>;

/** The repo's `.fbs/config.json` alone, with the defaults filled in. */
export function loadConfig(repoRoot: string): FbsConfig {
  const path = join(repoRoot, CONFIG_PATH);
  return existsSync(path) ? parseConfig(readFileSync(path, "utf8"), path) : structuredClone(DEFAULT_CONFIG);
}

/** The resolved config and, for each top-level key, the levels its value came from, highest first, joined by `+`. */
export interface ResolvedConfig {
  config: FbsConfig;
  sources: Record<string, string>;
  /** True when the user's file contributed any key, which no commit then holds. */
  fromUserFile: boolean;
}

/** The resolved config of the repo `cwd` is in. */
export function projectConfig(cwd: string): FbsConfig {
  return resolveConfig(cwd).config;
}

/**
 * Each key from the first level that sets it: the repo's `.fbs/config.json` (read from the main worktree when git
 * ignores it), then the user file's block for origin's owner, then its `defaults`, then the built-in defaults. A
 * section's fields merge one by one; `tracker` and each field are taken whole.
 */
export function resolveConfig(cwd: string): ResolvedConfig {
  const levels: { name: string; raw: Raw }[] = [];
  const repoPath = join(rootFor(cwd, CONFIG_PATH), CONFIG_PATH);
  if (existsSync(repoPath)) {
    const raw = readJson(readFileSync(repoPath, "utf8"), repoPath);
    parseRaw(raw, repoPath);
    levels.push({ name: "repo", raw: raw as Raw });
  }
  const user = readUserFile();
  if (user !== null) {
    const owner = originOwner(cwd);
    const block = owner === null ? undefined : ownerKey(user.owners, owner);
    if (block !== undefined) levels.push({ name: `owner:${block}`, raw: user.owners[block] });
    if (user.defaults !== undefined) levels.push({ name: "user", raw: user.defaults });
  }
  levels.push({ name: "default", raw: structuredClone(DEFAULT_CONFIG) as unknown as Raw });

  const merged: Raw = {};
  const sources: Record<string, string> = {};
  for (const [key, fields] of Object.entries(KEYS)) {
    const setting = levels.filter((level) => level.raw[key] !== undefined);
    if (setting.length === 0) continue;
    if (fields === null) {
      merged[key] = setting[0].raw[key];
      sources[key] = setting[0].name;
      continue;
    }
    const section: Raw = {};
    const from = new Set<string>();
    for (const field of fields) {
      const winner = setting.find((level) => (level.raw[key] as Raw)[field] !== undefined);
      if (winner === undefined) continue;
      section[field] = (winner.raw[key] as Raw)[field];
      from.add(winner.name);
    }
    merged[key] = section;
    sources[key] = setting.map((level) => level.name).filter((name) => from.has(name)).join("+") || setting[0].name;
  }
  const label = `the config resolved from ${levels.map((level) => level.name).join(", ")}`;
  const fromUserFile = Object.values(sources).some((source) => source.split("+").some((name) => name === "user" || name.startsWith("owner:")));
  return { config: parseRaw(merged, label) as unknown as FbsConfig, sources, fromUserFile };
}

/** The config committed at `commit`, which edits made after it can't loosen. */
export function configAt(cwd: string, commit: string): FbsConfig {
  const file = fileInTree(cwd, commit, CONFIG_PATH);
  return file.kind === "file" ? parseConfig(file.content, `${CONFIG_PATH} at ${commit.slice(0, 12)}`) : structuredClone(DEFAULT_CONFIG);
}

/** `$XDG_CONFIG_HOME/fbs/config.json`, by default `~/.config/fbs/config.json`. */
export function userConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fbs", "config.json");
}

interface UserFile {
  path: string;
  defaults?: Raw;
  owners: Record<string, Raw>;
}

function readUserFile(): UserFile | null {
  let path: string;
  let text: string;
  try {
    path = userConfigPath();
    text = readFileSync(path, "utf8");
  } catch {
    // Missing or unreadable is none: the eval sandbox can't read $HOME.
    return null;
  }
  return parseUserFile(readJson(text, path), path);
}

/** Validate the whole user file, every block, so a typo anywhere in it is caught. */
function parseUserFile(raw: unknown, path: string): UserFile {
  const invalid = (reason: string) => new ConfigError(`invalid config ${path}: ${reason}`);
  if (!isObject(raw)) throw invalid("expected a JSON object");
  const unknown = Object.keys(raw).find((key) => key !== "defaults" && key !== "owners");
  if (unknown !== undefined) throw invalid(`unknown key ${unknown}; the file holds only defaults and owners`);
  if (raw.defaults !== undefined && !isObject(raw.defaults)) throw invalid("defaults must be an object of config keys");
  if (raw.owners !== undefined && !(isObject(raw.owners) && Object.values(raw.owners).every(isObject))) throw invalid('owners must map each owner to an object of config keys: {"owners": {"acme-co": {…}}}');
  if (raw.defaults !== undefined) checkUserBlock(raw.defaults as Raw, `${path} (defaults)`);
  for (const [owner, block] of Object.entries((raw.owners ?? {}) as Record<string, Raw>)) checkUserBlock(block, `${path} (owners.${owner})`);
  return { path, ...(raw.defaults !== undefined && { defaults: raw.defaults as Raw }), owners: (raw.owners ?? {}) as Record<string, Raw> };
}

function checkUserBlock(block: Raw, label: string): void {
  for (const [key, value] of Object.entries(block)) {
    if (REPO_ONLY.includes(key)) throw repoOnly(key, label);
    if (!Object.hasOwn(KEYS, key)) throw new ConfigError(`invalid config ${label}: unknown key ${key}`);
    const fields = KEYS[key];
    const field = fields !== null && isObject(value) ? Object.keys(value).find((name) => !fields.includes(name)) : undefined;
    if (field !== undefined) throw new ConfigError(`invalid config ${label}: unknown key ${key}.${field}`);
  }
  parseRaw(block, label);
}

function repoOnly(key: string, where: string): ConfigError {
  return new ConfigError(`invalid config ${where}: ${key} is repo-only: it decides what counts as verified or allowed, so it goes in the repo's ${CONFIG_PATH}, where reviewers see it`);
}

/** The owners block key for `owner`, matched without case as GitHub does. */
function ownerKey(owners: Raw, owner: string): string | undefined {
  return Object.keys(owners).find((key) => key.toLowerCase() === owner.toLowerCase());
}

/** The owner in origin's URL on any host, as `acme-co` in `git@github.com:acme-co/app.git`; null without origin or an owner in it. */
export function originOwner(cwd: string): string | null {
  const url = remoteUrl(cwd, "origin");
  if (url === null || /^file:/i.test(url)) return null;
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.*)$/i.exec(url)?.[1] ?? /^(?:[^@/]+@)?[^:/]+:(.*)$/.exec(url)?.[1];
  const segments = path?.split("/").filter((segment) => segment !== "") ?? [];
  return segments.length >= 2 ? segments[0] : null;
}

export type ConfigLevel = "repo" | "owner" | "user";

/**
 * Set `key` (a top-level key, or `<section>.<field>`) to the JSON `value` at one level: the repo's `.fbs/config.json`,
 * origin's owner block in the user file, or its `defaults`. `null` removes the key. Nothing is written unless the level
 * and the resolved config stay valid.
 */
export function setConfig(cwd: string, key: string, value: string, level: ConfigLevel): { set: string; level: string; path: string } {
  const [section, field, ...rest] = key.split(".");
  const fields = KEYS[section];
  if (!Object.hasOwn(KEYS, section) || rest.length > 0 || (field !== undefined && (fields === null || !fields.includes(field)))) {
    throw new ConfigError(`unknown config key ${key}; one of ${Object.entries(KEYS).flatMap(([name, list]) => [name, ...(list ?? []).map((f) => `${name}.${f}`)]).join(", ")}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError(`the value for ${key} must be JSON, such as '"local"' or '{"kind": "none"}': ${value}`);
  }

  if (level !== "repo" && REPO_ONLY.includes(section)) throw repoOnly(section, level === "owner" ? "the owner level" : "the user level");
  const owner = level === "owner" ? originOwner(cwd) : null;
  if (level === "owner" && owner === null) throw new ConfigError("--owner needs an owner in origin's URL, and this repo's origin has none");
  const path = level === "repo" ? join(rootFor(cwd, CONFIG_PATH), CONFIG_PATH) : userConfigPath();
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const file = before === null ? {} : readJson(before, path);
  const where = level === "repo" ? path : level === "user" ? `${path} (defaults)` : `${path} (owners.${owner})`;
  if (!isObject(file)) throw new ConfigError(`invalid config ${path}: expected a JSON object`);
  const owners = level === "owner" ? childOf(file, "owners", path) : {};
  const target = level === "repo" ? file : level === "user" ? childOf(file, "defaults", path) : childOf(owners, ownerKey(owners, owner as string) ?? (owner as string), path);

  if (field === undefined) assign(target, section, parsed);
  else {
    const current = target[section] === undefined ? {} : target[section];
    if (!isObject(current)) throw new ConfigError(`invalid config ${where}: ${section} must be an object`);
    assign(current, field, parsed);
    assign(target, section, Object.keys(current).length === 0 ? null : current);
  }
  if (level === "repo") parseRaw(target, where);
  else parseUserFile(file, path);
  writeAtomically(path, `${JSON.stringify(file, null, 2)}\n`);
  return { set: key, level: level === "owner" ? `owner:${owner}` : level, path };
}

/** Write through a temp file in the same dir and a rename, so a crash never leaves half a file. */
function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function childOf(parent: Raw, key: string, path: string): Raw {
  if (parent[key] === undefined) parent[key] = {};
  if (!isObject(parent[key])) throw new ConfigError(`invalid config ${path}: ${key} must be an object`);
  return parent[key] as Raw;
}

function assign(target: Raw, key: string, value: unknown): void {
  if (value === null) delete target[key];
  else target[key] = value;
}

function readJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`invalid config ${path}: ${(e as Error).message}`);
  }
}

function parseConfig(text: string, path: string): FbsConfig {
  return parseRaw(readJson(text, path), path) as unknown as FbsConfig;
}

/** Validate one level's keys and return them with the defaults filled in. */
function parseRaw(raw: unknown, path: string): Raw {
  const invalid = (reason: string) => new ConfigError(`invalid config ${path}: ${reason}`);
  if (!isObject(raw)) throw invalid("expected a JSON object");

  const config = structuredClone(DEFAULT_CONFIG);
  if (raw.featuresDir !== undefined) {
    if (typeof raw.featuresDir !== "string") throw invalid("featuresDir must be a string");
    // Normalised so the folder has one spelling, which the exclude line and the documents mode both match.
    const dir = posix.normalize(raw.featuresDir).replace(/\/+$/, "");
    if (!isSafeFeaturesDir(raw.featuresDir) || dir === "." || dir === "") throw invalid("featuresDir must be a relative path to a folder inside the repo, without .. and outside .git");
    config.featuresDir = dir;
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
  if (raw.branches !== undefined) {
    if (!isObject(raw.branches)) throw invalid("branches must be an object");
    const types = raw.branches.types;
    const valid = Array.isArray(types) && types.length > 0 && types.every((type) => BRANCH_TYPES.includes(type)) && new Set(types).size === types.length;
    if (types !== undefined && !valid) throw invalid(`branches.types must be a non-empty array of distinct types from ${BRANCH_TYPES.join(", ")}`);
    config.branches = types === undefined ? {} : { types: types as string[] };
  }
  if (raw.verify !== undefined) {
    if (!isObject(raw.verify)) throw invalid("verify must be an object");
    const { suite, ciEvidence, ciWorkflows } = raw.verify;
    if (suite !== undefined && (typeof suite !== "string" || suite.trim() === "")) throw invalid("verify.suite must be a non-empty command");
    if (ciEvidence !== undefined && typeof ciEvidence !== "boolean") throw invalid("verify.ciEvidence must be true or false");
    const names = Array.isArray(ciWorkflows) && ciWorkflows.length > 0 && ciWorkflows.every((name) => typeof name === "string" && name.trim() !== "") && new Set(ciWorkflows).size === ciWorkflows.length;
    if (ciWorkflows !== undefined && !names) throw invalid("verify.ciWorkflows must be a non-empty array of distinct workflow names");
    if (ciEvidence === true && ciWorkflows === undefined) throw invalid("verify.ciWorkflows must name the workflows whose green runs count when verify.ciEvidence is true");
    config.verify = { ...(suite !== undefined && { suite: suite as string }), ciEvidence: ciEvidence === true, ...(ciWorkflows !== undefined && { ciWorkflows: ciWorkflows as string[] }) };
  }
  if (raw.docs !== undefined) config.docs = parseDocs(raw.docs, invalid);
  return config as unknown as Raw;
}

function parseDocs(docs: unknown, invalid: (reason: string) => ConfigError): DocsConfig {
  if (!isObject(docs)) throw invalid("docs must be an object");
  const { store, publish } = docs;
  if (store !== undefined && store !== "tracked" && store !== "local") throw invalid('docs.store must be "tracked" or "local"');
  const shape = 'docs.publish must be {"kind": "none"} or {"kind": "<tool, such as notion>", "parent": "<page, space or folder URL or id>"}';
  if (publish !== undefined) {
    if (!isObject(publish)) throw invalid(shape);
    const keys = Object.keys(publish).sort().join();
    const none = publish.kind === "none" && keys === "kind";
    const tool = keys === "kind,parent" && typeof publish.kind === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(publish.kind) && publish.kind !== "none" && typeof publish.parent === "string" && publish.parent.trim() !== "";
    if (!none && !tool) throw invalid(shape);
  }
  return { ...(store !== undefined && { store }), ...(publish !== undefined && { publish: publish as Publish }) };
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
