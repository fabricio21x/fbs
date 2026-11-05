import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type Run, runConfig } from "./afk";
import { commitOf, currentBranch, gitCommonDir, mergeBase, originDefaultBranch } from "./git";
import { featureUnits, isUnit, nextToLand, type OverCheck, readFeature, readOverChecks, recordPath } from "./status";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const TOKEN_TTL_MS = 15 * 60 * 1000;
export const REQUEST_TTL_MS = 10 * 60 * 1000;

export function isSlug(slug: string): boolean {
  return SLUG.test(slug);
}

function prDir(commonDir: string): string {
  return join(commonDir, "fbs", "pr");
}

export function campMarkerPath(commonDir: string, slug: string): string {
  return join(prDir(commonDir), `${slug}.camp`);
}

export function landTokenPath(commonDir: string, slug: string): string {
  return join(commonDir, "fbs", "land", `${slug}.token`);
}

export function landRequestPath(commonDir: string): string {
  return join(commonDir, "fbs", "land", "request.json");
}

/** Slugs with a running PR flow: each `<slug>.camp` marker camp leaves in the PR dir. */
export function campMarkers(commonDir: string): string[] {
  const dir = prDir(commonDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".camp"))
    .map((name) => name.slice(0, -".camp".length))
    .sort();
}

/** An fbs PR the guard protects: a record whose PR is set and not landed. */
export interface OpenPr {
  slug: string;
  branch: string | null;
}

/** The records with an open PR, read leniently: a broken record is skipped, never fatal to the guard. */
export function openPrRecords(commonDir: string): OpenPr[] {
  const dir = join(commonDir, "fbs", "features");
  if (!existsSync(dir)) return [];
  const open: OpenPr[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (typeof rec?.slug === "string" && typeof rec.pr === "number" && rec.landed === undefined) open.push({ slug: rec.slug, branch: typeof rec.branch?.name === "string" ? rec.branch.name : null });
    } catch {}
  }
  return open;
}

/** The afk runs whose run.json has one of `statuses`; archived `<slug>.<time>` dirs and unreadable records don't count. */
export function afkRunsIn(commonDir: string, statuses: Run["status"][]): Run[] {
  const root = join(commonDir, "fbs", "afk");
  if (!existsSync(root)) return [];
  const runs: Run[] = [];
  for (const name of readdirSync(root).sort()) {
    if (!SLUG.test(name)) continue;
    try {
      const run = JSON.parse(readFileSync(join(root, name, "run.json"), "utf8"));
      if (statuses.includes(run?.status) && run.slug === name) runs.push(run);
    } catch {}
  }
  return runs;
}

/** Written when the user types /fbs:land or answers a land request, bound to the stamp the feature had then. */
export interface LandToken {
  slug: string;
  at: number;
  tree: string;
  /** The failing checks the user confirmed landing over, copied from the request they answered; never from /fbs:land. */
  over?: OverCheck[];
}

export function writeLandToken(commonDir: string, token: LandToken): void {
  const path = landTokenPath(commonDir, token.slug);
  mkdirSync(join(commonDir, "fbs", "land"), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(token)}\n`);
  renameSync(temp, path);
}

/** The token for `slug` if it is well formed and was written in the last 15 minutes. */
export function freshToken(commonDir: string, slug: string, now: number): LandToken | null {
  try {
    const token = JSON.parse(readFileSync(landTokenPath(commonDir, slug), "utf8"));
    const fresh = token.slug === slug && Number.isInteger(token.at) && token.at <= now && now - token.at < TOKEN_TTL_MS && typeof token.tree === "string";
    const over = token.over === undefined ? undefined : readOverChecks(token.over);
    return fresh && over !== null ? { slug, at: token.at, tree: token.tree, ...(over !== undefined && { over }) } : null;
  } catch {
    return null;
  }
}

/** The slug whose land token `/fbs:land <slug>` writes and `fbs land <slug>` takes: a feature with units lands its next unit. */
export function landTokenSlug(cwd: string, slug: string): string {
  try {
    const rec = readFeature(cwd, slug);
    return isUnit(rec) ? slug : (nextToLand(cwd, slug)?.slug ?? slug);
  } catch {
    return slug;
  }
}

/** Read and delete the token: one land attempt per /fbs:land. */
export function takeLandToken(commonDir: string, slug: string, now: number): LandToken | null {
  const token = freshToken(commonDir, slug, now);
  rmSync(landTokenPath(commonDir, slug), { force: true });
  return token;
}

/** Written by `fbs land request`; the user's bare land answer turns it into the land token. */
export interface LandRequest {
  slug: string;
  pr: number;
  tree: string;
  at: number;
  /** The Claude Code session that asked; only an answer in that session counts. */
  session: string;
  /** With --over-failing: the checks that completed without passing or didn't run, which the user's answer confirms landing over. */
  over?: OverCheck[];
}

/** One pending request per repo; requestLand refuses a second feature while one is live, and the same feature refreshes it. */
export function writeLandRequest(commonDir: string, request: LandRequest): void {
  const path = landRequestPath(commonDir);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(request)}\n`);
  renameSync(temp, path);
}

