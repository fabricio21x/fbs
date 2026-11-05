import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { hasGitSegment, projectConfig } from "./config";
import { isValidDate } from "./date";
import { gitCommonDir, isIgnored, rootFor } from "./git";
import { isRepoName } from "./github";
import { type GateResult, gatePasses, readGate } from "./spec-gate";
import { parseWorkUnits, type WorkUnit, workUnitProblems } from "./work-units";

export type Size = "tiny" | "bug" | "mid" | "big";
export type DocKind = "spec" | "design";

/** The user approves in their own words; the agent approves only a simple design, with its reason. */
export type Approval = { at: string; by: "user"; quote: string; sha256: string } | { at: string; by: "agent"; reason: string; sha256: string };

/** A passing verify verdict, bound to the tree it verified. */
export interface Stamp {
  tree: string;
  at: string;
  verdict: "pass";
  criteria: number;
  evidence: string;
  /** The sha256 of a local verdict, read from disk since no commit holds it; unset for a committed verdict. */
  verdictSha256?: string;
  /** The tree verify ran on, once `fbs stamp carry` moved the stamp over a documents-only change; kept across carries. */
  verifiedTree?: string;
}

export interface FeatureRecord {
  slug: string;
  dir: string;
  size: Size;
  approvals: Partial<Record<DocKind, Approval>>;
  pr: number | null;
  /** `owner/name` of the PR's repo; set with `pr`. */
  repo?: string;
  stamp?: Stamp;
  /** The merge `fbs land` made, or one sync found made outside it; kept as history even when the PR link is cleared. */
  landed?: Landed;
  branch?: FeatureBranch;
  /** The tracker issue the feature works on. */
  ticket?: Ticket;
  /** The feature this record is a work unit of; its documents and approvals are that feature's. */
  unitOf?: string;
  /** The unit's place in its feature's stack, from 1; set with `unitOf`. */
  unit?: number;
}

/** A work unit: one PR of a Big feature's stack. */
export type UnitRecord = FeatureRecord & { unitOf: string; unit: number };

export function isUnit(rec: FeatureRecord): rec is UnitRecord {
  return rec.unitOf !== undefined;
}

export interface Ticket {
  id: string;
  url?: string;
}

/** Where the feature's work lives: a branch fbs cut from `parent` at `base` (`<type>/<slug>`, or `fbs/<slug>` before types), or one adopted with `--use` (no parent). */
export interface FeatureBranch {
  name: string;
  parent: string | null;
  base: string;
  /** The commit `fbs push` last pushed to origin's branch of the same name. */
  pushed?: string;
  /** The name `pushed` went to before a rename; the next `fbs push` deletes it on origin. */
  previous?: string;
}

export interface Landed {
  pr: number;
  repo: string;
  commit: string;
  at: string;
  /** The PR head the merge took, which the unit above restacks onto; missing on records from before it was kept. */
  head?: string;
  /** Set when sync found the PR merged without fbs land. */
  by?: "outside";
  /** The failing checks the user confirmed landing over. */
  over?: OverCheck[];
}

/** A check the user confirmed landing over: it failed, was cancelled, or is required by the base branch and didn't run. */
export interface OverCheck {
  name: string;
  /** A GitHub Actions check's workflow, so a same-named check from another workflow isn't covered. */
  workflow?: string;
  state: "failed" | "cancelled" | "missing";
}

/** `value` as a non-empty list of OverChecks, or null when it is anything else. */
export function readOverChecks(value: unknown): OverCheck[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const checks: OverCheck[] = [];
  for (const entry of value) {
    if (!isObject(entry) || Object.keys(entry).some((key) => !["name", "workflow", "state"].includes(key))) return null;
    if (typeof entry.name !== "string" || entry.name === "" || !["failed", "cancelled", "missing"].includes(entry.state as string)) return null;
    if (entry.workflow !== undefined && (typeof entry.workflow !== "string" || entry.workflow === "")) return null;
    checks.push({ name: entry.name, ...(entry.workflow !== undefined && { workflow: entry.workflow as string }), state: entry.state as OverCheck["state"] });
  }
  return checks;
}

