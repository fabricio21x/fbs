import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import plugin from "../.claude-plugin/plugin.json";
import { AfkError, type AfkDeps, afkGuardRun, checkStep, finalRun, parseSpec, REAL_AFK_DEPS, resumeRun, showRun, startRun, stopCheck, stopRun } from "./afk";
import { preflight } from "./afk-preflight";
import { askCheck } from "./ask-check";
import { BranchRefusedError, enterFeatureBranch, pushFeatureBranch } from "./branch";
import { addFollowup, CampError, COUNTS, type Counts, closeFollowup, recordCheckpoint, recordRound, showCamp, startCamp, stopCamp } from "./camp";
import { CommitsRefusedError, commitProblems, isConventionalSubject } from "./commits";
import { ConfigError, projectConfig } from "./config";
import { checkContext } from "./context";
import { isValidDate, localDate } from "./date";
import { GitError, NotAGitRepoError, rootFor, setGitBinary } from "./git";
import { COMMENT_KEY_FORMS, type CommentKey, GhError, type GhRunner, ghReader, NotOnPrError, parseCommentKey, replyToComment, repoName, resolveThread, runGh, setGhBinary } from "./github";
import { guardPrompt, guardReply, guardToolUse } from "./guard";
import { LandRefusedError, land, requestLand } from "./land";
import { checkPolish, type PolishDeps, REAL_POLISH_DEPS, setClaudeBinary } from "./polish";
import { syncStack } from "./stack";
import { detectTracker } from "./tracker";
import type { GateResult } from "./spec-gate";
import { carryStamp, checkStamp, setStamp, StampRefusedError, stampProblems } from "./stamp";
import {
  ApprovalRefusedError,
  approve,
  approveAsAgent,
  checkGate,
  clearPr,
  clearTicket,
  type DocKind,
  docsDir,
  docsMode,
  documentsRecord,
  type FeatureRecord,
  featurePr,
  featureUnits,
  GateRefusedError,
  initFeature,
  initUnit,
  isApprovalCurrent,
  isUnit,
  listFeatures,
  parsePrRef,
  plannedUnit,
  readFeature,
  RecordError,
  setPr,
  setTicket,
  StatusError,
  type UnitRecord,
} from "./status";
import { type Clock, DEFAULT_INTERVAL_SECONDS, EXIT_CODES, markSeen, readCursor, saveCursor, type WatchOptions, watch, watchAll } from "./watch-pr";

export interface Io {
  cwd: string;
  today: string;
  out: (s: string) => void;
  err: (s: string) => void;
}

/** What the PR commands touch outside the repo; tests pass fakes. */
export interface PrDeps extends Clock {
  gh: GhRunner;
  /** The hook input; read only by `fbs guard` and `fbs afk stop-check`. */
  stdin: () => string;
}

const REAL_PR_DEPS: PrDeps = { gh: runGh, now: () => Date.now(), sleep: (ms) => Bun.sleepSync(ms), stdin: () => readFileSync(0, "utf8") };