/** What the push and land rules need to know about the repo. */
export interface GuardContext {
  protectedBranches: () => string[];
  currentBranch: () => string | null;
  openPrs: () => OpenPr[];
  hasFreshToken: (slug: string) => boolean;
  /** True when `ref` names a commit, such as a branch. */
  isCommit: (ref: string) => boolean;
  /** True when `ref`, read in `dir`, is a commit above `kept`: an unchecked step. */
  isStepAbove: (dir: string, ref: string, kept: string) => boolean;
}

const DEFAULT_BRANCHES = ["main", "master"];
const MCP_TOOL = /^mcp__.*__([A-Za-z0-9_]+)$/;
const MCP_BRANCH_WRITES = ["push_files", "create_or_update_file", "delete_file"];
const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const COMMAND_TOOLS = ["Bash", "Monitor"];
// Tools the model could use to make /fbs:land run, or a land answer arrive, as if the user typed it.
const SCHEDULING_TOOLS = ["Skill", "CronCreate", "ScheduleWakeup", "RemoteTrigger", "Agent", "Monitor", "SendMessage"];
const ONLY_USER = "only the user lands, with /fbs:land";
const ASK_TO_LAND = "only the user lands: run fbs land request <slug> and ask them, or have them type /fbs:land <slug>";
const TYPED_ONLY = "/fbs:land runs only when the user types it: their message must start with /fbs:land (anything after the command is fine), or it arrives as plain text";

/** Why the guard denies this tool call while a PR flow runs; empty to allow. */
export function denials(toolName: string, toolInput: Record<string, unknown>, cwd: string, ctx: GuardContext): string[] {
  const reasons: string[] = [];
  const mcp = MCP_TOOL.exec(toolName)?.[1];
  if (mcp === "merge_pull_request") reasons.push(`${toolName} merges a PR; ${ASK_TO_LAND}`);
  if (mcp !== undefined && MCP_BRANCH_WRITES.includes(mcp)) {
    const branch = typeof toolInput.branch === "string" ? toolInput.branch : null;
    if (branch === null || protectedOf(ctx).includes(branch)) reasons.push(`${toolName} writes to the default branch (${branch ?? "no branch given"}); ${ONLY_USER}`);
  }
  if (WRITE_TOOLS.includes(toolName) || MCP_FILE_WRITE.test(toolName)) {
    const paths = [toolInput.file_path, toolInput.notebook_path, toolInput.path, toolInput.source, toolInput.destination].filter((p): p is string => typeof p === "string");
    if (paths.some((p) => resolve(cwd, p).toLowerCase().includes("/fbs/land/"))) reasons.push("the land token is written only when the user types /fbs:land");
  }
  if (SCHEDULING_TOOLS.includes(toolName) && JSON.stringify(toolInput).toLowerCase().includes("fbs:land")) reasons.push(TYPED_ONLY);
  if (SCHEDULING_TOOLS.includes(toolName) && stringsIn(toolInput).some(isScheduledReply)) reasons.push(`${toolName} would send a land answer as if the user typed it; only the user answers a land request`);
  if (COMMAND_TOOLS.includes(toolName) && typeof toolInput.command === "string") reasons.push(...commandDenials(toolInput.command, ctx));
  return [...new Set(reasons)];
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(stringsIn);
}

/** A land answer, alone or after a /loop and an interval such as `5m`. */
function isScheduledReply(text: string): boolean {
  const body = text.trim().replace(/^\/?loop\s+/i, "").replace(/^\d+\s*[a-z]*\s+/i, "").trim();
  return LAND_REPLY.test(text.trim()) || LAND_REPLY.test(body);
}

function protectedOf(ctx: GuardContext): string[] {
  try {
    return ctx.protectedBranches();
  } catch {
    return DEFAULT_BRANCHES;
  }
}

const SEGMENT_BREAK = /[;&|(){}`\n]/;
const WRITE_METHOD = /(-X\s*|--method[\s=]+|--request[\s=]+)(PATCH|DELETE|POST|PUT)\b|(^|\s)(-f|-F|--field|--raw-field|--input|-d|--data)(\s|=)/i;

/** Lowercase and collapse `/./` and `//`, since APFS paths are case-insensitive and both spell the same path. */
function collapsePath(text: string): string {
  let out = text.toLowerCase();
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/\/\.\//g, "/").replace(/\/{2,}/g, "/");
  }
  return out;
}