export type StatusErrorCode =
  | "exists"
  | "missing"
  | "bad-slug"
  | "bad-size"
  | "bad-date"
  | "bad-quote"
  | "bad-reason"
  | "wrong-kind-for-size"
  | "spec-not-approved"
  | "spec-changed"
  | "doc-missing"
  | "locked"
  | "bad-pr"
  | "no-pr"
  | "bad-body"
  | "bad-branch"
  | "bad-ticket"
  | "is-unit"
  | "not-big"
  | "design-not-approved"
  | "unit-taken"
  | "bad-unit";

export class StatusError extends Error {
  readonly code: StatusErrorCode;

  constructor(code: StatusErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export class GateRefusedError extends Error {
  readonly result: GateResult;

  constructor(result: GateResult) {
    super("gate refused");
    this.result = result;
  }
}

/** An approval the agent may not make itself. */
export class ApprovalRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`refused: ${reason}`);
    this.reason = reason;
  }
}

/** A record file that exists but is not a valid feature record. */
export class RecordError extends Error {}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SIZES: readonly string[] = ["tiny", "bug", "mid", "big"] satisfies Size[];
const DOC_KINDS: readonly string[] = ["spec", "design"] satisfies DocKind[];
const SHA256 = /^[0-9a-f]{64}$/;
// Tree and commit hashes alike: SHA-1 or SHA-256.
const TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function assertSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new StatusError("bad-slug", `${JSON.stringify(slug)} must be lowercase words joined by single hyphens`);
}

export function assertToday(today: string): void {
  if (!isValidDate(today)) throw new StatusError("bad-date", `${JSON.stringify(today)} must be a valid YYYY-MM-DD date`);
}

function recordsDir(cwd: string): string {
  return join(gitCommonDir(cwd), "fbs", "features");
}

export function recordPath(cwd: string, slug: string): string {
  return join(recordsDir(cwd), `${slug}.json`);
}