const USAGE = [
  "usage: fbs <command>",
  "",
  "commands:",
  "  --version                 print the fbs version",
  "  help                      show this help",
  "  context check [--json]    validate .fbs/context.md",
  "  status init <slug> --size <tiny|bug|mid|big>",
  "  status init <unit slug> --unit-of <feature> [--unit <n>]",
  "                            record a work unit of a big feature whose design approval is current, numbered next",
  "                            in its stack unless --unit names a free number; its dir is <feature dir>/units/<unit slug>",
  "                            and it goes by the feature's spec, design and approvals (approve and gate refuse a unit)",
  "  status show <slug>        a unit adds covers and dependsOn from the design; a feature lists its units",
  "  status list",
  "  status gate <slug> <spec|design>",
  "                            a design's Work units are checked against the spec: units numbered U1..N, one Covers and",
  "                            one Depends on line each, every acceptance criterion covered by exactly one unit (a struck",
  "                            through ~~criterion~~ by none), and dependencies only on existing lower-numbered units;",
  "                            a big design needs the section, None when it ships as one PR",
  "  status approve <slug> <spec|design> --quote <the user's words>",
  "  status approve <slug> design --auto <why the agent may approve it>",
  "  status pr <slug> <number|url|none>",
  "  status ticket <slug> <id|none> [--url <https url>]",
  "                            record the tracker issue the feature works on (ACM-123, or an issue number), or clear it",
  "  tracker show              print .fbs/config.json's tracker as one JSON line, or unset",
  "  tracker detect            print the evidence for a tracker setting as one JSON line: the config, ticket-id prefixes",
  "                            in branch names, tracker links in the last 30 merged PR bodies and the issue count (each",
  "                            null when gh can't tell); reads only",
  "  branch <slug> [--type <feature|bugfix|hotfix|chore>] [--ticket <id>] [--existing] [--parent <branch>]",
  "  branch <slug> --use <branch>",
  "                            put the work tree on the feature's branch and record it; prints one JSON line",
  "                            the recorded branch, else a new <type>/<ticket>-<slug> (or <type>/<slug>) from origin's",
  "                            --parent or default branch; --type is needed only to create one; --ticket defaults to the",
  "                            record's ticket; the ticket is lowercased",
  "                            and a bare issue number becomes issue-<n>; --existing never creates one; --parent moves",
  "                            a recorded branch that has no PR and whose origin copy is only what fbs pushed;",
  "                            --use adopts a branch the user named instead (a unit's must contain the tip of the branch",
  "                            below it, which becomes its parent); an explicit --ticket renames a recorded branch fbs",
  "                            cut to carry it, refused while its PR is open, origin has commits fbs didn't push, the",
  "                            new name is taken or another feature is stacked on it; the next push deletes the old",
  "                            name on origin",
  "  push <slug>               push the feature's branch to origin's branch of that name and track it; prints one JSON line",
  "                            before a PR it overwrites only what fbs pushed last, after one it only adds commits;",
  "                            never main, master or origin's default branch; skipped without an origin remote",
  "  stamp set <slug> --verdict <repo-relative path>",
  "  stamp check <slug>        a unit whose branch isn't checked out is judged on its branch's tip, local else origin's",
  "  stamp carry <slug>        move the stamp onto HEAD's tree without verifying again, when every path changed since the",
  "                            stamped tree is a plain, non-executable .md or .html file in the feature's documents",
  "                            folder, none named afk*, spec.md, design.md, bug.md or plan.md (any case) or the stamp's",
  "                            verdict, and no symlink in the tree points into that folder; keeps verifiedTree, the tree",
  "                            verify ran on; refused on uncommitted changes, an approval that isn't current, a changed",
  "                            local verdict, and for a unit whose branch isn't checked out; prints ok when the stamp",
  "                            already covers HEAD, else carried: <old tree> -> <new tree>; only documents changed: <paths>",
  "  commits check <slug>      list each non-merge commit on the feature's branch since its base, leaving out the parent",
  "                            branch's, whose subject isn't a conventional commit; ok, else exit 1",
  "  commits title <text>      check a PR title the same way; ok, else title: <text> and exit 1",
  "                            conventional: <type>[(<scope>)][!]: <description>, with one of commitlint config-conventional's",
  "                            lowercase types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test",
  "  watch-pr <slug> [--interval <s>] [--timeout <s>] [--once]",
  "                            wait for a verdict on the feature's PR; prints one JSON line",
  "                            a feature with units watches each unit's open PR, lowest first, and reports the first",
  "                            with a verdict, adding its slug and unit; a timeout reports the lowest",
  "                            exit 0 approved-green, 3 activity, 4 closed, 5 timeout, 6 conflict, 7 query-error, 8 ready, 9 waiting",
  "                            --once takes one snapshot (nothing decisive is a timeout)",
  "  pr reply <slug> --comment <thread|issue|review>:<id> --body-file <path>",
  "                            a review thread's key may also be its GraphQL node id, or one of its comments' (thread:PRRT_…,",
  "                            thread:PRRC_…); the reply goes into that thread",
  "  pr resolve <slug> --thread <id>",
  "                            the review thread's node id (PRRT_…)",
  "  camp start <slug> [--auto-fix-rounds <n>]",
  "                            create the PR camp's state (its existence switches on the never-merge guard), or keep its",
  "                            rounds on a resume; the fix budget is --auto-fix-rounds, else the recorded one, else",
  "                            .fbs/config.json camp.autoFixRounds, else 2; prints the state",
  "  camp round <slug> --in <n> --fixed <n> --declined <n> --followups <n> --asked <n> [--note <text>] [--unit <unit slug>]",
  "                            record a round and print what comes next: continue while fewer rounds than the budget fixed",
  "                            something, checkpoint once the budget is spent until camp checkpoint records it, then",
  "                            blockers-only; --unit counts a stack's rounds per unit, under the feature's camp",
  "  camp checkpoint <slug> [--unit <unit slug>]",
  "                            record that the checkpoint was held; prints blockers-only; refused before one is due",
  "  camp show <slug> [--unit <unit slug>]",
  "                            print the state: budget, phase (auto, checkpoint or blockers-only; of --unit when given),",
  "                            each unit's phase, checkpoints held, rounds, followups (each with its status: open, filed or",
  "                            declined) and openFollowups (the open ones); a camp file fbs didn't write counts as empty",
  "  camp stop <slug>          remove the camp file, switching the never-merge guard off; follow-ups stay; prints stopped",
  "  camp followup <slug> --thread <key> --summary <text> [--why <text>] [--unit <unit slug>]",
  "                            record a valid out-of-scope finding (the thread key as pr reply takes it) for a ticket later;",
  "                            kept in <git common dir>/fbs/pr/<slug>.followups.json, outside the tree, which camp stop and",
  "                            land leave; prints it as one JSON line with its number, round and status open",
  "  camp followup <slug> --filed <n> --link <url>",
  "  camp followup <slug> --declined <n>",
  "                            close follow-up n: filed with its ticket's link, or declined; prints it; works after the camp",
  "                            stopped; a filed one can't be declined, nor a declined one filed",
  "  land <slug>                merge the feature's PR; needs the token the user's /fbs:land writes",
  "                            a feature with units lands its lowest unit with an open PR, and a unit lands only when it",
  "                            is that one (bottom-up); /fbs:land on the feature or that unit writes the unit's token;",
  "                            then the unit above, when its PR is open, is restacked in a temporary worktree: git rebase",
  "                            --onto origin/<default> <landed head>, a push with --force-with-lease on origin's tip and",
  "                            gh pr edit --base <default>; each unit above it is rebased onto the one below the same way,",
  "                            and so is each plain feature whose parent is the landed branch (one with no PR and no push",
  "                            only here); only for branches still stacked on the landed one; restack in the JSON says",
  "                            what happened to the unit above, stacked (when any) to the rest ({slug,pr,done,treeChanged}",
  "                            or {slug,pr,done,kind,reason}, kind as for stack sync), and a restack that fails (a",
  "                            conflict or a refused push leaves the branch as it was) never fails the land",
  "  land request <slug>       ask for a land: write a pending request for the PR and stamp that land <slug> would land;",
  "                            the user's bare reply (land, land it, land #<pr>) within 10 minutes, in the session that",
  "                            asked ($CLAUDE_CODE_SESSION_ID, required), turns it into the land token; prints",
  "                            {requested,slug,pr}; refused like land with no PR or no stamp, and while another",
  "                            feature's request waits for an answer (the same feature's is refreshed)",
  "  land request <slug> --over-failing",
  "                            the same, listing in over ({name,workflow?,state}) the PR's checks that completed without",
  "                            passing (failed or cancelled) and the base branch's required checks that never ran",
  "                            (missing), which the user's answer confirms; prints {requested,slug,pr,over}, or a plain",
  "                            request with a note when none fails; refused while any check still runs, and when a",
  "                            refresh of the waiting request would add a check; land then ignores those checks, refuses",
  "                            any other failure, accepts UNSTABLE, and on BLOCKED merges with --admin only for a repo",
  "                            admin, every required check passed or confirmed, and every branch protection setting and",
  "                            ruleset rule one fbs understands (else refused, naming it); the landed record keeps over",
  "  stack sync <slug>         keep every unlanded unit of the feature (or of a unit's feature) holding the tip of the unit",
  "                            below it, or origin's default branch once that unit landed, bottom-up; first asks gh for",
  "                            each unlanded unit's PR and records one merged outside fbs land as landed (by: outside);",
  "                            then fast-forward each",
  "                            to origin's copy, merge what it lacks (where it is checked out, which must be clean, else in",
  "                            a temporary worktree); a unit whose parent landed is rebased onto origin's default branch,",
  "                            pushed with a lease and retargeted, and the units above it rebased onto it and pushed; a",
  "                            unit based on the default branch is only fast-forwarded, since camp merges a moved base; prints",
  "                            {units:[{slug,unit,fastForwarded,merged,treeChanged,retargeted,pushNeeded,done,kind?,reason?}],",
  "                            outside?:[{slug,pr,kind,reason,stacked?}]}, kind landed, closed, merged-elsewhere or",
  "                            gh-failed, stacked the plain features restacked on a landed one as land does;",
  "                            stops at the first unit it can't sync with exit 1; treeChanged is against the unit's stamp,",
  "                            else origin's tip before the sync; a plain feature records its own PR merged outside fbs",
  "                            land (restacking what was cut from it), and one cut from another feature's branch is",
  "                            restacked as land would once that one landed (asking gh first), printing {units:[],",
  "                            outside?, restack} with restack null when nothing is due, exit 1 when it isn't done",
  "                            kind, on a unit or restack not done: conflict, dirty, diverged, gone (its branch or origin's",
  "                            default branch is missing), missing-below (the branch it stacks on is), not-merged-yet (the",
  "                            squash commit isn't on origin's default branch), push-rejected, retarget-failed, error (an",
  "                            unexpected git failure in land's restack)",
  "  guard [--prompt|--reply]  hook entry: deny merges and default-branch pushes while a PR flow runs (a camp, or any",
  "                            feature with an open PR); --prompt writes the land token when the user types /fbs:land;",
  "                            --reply writes it when the user answers a pending land request with a bare land",
  "  ask-check                 hook entry on AskUserQuestion: deny an Assuming, Confirm or Approve question, or one that",
  "                            says \"above\", when its message wrote no text in the chat before the call",
  "  afk start <slug> --spec <file> [--session <id>] [--restart]",
  "                            record an afk run from a JSON spec (goal, checks, scope, protect, budgets) and its baseline;",
  "                            bound to --session, else to $CLAUDE_CODE_SESSION_ID; --restart archives a finished run first",
  "  afk check <slug>          afk-guard the run's diff, then run the recorded checks on HEAD; prints one JSON line whose",
  "                            decision is kept, discarded (reset to the last kept commit), held (a judge call failed:",
  "                            nothing changes, check the same HEAD again) or stopped; stop rules: met, max-iterations,",
  "                            discards-in-row, protected-changed, guard-flag, judge-error (3 held in a row), state-changed",
  "  afk stop <slug> --reason <text>",
  "  afk show <slug>",
  "  afk resume <slug>         log a new pickup of a running run and rebind it to $CLAUDE_CODE_SESSION_ID; prints the run",
  "  afk final <slug>          measure a met run's HEAD after the final review: afk-guard and every check, both votes;",
  "                            records it and writes verify's evidence index; prints one JSON line",
  "  afk preflight [--force]   report whether merges and default-branch pushes are denied and the branch is protected",
  "  afk stop-check            Stop hook entry: keep this session's running afk run going; never blocks on a failure",
  "  polish check              are the reviews /fbs:polish runs installed? prints {\"ponytail\":<path>,\"thermos\":<path>}, the",
  "                            absolute paths of their SKILL.md rubrics, when ponytail@* and thermos@* are enabled with the",
  "                            file present; else exit 1 with a line per problem and its fix, error: missing plugin: <name>;",
  "                            run <commands>, error: disabled plugin: <id>; run /plugin enable <id> or error: missing rubric:",
  "                            <path>; run /plugin update <id>, or reinstall it, then a last line then /reload-plugins; exit 2",
  "                            with error: <reason> when claude plugin list --json fails, prints no JSON array, or lists",
  "                            either plugin without an installPath; when ponytail is enabled and its default mode isn't",
  "                            off, also prints on stderr warning: ponytail's default mode is <mode>; set it to off: <fix>",
  "  afk-guard <slug>          flag new dependencies, migrations, infra, out-of-scope or protected files and test weakening",
  "                            in the run's diff since its start; prints one JSON line, exit 1 when flagged, 2 on an error",
].join("\n");