/** Scan the whole command, quotes stripped, so chaining, subshells and quoting don't hide a merge or push. */
export function commandDenials(command: string, ctx: GuardContext): string[] {
  const text = command.replace(/\\\r?\n/g, " ").replace(/["'\\]/g, "");
  const folded = collapsePath(text);
  const reasons = new Set<string>();
  if (/(^|[\s/])pulls\/[^/\s]+\/merge\b/.test(text)) reasons.add(`calls the PR merge endpoint; ${ASK_TO_LAND}`);
  if (/repos\/[^/\s]+\/[^/\s]+\/merges\b/.test(text)) reasons.add(`calls the branch merges endpoint; ${ASK_TO_LAND}`);
  if (/mergePullRequest|enablePullRequestAutoMerge/.test(text)) reasons.add(`calls a merge mutation; ${ASK_TO_LAND}`);
  for (const match of text.matchAll(/git\/refs\/heads\/([^\s?]+)/g)) {
    if (protectedOf(ctx).includes(match[1]) && WRITE_METHOD.test(text)) reasons.add(`writes the default branch ref ${match[1]}; ${ONLY_USER}`);
  }
  if (folded.includes("fbs:land")) reasons.add(TYPED_ONLY);
  if (/fbs\/land(\/|\s|$)/.test(folded) || (folded.includes(".token") && (folded.includes("fbs") || folded.includes("land")))) {
    reasons.add("touches the land tokens, which only the user's /fbs:land writes");
  }
  const segments = text.split(SEGMENT_BREAK).map((segment) => segment.trim().split(/\s+/).filter((t) => t !== ""));
  const echoed = segments.some((tokens) => echoesReply(tokens));
  for (const tokens of segments) {
    for (const reason of [...ghMerge(tokens), ...gitPush(tokens, ctx), ...fbsLand(tokens, ctx), ...claudeSession(tokens, echoed)]) reasons.add(reason);
  }
  return [...reasons];
}

const RESUME_FLAG = /^(-r|--resume|-c|--continue)(=|$)|^-[a-zA-Z]*[rc][a-zA-Z]*$/;

/** A nested `claude` run in this repo shares the hooks and, resumed, the session: its prompt would arrive as the user's land answer. */
function claudeSession(tokens: string[], echoed: boolean): string[] {
  const at = tokens.findIndex((t) => basename(t) === "claude");
  if (at === -1) return [];
  const args = tokens.slice(at + 1);
  const words = args.filter((a) => !a.startsWith("-"));
  const answers = echoed || words.some(isScheduledReply) || isScheduledReply(words.join(" "));
  if (!args.some((a) => RESUME_FLAG.test(a)) && !answers) return [];
  return ["a claude run that resumes a session or carries a land answer could answer the land request as if the user typed it; only the user answers it"];
}

function echoesReply(tokens: string[]): boolean {
  const at = tokens.findIndex((t) => basename(t) === "echo" || basename(t) === "printf");
  if (at === -1) return false;
  // The quotes and backslashes are stripped by now, so printf's `land\n` reads `landn`.
  const said = tokens.slice(at + 1).filter((a) => !a.startsWith("-")).join(" ").replace(/%s/g, "").trim();
  return isScheduledReply(said) || isScheduledReply(said.replace(/n$/, ""));
}

function ghMerge(tokens: string[]): string[] {
  const gh = tokens.findIndex((t) => basename(t) === "gh");
  if (gh === -1) return [];
  const rest = tokens.slice(gh + 1);
  const pr = rest.indexOf("pr");
  return pr !== -1 && rest.slice(pr + 1).includes("merge") ? [`gh pr merge merges a PR; ${ASK_TO_LAND}`] : [];
}

const GIT_OPTIONS_WITH_VALUE = ["-C", "-c", "--git-dir", "--work-tree", "--namespace"];

function gitPush(tokens: string[], ctx: GuardContext): string[] {
  const git = tokens.findIndex((t) => basename(t) === "git");
  if (git === -1) return [];
  let i = git + 1;
  while (i < tokens.length && tokens[i].startsWith("-")) i += GIT_OPTIONS_WITH_VALUE.includes(tokens[i]) ? 2 : 1;
  if (tokens[i] !== "push") return [];

  const args = tokens.slice(i + 1);
  const flags = args.filter((a) => a.startsWith("-"));
  const [, ...refspecs] = args.filter((a) => !a.startsWith("-"));
  const reasons: string[] = [];
  // --force-with-lease alone is the only overwrite allowed; --force or a + refspec beside it still forces.
  if (flags.some((f) => f === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f)) || refspecs.some((r) => r.startsWith("+"))) {
    reasons.push("git push --force, -f or a + refspec; use --force-with-lease alone");
  }
  if (flags.some((f) => f === "--all" || f === "--mirror")) reasons.push("git push --all/--mirror would push the default branch");

  const branches = protectedOf(ctx);
  const targets = (refspecs.length === 0 ? [null] : refspecs.map(destination)).map((target) => (target === null || target === "HEAD" ? safeCurrentBranch(ctx) : target));
  const unsafe = targets.find((branch) => branch === null || branches.includes(branch));
  if (unsafe !== undefined) reasons.push(`git push to the default branch (${unsafe ?? "unknown branch"}); ${ONLY_USER}`);
  // fbs land and fbs stack sync lease-push from inside the CLI, which this hook never sees.
  const lease = flags.find((f) => f.startsWith("--force-with-lease") || f === "--force-if-includes");
  const open = lease === undefined ? undefined : openPrsOf(ctx).find((pr) => pr.branch !== null && targets.includes(pr.branch));
  if (lease !== undefined && open !== undefined) {
    reasons.push(`git push ${lease} rewrites ${open.branch}, the branch of ${open.slug}'s open PR, which only gains commits: merge instead of rebasing, and to restack units run fbs stack sync ${open.slug}. If that PR was already merged, run fbs stack sync ${open.slug} first: it records the landing, and this guard then lets the push through`);
  }
  return reasons;
}

function openPrsOf(ctx: GuardContext): OpenPr[] {
  try {
    return ctx.openPrs();
  } catch {
    return [];
  }
}

function destination(refspec: string): string {
  const spec = refspec.replace(/^\+/, "");
  const dst = spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec;
  return dst.replace(/^refs\/heads\//, "");
}

function safeCurrentBranch(ctx: GuardContext): string | null {
  try {
    return ctx.currentBranch();
  } catch {
    return null;
  }
}

const FBS_NAMES = ["fbs", "fbs-bin", "main.ts"];

function fbsLand(tokens: string[], ctx: GuardContext): string[] {
  const fbs = tokens.findIndex((t) => FBS_NAMES.includes(basename(t)));
  if (fbs === -1) return [];
  const rest = tokens.slice(fbs + 1).filter((t) => !t.startsWith("--fbs-"));
  if (rest[0] !== "land" || (rest[1] === "request" && rest[2] !== undefined)) return [];
  const slug = rest[1];
  if (slug !== undefined && SLUG.test(slug) && ctx.hasFreshToken(slug)) return [];
  return [`fbs land${slug === undefined ? "" : ` ${slug}`} needs a fresh land token, which the user creates by typing /fbs:land`];
}

// ---- While an afk run is running.

/** What the afk rules need of a running run. */
export interface AfkGuardRun {
  slug: string;
  worktree: string;
  branch: string;
  /** The worktree-relative files the protect globs matched at the start; files added later aren't protected. */
  protectedFiles: string[];
  /** `.fbs/config.json`'s `afk.deny` at the run's start commit. */
  deny: string[];
  /** The last kept commit: resets and amends stay allowed over the unchecked commits above it. */
  kept: string;
  /** A met run is held until it lands or stops, without the history rules: the end flow rewrites and pushes. */
  status: "running" | "met";
  /** The call belongs to the run: it comes from the run's session or runs in its worktree. Only such calls get the run's command rules. */
  ownsCall: boolean;
}

// The afk state, or the whole fbs dir that holds it; the rest of `<common>/fbs/` belongs to the rest of fbs's flow.
const AFK_STATE = /(^|[\s/])fbs\/afk(\/|\s|$|\.)|\.git\/fbs\/?(\s|$)|--git-(common-)?dir\s*[)`]\/fbs(\/afk\b|\/?(\s|$))/;
const CD_GIT_DIR = /\bcd\s+(\S*\/)?\.git(\/|\s|$)|\bcd\s+\$\(\s*git\s+rev-parse\s+--git-(common-)?dir/;
const SETTINGS = /\/\.claude\/(settings[^/]*\.json$|hooks(\/|$))/;
const MCP_FILE_WRITE = /^mcp__.*__(write_file|edit_file|create_file|create_directory|move_file|delete_file|delete_directory)$/;

/** Deploy and production CLIs, each with the words after it that make the call deploy; an empty list denies every call. */
const DEPLOY_COMMANDS: { cli: string[]; after: string[][] }[] = [
  { cli: ["vercel"], after: [["--prod"]] },
  { cli: ["fly", "flyctl"], after: [["deploy"]] },
  { cli: ["railway"], after: [["up"]] },
  { cli: ["terraform", "tofu"], after: [["apply"], ["destroy"]] },
  { cli: ["pulumi"], after: [["up"], ["destroy"]] },
  { cli: ["kubectl"], after: [["apply"], ["delete"]] },
  { cli: ["helm"], after: [["install"], ["upgrade"]] },
  { cli: ["gcloud", "aws"], after: [["deploy"]] },
  { cli: ["npm", "bun", "pnpm", "yarn"], after: [["publish"]] },
  { cli: ["prisma"], after: [["migrate", "deploy"]] },
  { cli: ["supabase"], after: [["db", "push"]] },
  { cli: ["wrangler"], after: [["deploy"], ["publish"]] },
  { cli: ["heroku"], after: [[]] },
];

// Package managers that run a script by name without `run`.
const DIRECT_SCRIPTS = ["bun", "pnpm", "yarn"];
const DEPLOY_SCRIPT = /^(deploy|release|publish)/;

/** Commands that write the files they name: every argument, or only the last (the destination). */
const WRITE_COMMANDS: Record<string, "all" | "last"> = { tee: "all", mv: "all", rm: "all", ln: "all", truncate: "all", cp: "last", install: "last", rsync: "last" };

/** Why the guard denies this tool call while the afk `runs` are running or met; empty to allow. */
export function afkDenials(toolName: string, toolInput: Record<string, unknown>, cwd: string, commonDir: string, runs: AfkGuardRun[], ctx: GuardContext): string[] {
  if (runs.length === 0) return [];
  const reasons: string[] = [];
  if (WRITE_TOOLS.includes(toolName) || MCP_FILE_WRITE.test(toolName)) {
    const paths = [toolInput.file_path, toolInput.notebook_path, toolInput.path, toolInput.source, toolInput.destination].filter((p): p is string => typeof p === "string");
    for (const path of paths) reasons.push(...writeDenials(path, cwd, commonDir, runs));
  }
  if (COMMAND_TOOLS.includes(toolName) && typeof toolInput.command === "string") reasons.push(...afkCommandDenials(toolInput.command, cwd, commonDir, runs, ctx));
  const met = runs.find((run) => run.status === "met");
  if (reasons.length > 0 && met !== undefined) reasons.push(`afk run ${met.slug} is met and the guard holds it until fbs land; if its PR is already merged, run fbs afk stop ${met.slug} --reason merged`);
  return [...new Set(reasons)];
}

function stateDenial(what: string, run: AfkGuardRun, verb: string): string {
  const next = run.status === "running" ? `record a step with fbs afk check ${run.slug}` : `read it with fbs afk show ${run.slug}`;
  return `${what} the afk run's state, which only fbs afk commands ${verb}; ${next}`;
}

/** Why writing `path` is denied for every call: the fbs state, a run's protected files, Claude Code's settings and hooks. */
function writeDenials(path: string, cwd: string, commonDir: string, runs: AfkGuardRun[]): string[] {
  const reasons: string[] = [];
  const full = collapsePath(realPath(resolve(cwd, path)));
  const afkState = collapsePath(realPath(join(commonDir, "fbs", "afk")));
  // The state itself, or a dir above it up to the common dir, which a delete would take with it.
  if (isUnder(full, afkState) || (isUnder(full, collapsePath(realPath(commonDir))) && isUnder(afkState, full))) reasons.push(stateDenial(`${path} is`, runs[0], "write"));
  if (SETTINGS.test(full)) reasons.push(`${path} is Claude Code's settings or hooks, which decide what guards afk run ${runs[0].slug}; leave them to the user`);
  for (const run of runs) {
    const root = collapsePath(realPath(run.worktree));
    const files = run.protectedFiles.map((f) => f.toLowerCase());
    // The run's own calls may mean a relative path from the worktree's root, whatever the shell's directory.
    const candidates = isAbsolute(path) || !run.ownsCall ? [full] : [full, collapsePath(join(root, path))];
    const rel = candidates.map((c) => relative(root, c)).find((r) => files.includes(r));
    if (rel !== undefined) reasons.push(`${rel} is protected in afk run ${run.slug}; reach the finish line by changing the code, or if the protected file itself is wrong, fbs afk stop ${run.slug} --reason <why>`);
  }
  return reasons;
}

/**
 * Scan the command like `commandDenials`. Every call: the fbs state and writes to protected files, settings and hooks.
 * Calls the run owns: deploys, the repo's `afk.deny` and history rewrites in its worktree.
 */
export function afkCommandDenials(command: string, cwd: string, commonDir: string, runs: AfkGuardRun[], ctx: GuardContext): string[] {
  if (runs.length === 0) return [];
  const text = command.replace(/\\\r?\n/g, " ").replace(/["'\\]/g, "");
  const folded = collapsePath(text);
  const owning = runs.filter((run) => run.ownsCall);
  const reasons = new Set<string>();
  const state = stateDenial("touches", runs[0], "read and write");
  if (AFK_STATE.test(folded) || CD_GIT_DIR.test(folded)) reasons.add(state);
  const fbsDir = collapsePath(join(commonDir, "fbs"));
  for (const segment of text.split(SEGMENT_BREAK)) {
    const lower = collapsePath(segment);
    const tokens = segment.trim().split(/\s+/).filter((t) => t !== "");
    const atFbsDir = lower.includes(`${fbsDir}/afk`) || new RegExp(`${fbsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?(\\s|$)`).test(lower);
    if ((atFbsDir || AFK_STATE.test(lower)) && !isAfkCommand(tokens, segment)) reasons.add(state);
    for (const target of writeTargets(tokens, segment)) for (const reason of writeDenials(target, cwd, commonDir, runs)) reasons.add(reason);
    if (owning.length > 0) for (const reason of deployDenials(tokens, owning[0].slug)) reasons.add(reason);
    for (const run of runs) for (const reason of gitHistoryDenials(tokens, cwd, run, ctx)) reasons.add(reason);
  }
  for (const run of owning) {
    for (const entry of run.deny) {
      const needle = entry.toLowerCase();
      if (needle.trim() !== "" && (command.toLowerCase().includes(needle) || text.toLowerCase().includes(needle))) {
        reasons.add(`matches ${JSON.stringify(entry)} in .fbs/config.json afk.deny, which an afk run never runs; leave it for the PR and the human, or fbs afk stop ${run.slug} --reason <why> if the run needs it`);
      }
    }
  }
  return [...reasons];
}

/** The paths a command segment writes: redirect targets, and the files of tee, mv, cp, rm, ln, truncate, sed -i, perl -i, git rm and git mv. */
function writeTargets(tokens: string[], segment: string): string[] {
  // A commit or tag message is text, not a command.
  const git = tokens.findIndex((t) => basename(t) === "git");
  if (git !== -1 && tokens.slice(git + 1).some((t) => t === "commit" || t === "tag")) return [];
  const targets = [...segment.matchAll(/>{1,2}\|?\s*([^\s<>&|;]+)/g)].map((m) => m[1]);
  for (const [i, token] of tokens.entries()) {
    const name = basename(token);
    const rest = tokens.slice(i + 1);
    const args = rest.filter((a) => !a.startsWith("-"));
    const mode = Object.hasOwn(WRITE_COMMANDS, name) ? WRITE_COMMANDS[name] : undefined;
    if (mode !== undefined) targets.push(...(mode === "last" ? args.slice(-1) : args));
    else if ((name === "sed" || name === "perl") && rest.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) targets.push(...args);
    else if (name === "git" && (rest[0] === "rm" || rest[0] === "mv")) targets.push(...args.slice(1));
  }
  return targets;
}

const COMMAND_PREFIXES = ["bun", "exec", "env", "command"];

/** An `fbs afk …` or `fbs afk-guard …` call with nothing but env and launchers before it, and no redirect into a file. */
function isAfkCommand(tokens: string[], segment: string): boolean {
  const fbs = tokens.findIndex((t) => FBS_NAMES.includes(basename(t)));
  if (fbs === -1 || /> *\S/.test(segment)) return false;
  if (!tokens.slice(0, fbs).every((t) => COMMAND_PREFIXES.includes(t) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t))) return false;
  const sub = tokens.slice(fbs + 1).find((t) => !t.startsWith("--fbs-"));
  return sub === "afk" || sub === "afk-guard";
}

function deployDenials(tokens: string[], slug: string): string[] {
  const denied = (what: string) => `${what} deploys or changes production, which an afk run never does; leave it for the PR and the human, or fbs afk stop ${slug} --reason <why> if the goal needs it`;
  const reasons: string[] = [];
  for (const { cli, after } of DEPLOY_COMMANDS) {
    const at = tokens.findIndex((t) => cli.includes(basename(t)));
    if (at === -1) continue;
    const rest = tokens.slice(at + 1);
    const words = after.find((set) => set.every((w) => rest.some((t) => t === w || t.startsWith(`${w}=`))));
    if (words !== undefined) reasons.push(denied([basename(tokens[at]), ...words].join(" ")));
  }
  const pm = tokens.findIndex((t) => ["npm", ...DIRECT_SCRIPTS].includes(basename(t)));
  if (pm !== -1) {
    const manager = basename(tokens[pm]);
    const [first, second] = tokens.slice(pm + 1).filter((t) => !t.startsWith("-"));
    const script = first === "run" || first === "run-script" ? second : DIRECT_SCRIPTS.includes(manager) && first !== "publish" ? first : undefined;
    if (script !== undefined && DEPLOY_SCRIPT.test(script)) reasons.push(denied(`${manager} run ${script}`));
  }
  return reasons;
}

function gitHistoryDenials(tokens: string[], cwd: string, run: AfkGuardRun, ctx: GuardContext): string[] {
  const git = tokens.findIndex((t) => basename(t) === "git");
  if (git === -1) return [];
  let i = git + 1;
  let dir = cwd;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    if (tokens[i] === "-C" && tokens[i + 1] !== undefined) dir = resolve(dir, tokens[i + 1]);
    i += GIT_OPTIONS_WITH_VALUE.includes(tokens[i]) ? 2 : 1;
  }
  if (run.status !== "running" || (!run.ownsCall && !isUnder(collapsePath(realPath(dir)), collapsePath(realPath(run.worktree))))) return [];
  const sub = tokens[i];
  const args = tokens.slice(i + 1);
  const dashes = args.indexOf("--");
  const [target] = (dashes === -1 ? args : args.slice(0, dashes)).filter((a) => !a.startsWith("-"));
  const atHead = target === undefined || target === "HEAD" || target === "@";
  const check = `fbs afk check ${run.slug}`;
  switch (sub) {
    case "commit":
      return args.includes("--amend") && !ctx.isStepAbove(dir, "HEAD", run.kept) ? [`git commit --amend rewrites a step the afk run already checked; make a new commit and run ${check}`] : [];
    case "rebase":
      return [`git rebase rewrites the steps afk run ${run.slug} kept; the CLI keeps and discards steps: commit the next step and run ${check}`];
    case "stash":
      return target === "list" || target === "show" ? [] : [`git stash hides or brings back work afk run ${run.slug} doesn't see; commit the step and run ${check}, or drop an uncommitted edit with git reset --hard`];
    case "switch":
      return [`git switch leaves the afk run's branch ${run.branch}; stay on it, and restore a file with git checkout -- <path>`];
    case "checkout": {
      if (args.some((a) => ["-b", "-B", "--orphan", "--detach"].includes(a))) return [`git checkout ${args.join(" ")} leaves the afk run's branch ${run.branch}; stay on it`];
      if (dashes !== -1 && dashes < args.length - 1) return [];
      if (atHead || target === run.branch || !ctx.isCommit(target)) return [];
      return [`git checkout ${target} leaves the afk run's branch ${run.branch}; stay on it, and restore a file with git checkout -- <path>`];
    }
    case "reset":
      return atHead || ctx.isStepAbove(dir, target, run.kept)
        ? []
        : [`git reset ${target} would drop or rewrite kept steps; the CLI discards steps itself when you run ${check}; to drop an uncommitted edit use git reset --hard, to unstage a file git reset -- <path>`];
    case "push":
      return args.some((a) => a.startsWith("--force") || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith("+"))
        ? [`git push --force* rewrites the afk run's remote branch; an afk run only adds commits, and pushes at the end through fbs push`]
        : [];
    default:
      return [];
  }
}

function isUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `path` with symlinks resolved as far as it exists, so a link or a new file under one can't hide a protected path. */
function realPath(path: string): string {
  const rest: string[] = [];
  for (let dir = path; ; dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), ...rest.reverse());
    } catch {
      if (dirname(dir) === dir) return path;
      rest.push(basename(dir));
    }
  }
}