function writeRecord(cwd: string, slug: string, rec: FeatureRecord): void {
  const path = recordPath(cwd, slug);
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(rec, null, 2)}\n`, { flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function initFeature(cwd: string, slug: string, size: string, today: string): FeatureRecord {
  assertSlug(slug);
  if (!SIZES.includes(size)) throw new StatusError("bad-size", `${JSON.stringify(size)} must be one of ${SIZES.join(", ")}`);
  assertToday(today);

  const dir = posix.join(projectConfig(cwd).featuresDir, `${today}-${slug}`);
  return createRecord(cwd, { slug, dir, size: size as Size, approvals: {}, pr: null });
}

/**
 * Record work unit `slug` of a Big feature with a current design approval, numbered next in its stack unless `unit`
 * names a free number; the number must be one the design's Work units list.
 */
export function initUnit(cwd: string, slug: string, featureSlug: string, unit?: number): UnitRecord {
  assertSlug(slug);
  assertSlug(featureSlug);
  if (unit !== undefined && !(Number.isInteger(unit) && unit >= 1)) throw new StatusError("bad-unit", `${unit} must be a positive integer`);
  if (!existsSync(recordPath(cwd, featureSlug))) throw new StatusError("missing", `no feature ${featureSlug}`);
  // Under the feature's lock, so two units never take the same number and the design approval holds while it's checked.
  return withLock(cwd, featureSlug, () => {
    const feature = readFeature(cwd, featureSlug);
    if (isUnit(feature)) throw new StatusError("is-unit", `${featureSlug} is unit ${feature.unit} of ${feature.unitOf}; units belong to a feature`);
    if (feature.size !== "big") throw new StatusError("not-big", `${featureSlug} is ${feature.size}; only a big feature splits into units`);
    if (!feature.approvals.design) throw new StatusError("design-not-approved", `approve the design of ${featureSlug} before recording its units`);
    if (!isApprovalCurrent(cwd, feature, "design")) throw new StatusError("design-not-approved", `${docPath(cwd, feature, "design")} changed since its approval; approve it again`);
    const units = featureUnits(cwd, featureSlug);
    const number = unit ?? Math.max(0, ...units.map((u) => u.unit)) + 1;
    const planned = parseWorkUnits(readFileSync(docFile(cwd, feature, "design"), "utf8")).units ?? [];
    if (!planned.some((u) => u.number === number)) throw new StatusError("bad-unit", `${docPath(cwd, feature, "design")} lists no U${number} under Work units; amend the design to add it first`);
    const taken = units.find((u) => u.unit === number);
    if (taken !== undefined) throw new StatusError("unit-taken", `unit ${number} of ${featureSlug} is ${taken.slug}`);
    const rec: UnitRecord = { slug, dir: posix.join(feature.dir, "units", slug), size: "big", approvals: {}, pr: null, unitOf: featureSlug, unit: number };
    createRecord(cwd, rec);
    return rec;
  });
}

/** Reserve the record's slug, write it and make its dir; a failure leaves neither behind. */
function createRecord<T extends FeatureRecord>(cwd: string, rec: T): T {
  const root = rootFor(cwd, `${rec.dir}/`);
  if (existsSync(join(root, rec.dir))) throw new StatusError("exists", `${rec.dir} already exists`);
  const path = recordPath(cwd, rec.slug);
  mkdirSync(recordsDir(cwd), { recursive: true });
  try {
    closeSync(openSync(path, "wx"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new StatusError("exists", `feature ${rec.slug} already has a record`);
    throw e;
  }
  try {
    writeRecord(cwd, rec.slug, rec);
    mkdirSync(join(root, rec.dir), { recursive: true });
  } catch (e) {
    rmSync(path, { force: true });
    throw e;
  }
  return rec;
}

export function readFeature(cwd: string, slug: string): FeatureRecord {
  assertSlug(slug);
  const path = recordPath(cwd, slug);
  if (!existsSync(path)) throw new StatusError("missing", `no feature ${slug}`);
  const invalid = (reason: string) => new RecordError(`invalid record ${path}: ${reason}`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw invalid((e as Error).message.split("\n")[0]);
  }
  if (!isObject(raw)) throw invalid("expected a JSON object");
  const unknownKey = Object.keys(raw).find((key) => !["slug", "dir", "size", "approvals", "pr", "unitOf", "unit", "repo", "stamp", "landed", "branch", "ticket"].includes(key));
  if (unknownKey !== undefined) throw invalid(`unknown field ${unknownKey}`);
  if (raw.slug !== slug) throw invalid(`slug ${JSON.stringify(raw.slug)} does not match the file name`);
  if (typeof raw.size !== "string" || !SIZES.includes(raw.size)) throw invalid(`unknown size ${JSON.stringify(raw.size)}`);
  if (typeof raw.dir !== "string" || !isRepoPath(raw.dir)) throw invalid(`dir ${JSON.stringify(raw.dir)} must be a normalised relative path inside the repo, outside .git`);
  if (!(raw.pr === null || Number.isInteger(raw.pr))) throw invalid("pr must be null or an integer");
  if (raw.pr === null ? raw.repo !== undefined : typeof raw.repo !== "string" || !isRepoName(raw.repo)) throw invalid("repo must be owner/name exactly when pr is set");
  if (!isObject(raw.approvals)) throw invalid("approvals must be an object");
  if ((raw.unitOf === undefined) !== (raw.unit === undefined)) throw invalid("unitOf and unit go together");
  if (raw.unitOf !== undefined && (typeof raw.unitOf !== "string" || !SLUG.test(raw.unitOf) || raw.unitOf === slug)) throw invalid("unitOf must be another feature's slug");
  if (raw.unit !== undefined && (!Number.isInteger(raw.unit) || (raw.unit as number) < 1)) throw invalid("unit must be a positive integer");

  const approvals: Partial<Record<DocKind, Approval>> = {};
  for (const [kind, approval] of Object.entries(raw.approvals)) {
    if (!DOC_KINDS.includes(kind)) throw invalid(`unknown approval ${kind}`);
    approvals[kind as DocKind] = readApproval(kind, approval, invalid);
  }
  const rec: FeatureRecord = {
    slug,
    dir: raw.dir,
    size: raw.size as Size,
    approvals,
    pr: raw.pr as number | null,
    ...(typeof raw.unitOf === "string" && { unitOf: raw.unitOf, unit: raw.unit as number }),
    ...(typeof raw.repo === "string" && { repo: raw.repo }),
    ...(raw.landed !== undefined && { landed: readLanded(raw.landed, invalid) }),
    ...(raw.branch !== undefined && { branch: readBranch(raw.branch, invalid) }),
    ...(raw.ticket !== undefined && { ticket: readTicket(raw.ticket, invalid) }),
  };
  if (raw.stamp === undefined) return rec;

  const stamp = raw.stamp;
  const optional = ["verdictSha256", "verifiedTree"];
  if (!isObject(stamp) || Object.keys(stamp).filter((key) => !optional.includes(key)).sort().join() !== "at,criteria,evidence,tree,verdict") {
    throw invalid("stamp must be { tree, at, verdict, criteria, evidence, verdictSha256?, verifiedTree? }");
  }
  if (typeof stamp.tree !== "string" || !TREE.test(stamp.tree)) throw invalid("stamp.tree must be a lowercase hex tree hash");
  if (stamp.verifiedTree !== undefined && (typeof stamp.verifiedTree !== "string" || !TREE.test(stamp.verifiedTree))) throw invalid("stamp.verifiedTree must be a lowercase hex tree hash");
  if (typeof stamp.at !== "string" || !isValidDate(stamp.at)) throw invalid("stamp.at must be a valid date");
  if (stamp.verdict !== "pass") throw invalid('stamp.verdict must be "pass"');
  if (!Number.isInteger(stamp.criteria) || (stamp.criteria as number) < 0) throw invalid("stamp.criteria must be a non-negative integer");
  if (typeof stamp.evidence !== "string" || !isRepoPath(stamp.evidence)) throw invalid("stamp.evidence must be a normalised relative path inside the repo, outside .git");
  if (stamp.verdictSha256 !== undefined && (typeof stamp.verdictSha256 !== "string" || !SHA256.test(stamp.verdictSha256))) throw invalid("stamp.verdictSha256 must be 64 lowercase hex characters");
  const verdictSha256 = typeof stamp.verdictSha256 === "string" && { verdictSha256: stamp.verdictSha256 };
  const verifiedTree = typeof stamp.verifiedTree === "string" && { verifiedTree: stamp.verifiedTree };
  return { ...rec, stamp: { tree: stamp.tree, at: stamp.at, verdict: "pass", criteria: stamp.criteria as number, evidence: stamp.evidence, ...verdictSha256, ...verifiedTree } };
}

function readLanded(landed: unknown, invalid: (reason: string) => RecordError): Landed {
  if (!isObject(landed) || !["at,commit,pr,repo", "at,commit,head,pr,repo", "at,by,commit,head,pr,repo"].includes(Object.keys(landed).filter((key) => key !== "over").sort().join())) throw invalid("landed must be { pr, repo, commit, at, head?, by?, over? }");
  if (!Number.isInteger(landed.pr) || (landed.pr as number) < 1) throw invalid("landed.pr must be a positive integer");
  if (typeof landed.repo !== "string" || !isRepoName(landed.repo)) throw invalid("landed.repo must be owner/name");
  if (typeof landed.commit !== "string" || !TREE.test(landed.commit)) throw invalid("landed.commit must be a lowercase hex commit hash");
  if (typeof landed.at !== "string" || !isValidDate(landed.at)) throw invalid("landed.at must be a valid date");
  if (landed.head !== undefined && (typeof landed.head !== "string" || !TREE.test(landed.head))) throw invalid("landed.head must be a lowercase hex commit hash");
  if (landed.by !== undefined && landed.by !== "outside") throw invalid('landed.by must be "outside"');
  const over = landed.over === undefined ? undefined : readOverChecks(landed.over);
  if (over === null) throw invalid("landed.over must be a non-empty list of { name, workflow?, state }");
  return { pr: landed.pr as number, repo: landed.repo, commit: landed.commit, at: landed.at, ...(typeof landed.head === "string" && { head: landed.head }), ...(landed.by === "outside" && { by: "outside" as const }), ...(over !== undefined && { over }) };
}

function readBranch(branch: unknown, invalid: (reason: string) => RecordError): FeatureBranch {
  const shapes = ["base,name,parent", "base,name,parent,pushed", "base,name,parent,previous,pushed"];
  if (!isObject(branch) || !shapes.includes(Object.keys(branch).sort().join())) throw invalid("branch must be { name, parent, base, pushed?, previous? }");
  if (typeof branch.name !== "string" || !isBranchName(branch.name)) throw invalid("branch.name must be a valid branch name");
  if (!(branch.parent === null || (typeof branch.parent === "string" && isBranchName(branch.parent)))) throw invalid("branch.parent must be null or a valid branch name");
  if (typeof branch.base !== "string" || !TREE.test(branch.base)) throw invalid("branch.base must be a lowercase hex commit hash");
  if (branch.pushed !== undefined && (typeof branch.pushed !== "string" || !TREE.test(branch.pushed))) throw invalid("branch.pushed must be a lowercase hex commit hash");
  if (branch.previous !== undefined && (typeof branch.previous !== "string" || !isBranchName(branch.previous))) throw invalid("branch.previous must be a valid branch name");
  return {
    name: branch.name,
    parent: branch.parent,
    base: branch.base,
    ...(typeof branch.pushed === "string" && { pushed: branch.pushed }),
    ...(typeof branch.previous === "string" && { previous: branch.previous }),
  };
}

function readTicket(ticket: unknown, invalid: (reason: string) => RecordError): Ticket {
  if (!isObject(ticket) || !["id", "id,url"].includes(Object.keys(ticket).sort().join())) throw invalid("ticket must be { id, url? }");
  if (typeof ticket.id !== "string" || !isTicketId(ticket.id)) throw invalid("ticket.id must be a tracker id like ACM-123 or an issue number");
  if (ticket.url !== undefined && (typeof ticket.url !== "string" || !isHttpsUrl(ticket.url))) throw invalid("ticket.url must be an https URL");
  return { id: ticket.id, ...(typeof ticket.url === "string" && { url: ticket.url }) };
}

/** A tracker id such as `ACM-123`, or an issue number with or without `#`. */
export function isTicketId(id: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/.test(id) || /^#?[0-9]+$/.test(id);
}