export function run(argv: string[], io: Io, deps: PrDeps = REAL_PR_DEPS, afkDeps: AfkDeps = REAL_AFK_DEPS, polishDeps: PolishDeps = REAL_POLISH_DEPS): number {
  const [command, ...rest] = argv;
  if (command === "--version") {
    io.out(`fbs ${plugin.version}`);
    return 0;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return 0;
  }
  if (command === undefined) {
    io.err(USAGE);
    return 2;
  }
  if (command === "guard") return runGuard(rest, io, deps);
  if (command === "ask-check") return runAskCheck(rest, io, deps);
  try {
    if (command === "context") return runContext(rest, io);
    if (command === "status") return runStatus(rest, io, deps);
    if (command === "tracker") return runTracker(rest, io, deps);
    if (command === "stamp") return runStamp(rest, io);
    if (command === "branch") return runBranch(rest, io);
    if (command === "push") return runPush(rest, io);
    if (command === "commits") return runCommits(rest, io);
    if (command === "watch-pr") return runWatchPr(rest, io, deps);
    if (command === "pr") return runPr(rest, io, deps);
    if (command === "camp") return runCamp(rest, io);
    if (command === "land") return runLand(rest, io, deps, afkDeps);
    if (command === "stack") return runStack(rest, io, deps);
    if (command === "afk") return runAfk(rest, io, deps, afkDeps);
    if (command === "afk-guard") return runAfkGuard(rest, io);
    if (command === "polish") return runPolish(rest, io, polishDeps);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof NotAGitRepoError || e instanceof GitError || e instanceof RecordError || e instanceof GhError) {
      io.err(e.message);
      return 2;
    }
    if (isFsError(e)) {
      io.err(e.message.split("\n")[0]);
      return 2;
    }
    throw e;
  }
  io.err(`unknown command: ${command}`);
  return 2;
}

function runPolish(args: string[], io: Io, deps: PolishDeps): number {
  if (args.length !== 1 || args[0] !== "check") {
    io.err(`unknown command: polish ${args.join(" ")}`.trimEnd());
    return 2;
  }
  return checkPolish(deps, io.out, io.err);
}