/** The afk runs the guard holds, running or met until landed or stopped, as it sees them; `sessionId` is the hook's. */
function afkGuardRuns(cwd: string, commonDir: string, sessionId: string | null): AfkGuardRun[] {
  return afkRunsIn(commonDir, ["running", "met"]).map((run) => {
    let deny: string[] = [];
    try {
      deny = runConfig(run).afk?.deny ?? [];
    } catch {}
    const ownsCall = (sessionId !== null && run.sessionId === sessionId) || isUnder(collapsePath(realPath(cwd)), collapsePath(realPath(run.worktree)));
    const status = run.status === "met" ? "met" : "running";
    return { slug: run.slug, worktree: run.worktree, branch: run.branch, protectedFiles: Object.keys(run.protected ?? {}), deny, kept: run.kept.sha, status, ownsCall };
  });
}

/** The branches only the user pushes to: main, master and origin's default branch. */
export function protectedBranches(cwd: string): string[] {
  return [...new Set([...DEFAULT_BRANCHES, originDefaultBranch(cwd) ?? "main"])];
}

/** The real context for the repo whose common dir is `commonDir`. */
export function repoContext(cwd: string, commonDir: string, now: number): GuardContext {
  return {
    protectedBranches: () => protectedBranches(cwd),
    currentBranch: () => currentBranch(cwd),
    openPrs: () => openPrRecords(commonDir),
    hasFreshToken: (slug) => freshToken(commonDir, landTokenSlug(cwd, slug), now) !== null,
    isCommit: (ref) => commitOf(cwd, ref) !== null,
    isStepAbove: (dir, ref, kept) => {
      try {
        const sha = commitOf(dir, ref);
        return sha !== null && sha !== kept && mergeBase(dir, kept, sha) === kept;
      } catch {
        return false;
      }
    },
  };
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Same rule as bin/fbs-guard: a cwd that doesn't exist falls back to the process's.
function hookCwd(input: Record<string, unknown> | null, fallbackCwd: string): string {
  return typeof input?.cwd === "string" && existsSync(input.cwd) ? input.cwd : fallbackCwd;
}

export interface GuardResult {
  /** Reasons to deny; empty to allow. */
  deny: string[];
}

/**
 * The PreToolUse check. Outside a repo, or with no camp marker, no open fbs PR and no running afk run, it allows everything; it never throws.
 * Unparseable input with a marker is scanned as raw text, so it fails closed only on the dangerous patterns.
 */
export function guardToolUse(raw: string, fallbackCwd: string, now: number): GuardResult {
  const input = parseObject(raw);
  const cwd = hookCwd(input, fallbackCwd);
  let commonDir: string;
  let camps: string[];
  let prs: OpenPr[];
  try {
    commonDir = gitCommonDir(cwd);
    camps = campMarkers(commonDir);
    prs = openPrRecords(commonDir);
  } catch {
    return { deny: [] };
  }
  let runs: AfkGuardRun[] = [];
  try {
    runs = afkGuardRuns(cwd, commonDir, typeof input?.session_id === "string" ? input.session_id : null);
  } catch {}
  if (camps.length === 0 && prs.length === 0 && runs.length === 0) return { deny: [] };
  // A PR flow (a camp, or any open fbs PR, camp or not) holds its rules for every call in the repo; an afk run only for its own calls.
  const campRules = camps.length > 0 || prs.length > 0 || runs.some((run) => run.ownsCall);
  const ctx = repoContext(cwd, commonDir, now);
  if (input === null) {
    const text = raw.replace(/[{}[\]":,]/g, " ");
    const deny = [...(campRules ? commandDenials(text, ctx) : []), ...afkCommandDenials(text, cwd, commonDir, runs, ctx)];
    if (campRules && /mcp__\S*__merge_pull_request/.test(raw)) deny.push(`a merge_pull_request MCP tool merges a PR; ${ASK_TO_LAND}`);
    return { deny };
  }
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = typeof input.tool_input === "object" && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : {};
  return { deny: [...new Set([...(campRules ? denials(toolName, toolInput, cwd, ctx) : []), ...afkDenials(toolName, toolInput, cwd, commonDir, runs, ctx)])] };
}

const LAND_COMMANDS = ["land", "fbs:land"];

/**
 * The UserPromptExpansion step: when the user types `/fbs:land [slug]`, write that slug's token, bound to its stamp tree;
 * a feature with units gets its next unit's. The first argument is the slug only when it names a feature, so text after
 * the command is fine; otherwise it takes the single running PR flow's. Returns what it did, for stderr; never throws.
 */
export function guardPrompt(raw: string, fallbackCwd: string, now: number): string | null {
  try {
    const input = parseObject(raw);
    if (input?.hook_event_name !== "UserPromptExpansion" || input.expansion_type !== "slash_command") return null;
    if (typeof input.command_name !== "string" || !LAND_COMMANDS.includes(input.command_name)) return null;
    const args = typeof input.command_args === "string" ? input.command_args.trim().split(/\s+/).filter((a) => a !== "") : [];
    const cwd = hookCwd(input, fallbackCwd);
    const commonDir = gitCommonDir(cwd);
    const markers = campMarkers(commonDir);
    const named = args[0] !== undefined && SLUG.test(args[0]) && existsSync(recordPath(cwd, args[0])) ? args[0] : undefined;
    const slug = named ?? (markers.length === 1 ? markers[0] : undefined);
    if (slug === undefined) return "no land token: name the feature, /fbs:land <slug>";
    const target = landTokenSlug(cwd, slug);
    if (target === slug && featureUnits(cwd, slug).length > 0) return `no land token: no unit of ${slug} has an open PR`;
    const tree = readFeature(cwd, target).stamp?.tree;
    if (tree === undefined) return `no land token: ${target} has no verify stamp`;
    writeLandToken(commonDir, { slug: target, at: now, tree });
    return `land token written for ${target}${target === slug ? "" : `, the next unit of ${slug} to land`}`;
  } catch {
    return null;
  }
}

/**
 * The whole reply, nothing else: a subagent report or another session's message always carries more text. Not "yes":
 * a pending request plus a yes to an unrelated question would land the PR.
 */
const LAND_REPLY = /^land(?: it| #(\d+))?[.!]?$/i;

/**
 * The UserPromptSubmit step: while a land request is pending, the user's bare answer (`land`, `land it`, `land #<pr>`)
 * in the session that asked writes the land token, bound to the record's current stamp tree, and takes the request.
 * An expired or stale request (stamped again, PR changed, landed, no session) is dropped. Returns a note for the model
 * when the prompt was a land answer; never throws.
 */
export function guardReply(raw: string, fallbackCwd: string, now: number): string | null {
  try {
    const input = parseObject(raw);
    if (input?.hook_event_name !== "UserPromptSubmit" || typeof input.prompt !== "string") return null;
    const cwd = hookCwd(input, fallbackCwd);
    const commonDir = gitCommonDir(cwd);
    const path = landRequestPath(commonDir);
    if (!existsSync(path)) return null;
    const answer = LAND_REPLY.exec(input.prompt.trim());
    const request = liveRequest(cwd, path, now);
    if (request === null) {
      rmSync(path, { force: true });
      return answer !== null ? "the land request had expired or gone stale, so no land token was written; run fbs land request <slug> and ask again" : null;
    }
    if (answer === null || input.session_id !== request.session) return null;
    if (answer[1] !== undefined && Number(answer[1]) !== request.pr) return `the user named PR #${answer[1]}, but the pending land request is for PR #${request.pr} (${request.slug}); no land token was written`;
    rmSync(path, { force: true });
    writeLandToken(commonDir, { slug: request.slug, at: now, tree: request.tree, ...(request.over !== undefined && { over: request.over }) });
    const over = request.over === undefined ? "" : ` over the failing checks ${request.over.map(describeOver).join(", ")}`;
    return `the user answered land for ${request.slug} (PR #${request.pr})${over}; its land token is written: run fbs land ${request.slug}`;
  } catch {
    return null;
  }
}

/** One confirmed check as the user reads it: `CI / e2e (cancelled)`, `deploy (didn't run)`. */
export function describeOver(check: OverCheck): string {
  return `${check.workflow === undefined ? "" : `${check.workflow} / `}${check.name} (${check.state === "missing" ? "didn't run" : check.state})`;
}

/** The pending land request still waiting for an answer, if any. */
export function pendingLandRequest(cwd: string, now: number): LandRequest | null {
  try {
    return liveRequest(cwd, landRequestPath(gitCommonDir(cwd)), now);
  } catch {
    return null;
  }
}

/** The request at `path` if it is well formed, from a session, younger than 10 minutes, and its record still has that PR, unlanded, at that stamp. */
function liveRequest(cwd: string, path: string, now: number): LandRequest | null {
  try {
    const request = JSON.parse(readFileSync(path, "utf8"));
    const fresh =
      typeof request.slug === "string" && SLUG.test(request.slug) && Number.isInteger(request.pr) && typeof request.tree === "string" && typeof request.session === "string" && request.session !== "" && Number.isInteger(request.at) && request.at <= now && now - request.at < REQUEST_TTL_MS;
    const over = request.over === undefined ? undefined : readOverChecks(request.over);
    if (!fresh || over === null) return null;
    const rec = readFeature(cwd, request.slug);
    const current = rec.landed === undefined && rec.pr === request.pr && rec.stamp?.tree === request.tree;
    if (!current) return null;
    return { slug: request.slug, pr: request.pr, tree: request.tree, at: request.at, session: request.session, ...(over !== undefined && { over }) };
  } catch {
    return null;
  }
}