function isHttpsUrl(url: string): boolean {
  if (/\s/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname !== "";
  } catch {
    return false;
  }
}

/** True for a name `git check-ref-format --branch` accepts as is, without `@{-n}` shorthands, and not `HEAD`. */
export function isBranchName(name: string): boolean {
  return (
    name !== "" &&
    name !== "@" &&
    name !== "HEAD" &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !/[\x00-\x20\x7f~^:?*[\\]|\.\.|\/\/|@\{/.test(name) &&
    name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

/** Validate one approval; a record from before `by` existed reads as the user's. */
function readApproval(kind: string, approval: unknown, invalid: (reason: string) => RecordError): Approval {
  if (!isObject(approval)) throw invalid(`approvals.${kind} must be an object`);
  const by = approval.by ?? "user";
  if (by !== "user" && by !== "agent") throw invalid(`approvals.${kind}.by must be "user" or "agent"`);
  const keys = Object.keys(approval).filter((key) => key !== "by").sort().join();
  if (by === "user" && keys !== "at,quote,sha256") throw invalid(`approvals.${kind} must be { at, by?, quote, sha256 }`);
  if (by === "agent" && keys !== "at,reason,sha256") throw invalid(`approvals.${kind} must be { at, by, reason, sha256 }`);
  if (typeof approval.at !== "string" || !isValidDate(approval.at)) throw invalid(`approvals.${kind}.at must be a valid date`);
  if (typeof approval.sha256 !== "string" || !SHA256.test(approval.sha256)) throw invalid(`approvals.${kind}.sha256 must be 64 lowercase hex characters`);
  const words = by === "user" ? approval.quote : approval.reason;
  const field = by === "user" ? "quote" : "reason";
  if (typeof words !== "string" || words.trim() === "") throw invalid(`approvals.${kind}.${field} must be a non-empty string`);
  if (by === "user") return { at: approval.at, by, quote: words, sha256: approval.sha256 };
  return { at: approval.at, by, reason: words, sha256: approval.sha256 };
}

/** True for a normalised relative path inside the repo and outside `.git`. */
export function isRepoPath(dir: string): boolean {
  return (
    dir !== "" &&
    dir !== "." &&
    !posix.isAbsolute(dir) &&
    posix.normalize(dir) === dir &&
    !dir.split("/").includes("..") &&
    !hasGitSegment(dir)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** List every feature record; a `.json` file whose name is not a valid slug is skipped with a warning. */
export function listFeatures(cwd: string, warn: (message: string) => void = (m) => console.error(m)): FeatureRecord[] {
  const dir = recordsDir(cwd);
  if (!existsSync(dir)) return [];
  const slugs: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const slug = name.slice(0, -".json".length);
    if (SLUG.test(slug)) slugs.push(slug);
    else warn(`warning: skipping ${join(dir, name)}: not a valid feature slug`);
  }
  return slugs.map((slug) => readFeature(cwd, slug));
}

/** The units of a feature, lowest first. */
export function featureUnits(cwd: string, feature: string): UnitRecord[] {
  return listFeatures(cwd, () => {})
    .filter((rec): rec is UnitRecord => rec.unitOf === feature)
    .sort((a, b) => a.unit - b.unit);
}

/** The unit a unit is stacked on, unit k-1; null for unit 1 or when k-1 has no record. */
export function unitBelow(cwd: string, unit: UnitRecord): UnitRecord | null {
  return featureUnits(cwd, unit.unitOf).find((rec) => rec.unit === unit.unit - 1) ?? null;
}

/** The unit stacked on a unit, unit k+1; null when there is none. */
export function unitAbove(cwd: string, unit: UnitRecord): UnitRecord | null {
  return featureUnits(cwd, unit.unitOf).find((rec) => rec.unit === unit.unit + 1) ?? null;
}

/** The unit of a feature's stack that lands next: its lowest unit with a PR that hasn't landed; null when there is none. */
export function nextToLand(cwd: string, feature: string): UnitRecord | null {
  return featureUnits(cwd, feature).find((unit) => unit.pr !== null && unit.landed === undefined) ?? null;
}

/** The record whose documents and approvals `rec` goes by: a unit's feature, else the record itself. */
export function documentsRecord(cwd: string, rec: FeatureRecord): FeatureRecord {
  return isUnit(rec) ? readFeature(cwd, rec.unitOf) : rec;
}

/** The unit's entry in its feature's design `## Work units`; null when the design or the entry is missing. */
export function plannedUnit(cwd: string, unit: UnitRecord): WorkUnit | null {
  const path = docFile(cwd, unit, "design");
  if (!existsSync(path)) return null;
  return parseWorkUnits(readFileSync(path, "utf8")).units?.find((planned) => planned.number === unit.unit) ?? null;
}

function refuseUnit(rec: FeatureRecord): void {
  if (isUnit(rec)) throw new StatusError("is-unit", `${rec.slug} is unit ${rec.unit} of ${rec.unitOf} and goes by its documents and approvals; run this on ${rec.unitOf}`);
}

export function docPath(cwd: string, rec: FeatureRecord, kind: DocKind): string {
  return posix.join(documentsRecord(cwd, rec).dir, `${kind}.md`);
}

/** `local` when git ignores the feature's dir, whose documents then live only in the main worktree; else `tracked`. */
export function docsMode(cwd: string, rec: FeatureRecord): "local" | "tracked" {
  return isIgnored(cwd, `${documentsRecord(cwd, rec).dir}/`) ? "local" : "tracked";
}

/** The absolute dir the feature's documents are read from: the main worktree's when local, else this worktree's. */
export function docsDir(cwd: string, rec: FeatureRecord): string {
  const { dir } = documentsRecord(cwd, rec);
  return join(rootFor(cwd, `${dir}/`), dir);
}

interface Doc {
  gate: GateResult;
  sha256: string;
}

function docFile(cwd: string, rec: FeatureRecord, kind: DocKind): string {
  return join(docsDir(cwd, rec), `${kind}.md`);
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readDoc(cwd: string, rec: FeatureRecord, kind: DocKind): Doc {
  const path = docFile(cwd, rec, kind);
  if (!existsSync(path)) throw new StatusError("doc-missing", `${docPath(cwd, rec, kind)} does not exist`);
  const bytes = readFileSync(path);
  const gate = readGate(bytes.toString("utf8"));
  if (kind === "design") {
    const design = bytes.toString("utf8");
    if (rec.size === "big" && parseWorkUnits(design).units === null) gate.missingSections.push("Work units");
    const spec = docFile(cwd, rec, "spec");
    gate.workUnits = workUnitProblems(design, existsSync(spec) ? readFileSync(spec, "utf8") : "");
  }
  return { gate, sha256: sha256(bytes) };
}

export function checkGate(cwd: string, slug: string, kind: DocKind): GateResult {
  const rec = readFeature(cwd, slug);
  refuseUnit(rec);
  return readDoc(cwd, rec, kind).gate;
}

/** True when the document on disk still has the bytes its approval recorded; a unit answers for its feature's. */
export function isApprovalCurrent(cwd: string, rec: FeatureRecord, kind: DocKind): boolean {
  const owner = documentsRecord(cwd, rec);
  const approval = owner.approvals[kind];
  const path = docFile(cwd, owner, kind);
  return approval !== undefined && existsSync(path) && sha256(readFileSync(path)) === approval.sha256;
}

function withLock<T>(cwd: string, slug: string, body: () => T): T {
  const lock = join(recordsDir(cwd), `${slug}.lock`);
  try {
    closeSync(openSync(lock, "wx"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new StatusError("locked", `${lock} exists; another fbs is updating ${slug}, or delete it if none is`);
    throw e;
  }
  try {
    return body();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Read a feature record, change it and write it back, all under the feature's lock. */
export function updateFeature(cwd: string, slug: string, change: (rec: FeatureRecord) => FeatureRecord): FeatureRecord {
  assertSlug(slug);
  if (!existsSync(recordPath(cwd, slug))) throw new StatusError("missing", `no feature ${slug}`);
  return withLock(cwd, slug, () => {
    const updated = change(readFeature(cwd, slug));
    writeRecord(cwd, slug, updated);
    return updated;
  });
}

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]{0,9})(?:[/?#].*)?$/;

/** A PR number, or a PR URL with its repo. */
export function parsePrRef(ref: string): { pr: number; repo: string | null } {
  if (/^[1-9][0-9]{0,9}$/.test(ref)) return { pr: Number(ref), repo: null };
  const url = PR_URL.exec(ref);
  if (url) return { pr: Number(url[2]), repo: url[1] };
  throw new StatusError("bad-pr", `${JSON.stringify(ref)} must be a positive PR number or a https://github.com/<owner>/<repo>/pull/<number> URL`);
}

/** Record the feature's PR and its repo. */
export function setPr(cwd: string, slug: string, pr: number, repo: string): FeatureRecord {
  return updateFeature(cwd, slug, (rec) => ({ ...rec, pr, repo }));
}

/** Forget the feature's PR, such as one closed without landing. */
export function clearPr(cwd: string, slug: string): FeatureRecord {
  return updateFeature(cwd, slug, ({ repo: _, ...rec }) => ({ ...rec, pr: null }));
}

/** Record the tracker issue the feature works on. */
export function setTicket(cwd: string, slug: string, id: string, url?: string): FeatureRecord {
  if (!isTicketId(id)) throw new StatusError("bad-ticket", `${JSON.stringify(id)} must be a tracker id like ACM-123 or an issue number`);
  if (url !== undefined && !isHttpsUrl(url)) throw new StatusError("bad-ticket", `${JSON.stringify(url)} must be an https URL`);
  return updateFeature(cwd, slug, (rec) => ({ ...rec, ticket: { id, ...(url !== undefined && { url }) } }));
}

export function clearTicket(cwd: string, slug: string): FeatureRecord {
  return updateFeature(cwd, slug, ({ ticket: _, ...rec }) => rec);
}

/** The feature's PR and repo; a feature without a PR is refused. */
export function featurePr(cwd: string, slug: string): { pr: number; repo: string } {
  const { pr, repo } = readFeature(cwd, slug);
  if (pr === null || repo === undefined) throw new StatusError("no-pr", `feature ${slug} has no PR; record it with fbs status pr ${slug} <number|url>`);
  return { pr, repo };
}

export function approve(cwd: string, slug: string, kind: DocKind, quote: string, today: string): FeatureRecord {
  if (quote.trim() === "") throw new StatusError("bad-quote", "the approval quote must not be blank");
  return record(cwd, slug, kind, today, (sha256) => ({ at: today, by: "user", quote, sha256 }));
}

/** The agent approves a simple design amendment itself; the spec always needs the user. */
export function approveAsAgent(cwd: string, slug: string, kind: DocKind, reason: string, today: string): FeatureRecord {
  if (kind === "spec") throw new ApprovalRefusedError("the spec needs the user's approval");
  if (reason.trim() === "") throw new StatusError("bad-reason", "the approval reason must not be blank");
  return record(cwd, slug, kind, today, (sha256) => ({ at: today, by: "agent", reason, sha256 }));
}

function record(cwd: string, slug: string, kind: DocKind, today: string, approvalOf: (sha256: string) => Approval): FeatureRecord {
  assertSlug(slug);
  assertToday(today);

  return updateFeature(cwd, slug, (rec) => {
    refuseUnit(rec);
    if (kind === "design" && rec.size !== "big") throw new StatusError("wrong-kind-for-size", `a ${rec.size} feature is approved on its spec only`);
    if (kind === "design") {
      if (!rec.approvals.spec) throw new StatusError("spec-not-approved", `approve the spec of ${slug} before its design`);
      if (!isApprovalCurrent(cwd, rec, "spec")) {
        throw new StatusError("spec-changed", `${docPath(cwd, rec, "spec")} changed or was removed since its approval; approve the spec again`);
      }
    }
    const doc = readDoc(cwd, rec, kind);
    if (!gatePasses(doc.gate)) throw new GateRefusedError(doc.gate);

    const approval = approvalOf(doc.sha256);
    // The design was approved against the old spec, so a new spec approval clears it.
    const approvals = kind === "spec" ? { spec: approval } : { ...rec.approvals, design: approval };
    // The stamp verified the work against the old documents, so any new approval clears it.
    const { stamp: _, ...rest } = rec;
    return { ...rest, approvals };
  });
}