function isFsError(e: unknown): e is NodeJS.ErrnoException {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return e instanceof Error && typeof code === "string" && /^E[A-Z0-9]+$/.test(code);
}

function runContext(args: string[], io: Io): number {
  const [subcommand, ...flags] = args;
  const json = flags.length === 1 && flags[0] === "--json";
  if (subcommand !== "check" || (flags.length > 0 && !json)) {
    io.err(`unknown command: context ${args.join(" ")}`.trimEnd());
    return 2;
  }

  const config = projectConfig(io.cwd);
  const path = join(rootFor(io.cwd, ".fbs/context.md"), ".fbs", "context.md");
  if (!existsSync(path)) {
    io.out(json ? JSON.stringify({ facts: [], errors: [], stale: [], maxFacts: config.context.maxFacts }, null, 2) : "ok: no context file");
    return 0;
  }

  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch (e) {
    io.err(`cannot read ${path}: ${(e as Error).message.split("\n")[0]}`);
    return 2;
  }
  const report = checkContext(markdown, { ...config.context, today: io.today });
  if (json) {
    io.out(JSON.stringify(report, null, 2));
  } else if (report.errors.length > 0) {
    for (const error of report.errors) io.out(`error: ${error}`);
  } else {
    io.out(`ok: ${report.facts.length}/${report.maxFacts} facts`);
    for (const fact of report.stale) io.out(`stale: ${fact.text} (${fact.date}, ${fact.source})`);
  }
  return report.errors.length > 0 ? 1 : 0;
}

const DOC_KINDS: readonly string[] = ["spec", "design"] satisfies DocKind[];

function runStatus(args: string[], io: Io, deps: PrDeps): number {
  try {
    return dispatchStatus(args, io, deps);
  } catch (e) {
    if (e instanceof StatusError) {
      io.out(`error: ${e.message}`);
      return 1;
    }
    if (e instanceof GateRefusedError) {
      for (const line of blockerLines(e.result)) io.out(line);
      return 1;
    }
    if (e instanceof ApprovalRefusedError) {
      io.out(`refused: ${e.reason}`);
      return 1;
    }
    throw e;
  }
}

function dispatchStatus(args: string[], io: Io, deps: PrDeps): number {
  const usage = () => {
    io.err(`unknown command: status ${args.join(" ")}`.trimEnd());
    return 2;
  };
  const printRecord = (rec: FeatureRecord) => io.out(JSON.stringify(rec, null, 2));
  const [subcommand, ...rest] = args;
  if (subcommand === "init") {
    const init = parseOptions(rest, ["--size", "--unit-of", "--unit"], []);
    if (!init || init.positionals.length !== 1) return usage();
    const { "--size": size, "--unit-of": unitOf, "--unit": unit } = init.values;
    if (size !== undefined && unitOf === undefined && unit === undefined) printRecord(initFeature(io.cwd, init.positionals[0], size, io.today));
    else if (size === undefined && unitOf !== undefined && (unit === undefined || /^[1-9][0-9]*$/.test(unit))) {
      printRecord(initUnit(io.cwd, init.positionals[0], unitOf, unit === undefined ? undefined : Number(unit)));
    } else return usage();
    return 0;
  }
  const parsed = parseFlags(rest, subcommand === "approve" ? ["--quote", "--auto"] : subcommand === "ticket" ? ["--url"] : []);
  if (!parsed) return usage();
  const { positionals, name, flag } = parsed;

  switch (subcommand) {
    case "show":
      if (positionals.length !== 1) return usage();
      io.out(JSON.stringify(shown(io.cwd, readFeature(io.cwd, positionals[0])), null, 2));
      return 0;
    case "list":
      if (positionals.length !== 0) return usage();
      for (const rec of listFeatures(io.cwd, io.err)) io.out(`${rec.slug}\t${rec.size}\t${stage(rec)}`);
      return 0;
    case "gate": {
      const [slug, kind] = positionals;
      if (positionals.length !== 2 || !DOC_KINDS.includes(kind)) return usage();
      const lines = blockerLines(checkGate(io.cwd, slug, kind as DocKind));
      for (const line of lines.length > 0 ? lines : ["ok"]) io.out(line);
      return lines.length > 0 ? 1 : 0;
    }
    case "pr": {
      if (positionals.length !== 2 || flag !== undefined) return usage();
      if (positionals[1] === "none") {
        printRecord(clearPr(io.cwd, positionals[0]));
        return 0;
      }
      const { pr, repo } = parsePrRef(positionals[1]);
      printRecord(setPr(io.cwd, positionals[0], pr, repo ?? repoName(deps.gh, io.cwd)));
      return 0;
    }
    case "ticket": {
      const [slug, id] = positionals;
      if (positionals.length !== 2 || (id === "none" && flag !== undefined)) return usage();
      printRecord(id === "none" ? clearTicket(io.cwd, slug) : setTicket(io.cwd, slug, id, flag));
      return 0;
    }
    case "approve": {
      const [slug, kind] = positionals;
      if (positionals.length !== 2 || !DOC_KINDS.includes(kind) || flag === undefined) return usage();
      const approveAs = name === "--auto" ? approveAsAgent : approve;
      printRecord(approveAs(io.cwd, slug, kind as DocKind, flag, io.today));
      return 0;
    }
    default:
      return usage();
  }
}

/** A record as `status show` prints it: whether its documents are local or tracked and where they are read from, approvals and the stamp marked current, a unit's approvals and plan from its feature, a feature's units. */
function shown(cwd: string, rec: FeatureRecord): object {
  const owner = documentsRecord(cwd, rec);
  const approvals = Object.fromEntries(Object.entries(owner.approvals).map(([kind, approval]) => [kind, { ...approval, current: isApprovalCurrent(cwd, owner, kind as DocKind) }]));
  const stamp = rec.stamp && { ...rec.stamp, current: stampProblems(cwd, rec).length === 0 };
  const docs = docsMode(cwd, rec);
  const docsRoot = docsDir(cwd, rec);
  if (isUnit(rec)) {
    const planned = plannedUnit(cwd, rec);
    return { ...rec, docs, docsRoot, approvals, stamp, covers: planned?.covers ?? null, dependsOn: planned?.dependsOn ?? null };
  }
  const units = featureUnits(cwd, rec.slug).map((unit) => ({
    slug: unit.slug,
    unit: unit.unit,
    branch: unit.branch?.name ?? null,
    pr: unit.pr,
    stamp: unit.stamp ? { current: stampProblems(cwd, unit).length === 0 } : null,
    landed: unit.landed !== undefined,
  }));
  return { ...rec, docs, docsRoot, approvals, stamp, ...(units.length > 0 && { units }) };
}

function runTracker(args: string[], io: Io, deps: PrDeps): number {
  if (args.length !== 1 || !["show", "detect"].includes(args[0])) {
    io.err(`unknown command: tracker ${args.join(" ")}`.trimEnd());
    return 2;
  }
  if (args[0] === "detect") {
    io.out(JSON.stringify(detectTracker(io.cwd, deps.gh)));
    return 0;
  }
  const { tracker } = projectConfig(io.cwd);
  io.out(tracker === undefined ? "unset" : JSON.stringify(tracker));
  return 0;
}

function runStamp(args: string[], io: Io): number {
  const usage = () => {
    io.err(`unknown command: stamp ${args.join(" ")}`.trimEnd());
    return 2;
  };
  const [subcommand, ...rest] = args;
  const parsed = parseFlags(rest, subcommand === "set" ? ["--verdict"] : []);
  if (!parsed || parsed.positionals.length !== 1) return usage();
  const [slug] = parsed.positionals;

  try {
    if (subcommand === "set") {
      if (parsed.flag === undefined) return usage();
      io.out(JSON.stringify(setStamp(io.cwd, slug, parsed.flag, io.today), null, 2));
      return 0;
    }
    if (subcommand === "check") {
      const problems = checkStamp(io.cwd, slug);
      for (const line of problems.length > 0 ? problems : ["ok"]) io.out(line);
      return problems.length > 0 ? 1 : 0;
    }
    if (subcommand === "carry") {
      const carried = carryStamp(io.cwd, slug);
      io.out(carried === null ? "ok" : `carried: ${carried.from.slice(0, 12)} -> ${carried.to.slice(0, 12)}; only documents changed: ${carried.paths.join(", ")}`);
      return 0;
    }
  } catch (e) {
    if (e instanceof StatusError) {
      io.out(`error: ${e.message}`);
      return 1;
    }
    if (e instanceof StampRefusedError) {
      for (const reason of e.reasons) io.out(`refused: ${reason}`);
      return 1;
    }
    throw e;
  }
  return usage();
}

function runBranch(args: string[], io: Io): number {
  const parsed = parseOptions(args, ["--type", "--ticket", "--parent", "--use"], ["--existing"]);
  if (!parsed || parsed.positionals.length !== 1) {
    io.err(`unknown command: branch ${args.join(" ")}`.trimEnd());
    return 2;
  }
  const existing = parsed.flags.includes("--existing");
  const notWithUse = [...(existing ? ["--existing"] : []), ...(parsed.values["--parent"] !== undefined ? ["--parent"] : [])];
  if (parsed.values["--use"] !== undefined && notWithUse.length > 0) {
    io.err(`branch: --use and ${notWithUse.join(" and ")} can't be combined`);
    return 2;
  }
  return refusingOnStdout(io, () => {
    try {
      const { "--type": type, "--ticket": ticket, "--parent": parent, "--use": use } = parsed.values;
      const choice = { type, ticket, parent, use, existing };
      io.out(JSON.stringify(enterFeatureBranch(io.cwd, parsed.positionals[0], choice, io.err)));
      return 0;
    } catch (e) {
      if (!(e instanceof BranchRefusedError)) throw e;
      io.out(`refused: ${e.reason}`);
      return 1;
    }
  });
}

function runPush(args: string[], io: Io): number {
  if (args.length !== 1) {
    io.err(`unknown command: push ${args.join(" ")}`.trimEnd());
    return 2;
  }
  return refusingOnStdout(io, () => {
    try {
      const result = pushFeatureBranch(io.cwd, args[0], io.err);
      io.out(result === null ? "skipped: no origin remote" : JSON.stringify(result));
      return 0;
    } catch (e) {
      if (!(e instanceof BranchRefusedError)) throw e;
      io.out(`refused: ${e.reason}`);
      return 1;
    }
  });
}

function runCommits(args: string[], io: Io): number {
  const [subcommand, ...rest] = args;
  const [arg] = rest;
  const ok = rest.length === 1 && !arg.startsWith("--") && (subcommand === "title" ? arg.trim() !== "" : subcommand === "check");
  if (!ok) {
    io.err(`unknown command: commits ${args.join(" ")}`.trimEnd());
    return 2;
  }
  if (subcommand === "title") {
    const conventional = isConventionalSubject(arg);
    io.out(conventional ? "ok" : `title: ${arg}`);
    return conventional ? 0 : 1;
  }
  return refusingOnStdout(io, () => {
    try {
      const problems = commitProblems(io.cwd, arg);
      for (const line of problems.length > 0 ? problems : ["ok"]) io.out(line);
      return problems.length > 0 ? 1 : 0;
    } catch (e) {
      if (!(e instanceof CommitsRefusedError)) throw e;
      io.out(`refused: ${e.reason}`);
      return 1;
    }
  });
}

function runWatchPr(args: string[], io: Io, deps: PrDeps): number {
  const parsed = parseOptions(args, ["--interval", "--timeout"], ["--once"]);
  const interval = parsed?.values["--interval"] ?? String(DEFAULT_INTERVAL_SECONDS);
  const timeout = parsed?.values["--timeout"];
  if (!parsed || parsed.positionals.length !== 1 || !/^[1-9][0-9]*$/.test(interval) || (timeout !== undefined && !/^[0-9]+$/.test(timeout))) {
    io.err(`unknown command: watch-pr ${args.join(" ")}`.trimEnd());
    return 2;
  }
  const [slug] = parsed.positionals;
  const timeoutSeconds = parsed.flags.includes("--once") ? 0 : timeout === undefined ? null : Number(timeout);
  const options = { intervalSeconds: Number(interval), timeoutSeconds };
  return refusingOnStdout(io, () => {
    const rec = readFeature(io.cwd, slug);
    const units = isUnit(rec) ? [] : featureUnits(io.cwd, slug);
    if (units.length > 0) return watchStack(slug, units, options, io, deps);
    const { pr, repo } = featurePr(io.cwd, slug);
    const cursor = readCursor(io.cwd, slug, pr);
    const result = watch(ghReader(deps.gh, io.cwd, repo), cursor, options, deps, io.err);
    if (result.cursor !== null) saveCursor(io.cwd, slug, result.cursor);
    io.out(JSON.stringify(result.report));
    return EXIT_CODES[result.report.verdict];
  });
}

/** Watch every unit of a feature with an open PR, each on its own cursor; the report names the unit it is about. */
function watchStack(feature: string, units: UnitRecord[], options: WatchOptions, io: Io, deps: PrDeps): number {
  const open = units.filter((unit) => unit.pr !== null && unit.repo !== undefined && unit.landed === undefined);
  if (open.length === 0) {
    io.err(`${feature} has no unit with an open PR; record one with fbs status pr <unit> <number|url>`);
    return 2;
  }
  const targets = open.map((unit) => ({ reader: ghReader(deps.gh, io.cwd, unit.repo as string), cursor: readCursor(io.cwd, unit.slug, unit.pr as number), label: { unit: unit.unit } }));
  const { index, result } = watchAll(targets, options, deps, io.err);
  const { slug, unit } = open[index];
  if (result.cursor !== null) saveCursor(io.cwd, slug, result.cursor);
  io.out(JSON.stringify({ ...result.report, slug, unit }));
  return EXIT_CODES[result.report.verdict];
}

function runPr(args: string[], io: Io, deps: PrDeps): number {
  const [subcommand, ...rest] = args;
  const parsed = parseOptions(rest, subcommand === "reply" ? ["--comment", "--body-file"] : subcommand === "resolve" ? ["--thread"] : [], []);
  const comment = parsed?.values["--comment"];
  const bodyFile = parsed?.values["--body-file"];
  const thread = parsed?.values["--thread"];
  if (!parsed || parsed.positionals.length !== 1 || (subcommand === "reply" ? comment === undefined || bodyFile === undefined : subcommand !== "resolve" || thread === undefined)) {
    io.err(`unknown command: pr ${args.join(" ")}`.trimEnd());
    return 2;
  }
  const key = comment === undefined ? null : parseCommentKey(comment);
  if (comment !== undefined && key === null) {
    io.err(`pr reply: --comment takes ${COMMENT_KEY_FORMS}, not ${comment}`);
    return 2;
  }
  if (thread !== undefined && !/^[A-Za-z][A-Za-z0-9_=-]*$/.test(thread)) {
    io.err(`pr resolve: --thread takes a review thread's node id (PRRT_…), not ${thread}`);
    return 2;
  }
  const [slug] = parsed.positionals;
  return refusingOnStdout(io, () => {
    const { pr, repo } = featurePr(io.cwd, slug);
    if (thread !== undefined) {
      resolveThread(deps.gh, io.cwd, repo, pr, thread);
      io.out(JSON.stringify({ thread, resolved: true }, null, 2));
      return 0;
    }
    const path = resolve(io.cwd, bodyFile as string);
    const body = readFileSync(path, "utf8");
    if (body.trim() === "") throw new StatusError("bad-body", `${path} is empty`);
    const posted = replyToComment(deps.gh, io.cwd, repo, pr, key as CommentKey, body);
    saveCursor(io.cwd, slug, markSeen(readCursor(io.cwd, slug, pr), posted));
    io.out(JSON.stringify(posted, null, 2));
    return 0;
  });
}

const COUNT_FLAGS = COUNTS.map((name) => `--${name}`);

function runCamp(args: string[], io: Io): number {
  const [subcommand, ...rest] = args;
  const valued = { start: ["--auto-fix-rounds"], round: [...COUNT_FLAGS, "--note", "--unit"], checkpoint: ["--unit"], show: ["--unit"], stop: [], followup: ["--thread", "--summary", "--why", "--unit", "--filed", "--link", "--declined"] }[subcommand] ?? null;
  const parsed = valued === null ? null : parseOptions(rest, valued, []);
  if (!parsed || parsed.positionals.length !== 1) {
    io.err(`unknown command: camp ${args.join(" ")}`.trimEnd());
    return 2;
  }
  const [slug] = parsed.positionals;
  const { "--auto-fix-rounds": budget, "--note": note, "--unit": unit } = parsed.values;
  if (budget !== undefined && !/^[1-9][0-9]*$/.test(budget)) {
    io.err(`camp start: --auto-fix-rounds takes a positive integer, not ${budget}`);
    return 2;
  }
  const { "--thread": thread, "--summary": summary, "--why": why, "--filed": filed, "--link": link, "--declined": declined } = parsed.values;
  const closing = filed ?? declined;
  if (subcommand === "followup") {
    const adding = thread !== undefined && summary !== undefined && [filed, link, declined].every((value) => value === undefined);
    const rest = [thread, summary, why, unit];
    const filing = filed !== undefined && link !== undefined && [...rest, declined].every((value) => value === undefined);
    const declining = declined !== undefined && [...rest, filed, link].every((value) => value === undefined);
    if (!adding && !filing && !declining) {
      io.err("camp followup takes --thread <key> --summary <text> [--why <text>] [--unit <unit slug>], --filed <n> --link <url>, or --declined <n>");
      return 2;
    }
    if (thread !== undefined && parseCommentKey(thread) === null) {
      io.err(`camp followup: --thread takes ${COMMENT_KEY_FORMS}, not ${thread}`);
      return 2;
    }
    if (closing !== undefined && !/^[1-9][0-9]*$/.test(closing)) {
      io.err(`camp followup: --${filed !== undefined ? "filed" : "declined"} takes a follow-up's number, not ${closing}`);
      return 2;
    }
  }
  if (subcommand === "round") {
    const missing = COUNT_FLAGS.filter((flag) => parsed.values[flag] === undefined);
    const bad = COUNT_FLAGS.filter((flag) => parsed.values[flag] !== undefined && !/^(0|[1-9][0-9]*)$/.test(parsed.values[flag]));
    if (missing.length > 0 || bad.length > 0) {
      io.err(`camp round needs ${COUNT_FLAGS.map((flag) => `${flag} <n>`).join(" ")}, each a non-negative integer${missing.length > 0 ? `; missing ${missing.join(" ")}` : `; not a count: ${bad.join(" ")}`}`);
      return 2;
    }
  }
  return refusingOnStdout(io, () => {
    try {
      if (subcommand === "start") io.out(JSON.stringify(startCamp(io.cwd, slug, budget === undefined ? undefined : Number(budget), io.err), null, 2));
      else if (subcommand === "show") io.out(JSON.stringify(showCamp(io.cwd, slug, unit, io.err), null, 2));
      else if (subcommand === "checkpoint") io.out(recordCheckpoint(io.cwd, slug, unit, io.err));
      else if (subcommand === "stop") {
        stopCamp(io.cwd, slug);
        io.out("stopped");
      } else if (subcommand === "followup") {
        const followup =
          closing !== undefined
            ? closeFollowup(io.cwd, slug, Number(closing), link ?? null)
            : addFollowup(io.cwd, slug, unit, { thread: thread as string, summary: summary as string, why }, io.today, io.err);
        io.out(JSON.stringify(followup));
      }
      else {
        const counts = Object.fromEntries(COUNTS.map((name) => [name, Number(parsed.values[`--${name}`])])) as Counts;
        io.out(recordRound(io.cwd, slug, unit, counts, note, io.today, io.err));
      }
      return 0;
    } catch (e) {
      if (!(e instanceof CampError)) throw e;
      io.out(`error: ${e.message}`);
      return 1;
    }
  });
}

// With onFailure "block" a crash denies the call, so every failure here is caught: it allows, or denies only a dangerous match.
function runGuard(args: string[], io: Io, deps: PrDeps): number {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--prompt" && args[0] !== "--reply")) {
    io.err(`unknown command: guard ${args.join(" ")}`);
    return 2;
  }
  let raw = "";
  try {
    raw = deps.stdin();
  } catch {}
  if (args[0] === "--prompt") {
    const note = guardPrompt(raw, io.cwd, deps.now());
    if (note !== null) io.err(note);
    return 0;
  }
  // UserPromptSubmit adds stdout to the model's context, so the note tells it the token is there.
  if (args[0] === "--reply") {
    const note = guardReply(raw, io.cwd, deps.now());
    if (note !== null) io.out(`fbs: ${note}`);
    return 0;
  }
  const { deny } = guardToolUse(raw, io.cwd, deps.now());
  if (deny.length === 0) return 0;
  io.err(`blocked by fbs guard (a PR flow or an afk run is running): ${deny.join("; ")}`);
  return 2;
}

function runAskCheck(args: string[], io: Io, deps: PrDeps): number {
  // A hook that exits 2 denies, so a wiring mistake must allow rather than block every question in every session.
  if (args.length > 0) return 0;
  let raw = "";
  try {
    raw = deps.stdin();
  } catch {}
  const reason = askCheck(raw);
  if (reason === null) return 0;
  io.err(`blocked by fbs: ${reason}`);
  return 2;
}

function runLand(args: string[], io: Io, deps: PrDeps, afkDeps: AfkDeps): number {
  const overFailing = args.length === 3 && args[2] === "--over-failing";
  if ((args.length === 2 || overFailing) && args[0] === "request") {
    return refusingOnStdout(io, () => {
      try {
        const { slug, pr, over } = requestLand(io.cwd, args[1], deps.now(), afkDeps.sessionId(), overFailing ? deps.gh : undefined);
        const note = overFailing && over === undefined ? { note: "no check is failing, so this is a plain land request" } : {};
        io.out(JSON.stringify({ requested: true, slug, pr, ...(over !== undefined && { over }), ...note }));
        return 0;
      } catch (e) {
        if (!(e instanceof LandRefusedError)) throw e;
        for (const reason of e.reasons) io.out(`refused: ${reason}`);
        return 1;
      }
    });
  }
  if (args.length !== 1) {
    io.err(`unknown command: land ${args.join(" ")}`.trimEnd());
    return 2;
  }
  return refusingOnStdout(io, () => {
    try {
      io.out(JSON.stringify({ merged: true, ...land(io.cwd, args[0], deps.gh, deps.now(), io.today) }));
      return 0;
    } catch (e) {
      if (!(e instanceof LandRefusedError)) throw e;
      for (const reason of e.reasons) io.out(`refused: ${reason}`);
      return 1;
    }
  });
}

function runStack(args: string[], io: Io, deps: PrDeps): number {
  if (args.length !== 2 || args[0] !== "sync" || args[1].startsWith("--")) {
    io.err(`unknown command: stack ${args.join(" ")}`.trimEnd());
    return 2;
  }
  return refusingOnStdout(io, () => {
    const { units, outside, ...plain } = syncStack(io.cwd, args[1], deps.gh, io.today);
    io.out(JSON.stringify({ units, ...(outside.length > 0 && { outside }), ...plain }));
    return units.every((unit) => unit.done) && plain.restack?.done !== false ? 0 : 1;
  });
}

function runAfk(args: string[], io: Io, deps: PrDeps, afkDeps: AfkDeps): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "stop-check") return runStopCheck(rest, io, deps);
  const valued = subcommand === "start" ? ["--spec", "--session"] : subcommand === "stop" ? ["--reason"] : [];
  const parsed = parseOptions(rest, valued, subcommand === "preflight" ? ["--force"] : subcommand === "start" ? ["--restart"] : []);
  const positionals = subcommand === "preflight" ? 0 : 1;
  const required = subcommand === "start" ? "--spec <file>" : subcommand === "stop" ? "--reason <text>" : null;
  const known = ["start", "check", "stop", "show", "resume", "final", "preflight"].includes(subcommand);
  if (!known || !parsed || parsed.positionals.length !== positionals) {
    io.err(`unknown command: afk ${args.join(" ")}`.trimEnd());
    return 2;
  }
  if (required !== null && parsed.values[required.split(" ")[0]] === undefined) {
    io.err(`afk ${subcommand} needs ${required}`);
    return 2;
  }
  const [slug] = parsed.positionals;
  try {
    switch (subcommand) {
      case "start": {
        const path = resolve(io.cwd, parsed.values["--spec"]);
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(path, "utf8"));
        } catch (e) {
          throw new AfkError("bad-spec", `cannot read ${path} as JSON: ${(e as Error).message.split("\n")[0]}`);
        }
        const sessionId = parsed.values["--session"] ?? afkDeps.sessionId();
        io.out(JSON.stringify(startRun(io.cwd, slug, { spec: parseSpec(raw), sessionId, restart: parsed.flags.includes("--restart") }, afkDeps, deps.now())));
        return 0;
      }
      case "check":
        io.out(JSON.stringify(checkStep(io.cwd, slug, afkDeps, deps.now())));
        return 0;
      case "stop":
        io.out(JSON.stringify(stopRun(io.cwd, slug, parsed.values["--reason"], deps.now())));
        return 0;
      case "show":
        io.out(JSON.stringify(showRun(io.cwd, slug)));
        return 0;
      case "resume":
        io.out(JSON.stringify(resumeRun(io.cwd, slug, deps.now(), afkDeps.sessionId())));
        return 0;
      case "final":
        io.out(JSON.stringify(finalRun(io.cwd, slug, afkDeps, deps.now())));
        return 0;
      default:
        io.out(JSON.stringify(preflight(io.cwd, deps.gh, afkDeps.userSettings, parsed.flags.includes("--force"))));
        return 0;
    }
  } catch (e) {
    if (!(e instanceof AfkError)) throw e;
    io.out(`error: ${e.message}`);
    return 1;
  }
}

// A Stop hook that fails must let the session stop, so every failure here allows.
function runStopCheck(args: string[], io: Io, deps: PrDeps): number {
  if (args.length > 0) {
    io.err(`unknown command: afk stop-check ${args.join(" ")}`);
    return 2;
  }
  let raw = "";
  try {
    raw = deps.stdin();
  } catch {}
  const { block, note } = stopCheck(raw, io.cwd, deps.now());
  if (note !== null) io.err(note);
  if (block !== null) io.out(JSON.stringify({ decision: "block", reason: block }));
  return 0;
}

function runAfkGuard(args: string[], io: Io): number {
  if (args.length !== 1) {
    io.err(`unknown command: afk-guard ${args.join(" ")}`.trimEnd());
    return 2;
  }
  try {
    const { flags } = afkGuardRun(io.cwd, args[0]);
    io.out(JSON.stringify({ flags }));
    return flags.length > 0 ? 1 : 0;
  } catch (e) {
    if (!(e instanceof AfkError)) throw e;
    io.out(`error: ${e.message}`);
    return 2;
  }
}

/** Run `body`, printing a refusal (a missing feature or PR, a comment not on the PR) on stdout with exit 1. */
function refusingOnStdout(io: Io, body: () => number): number {
  try {
    return body();
  } catch (e) {
    if (e instanceof StatusError) {
      io.out(`error: ${e.message}`);
      return 1;
    }
    if (e instanceof NotOnPrError) {
      io.out(`error: not-on-pr: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

/** Split args into positionals, `--name <value>` options from `valued` (each at most once) and bare `flags`; null when malformed. */
function parseOptions(args: string[], valued: string[], flags: string[]): { positionals: string[]; values: Record<string, string>; flags: string[] } | null {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const seen: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) positionals.push(arg);
    else if (flags.includes(arg) && !seen.includes(arg)) seen.push(arg);
    else {
      const value = args[i + 1];
      if (!valued.includes(arg) || arg in values || value === undefined || value.trim() === "") return null;
      values[arg] = value;
      i++;
    }
  }
  return { positionals, values, flags: seen };
}

/** Split args into positionals and at most one `--flag <value>` from `allowed`; null when the flags are malformed. */
function parseFlags(args: string[], allowed: string[]): { positionals: string[]; name: string | undefined; flag: string | undefined } | null {
  const positionals: string[] = [];
  let name: string | undefined;
  let flag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      positionals.push(args[i]);
      continue;
    }
    const value = args[i + 1];
    if (!allowed.includes(args[i]) || flag !== undefined || value === undefined || value.trim() === "") return null;
    name = args[i];
    flag = value;
    i++;
  }
  return { positionals, name, flag };
}

function stage(rec: FeatureRecord): string {
  if (rec.landed) return "landed";
  if (isUnit(rec)) return `unit ${rec.unit} of ${rec.unitOf}`;
  if (rec.approvals.design) return "design approved";
  if (rec.approvals.spec) return "spec approved";
  return "draft";
}

function blockerLines(result: GateResult): string[] {
  return [
    ...result.missingSections.map((name) => `missing section: ${name}`),
    ...result.emptySections.map((name) => `empty section: ${name} (write None if there are none)`),
    ...result.unsourced.map((text) => `unsourced: ${text}`),
    ...result.unconfirmed.map((text) => `unconfirmed: ${text}`),
    ...result.openQuestions.map((text) => `open question: ${text}`),
    ...result.workUnits.map((text) => `work units: ${text}`),
    ...result.unsupported.map((line) => `unsupported markup: ${line}`),
  ];
}

const TOOL_FLAGS = { git: "--fbs-git=", gh: "--fbs-gh=", claude: "--fbs-claude=" };
type ToolPaths = Record<keyof typeof TOOL_FLAGS, string | null>;

/** Split off the leading `--fbs-git=`, `--fbs-gh=` and `--fbs-claude=<path>` that `bin/fbs` adds, in any order. */
export function takeToolFlags(argv: string[]): ToolPaths & { argv: string[] } {
  const tools: ToolPaths = { git: null, gh: null, claude: null };
  let i = 0;
  for (; i < argv.length; i++) {
    const tool = (["git", "gh", "claude"] as const).find((name) => tools[name] === null && argv[i].startsWith(TOOL_FLAGS[name]) && argv[i].length > TOOL_FLAGS[name].length);
    if (tool === undefined) break;
    tools[tool] = argv[i].slice(TOOL_FLAGS[tool].length);
  }
  return { ...tools, argv: argv.slice(i) };
}

if (import.meta.main) {
  const { git, gh, claude, argv } = takeToolFlags(process.argv.slice(2));
  if (git) setGitBinary(git);
  if (gh) setGhBinary(gh);
  if (claude) setClaudeBinary(claude);
  const today = process.env.FBS_TODAY ?? localDate();
  if (!isValidDate(today)) {
    console.error(`invalid FBS_TODAY: ${today}`);
    process.exit(2);
  }
  const io: Io = {
    cwd: process.cwd(),
    today,
    out: (s) => console.log(s),
    err: (s) => console.error(s),
  };
  process.exit(run(argv, io));
}
