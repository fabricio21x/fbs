import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Approval,
  ApprovalRefusedError,
  approve,
  approveAsAgent,
  checkGate,
  clearTicket,
  docPath,
  docsMode,
  documentsRecord,
  type FeatureRecord,
  featureUnits,
  GateRefusedError,
  initFeature,
  initUnit,
  isApprovalCurrent,
  listFeatures,
  plannedUnit,
  readFeature,
  RecordError,
  setTicket,
  unitAbove,
  unitBelow,
} from "./status";
import { isolatedGitEnv } from "./test-env";

const PASSING_SPEC = "## Facts\n- Two beta clients (.fbs/context.md)\n## Assumptions\nNone\n## Open questions\nNone\n";
const PASSING_SHA = createHash("sha256").update(PASSING_SPEC).digest("hex");
const PASSING_DESIGN = `${PASSING_SPEC}## Work units\nNone\n`;
const DESIGN_SHA = createHash("sha256").update(PASSING_DESIGN).digest("hex");

let tempDirs: string[] = [];
let repo: string;
let wt: string;

function git(cwd: string, ...args: string[]): void {
  const identity = ["-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false"];
  const result = Bun.spawnSync(["git", ...identity, ...args], { cwd, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fbs-status-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  repo = tempDir();
  wt = join(tempDir(), "wt");
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function writeDoc(slug: string, file: string, content: string): void {
  writeFileSync(join(repo, readFeature(repo, slug).dir, file), content);
}

test("init creates the dated feature dir and a record outside the work tree", () => {
  const rec = initFeature(repo, "paid-plans", "big", "2026-10-21");
  expect(rec).toEqual({ slug: "paid-plans", dir: "docs/features/2026-10-21-paid-plans", size: "big", approvals: {}, pr: null });
  expect(existsSync(join(repo, rec.dir))).toBe(true);
  expect(existsSync(join(repo, ".git/fbs/features/paid-plans.json"))).toBe(true);
});

test("init uses featuresDir from the config", () => {
  mkdirSync(join(repo, ".fbs"));
  writeFileSync(join(repo, ".fbs", "config.json"), '{"featuresDir":"specs"}');
  expect(initFeature(repo, "x", "mid", "2026-10-21").dir).toBe("specs/2026-10-21-x");
});

test.each(["Paid", "paid plans", "../x", "a/b", ""])("rejects slug %p before writing anything", (slug) => {
  expect(() => initFeature(repo, slug, "mid", "2026-10-21")).toThrow(/bad-slug/);
  expect(existsSync(join(repo, "docs"))).toBe(false);
  expect(existsSync(join(repo, ".git/fbs"))).toBe(false);
});

test("rejects an unknown size before writing anything", () => {
  expect(() => initFeature(repo, "x", "huge", "2026-10-21")).toThrow(/bad-size/);
  expect(existsSync(join(repo, "docs"))).toBe(false);
  expect(existsSync(join(repo, ".git/fbs"))).toBe(false);
});

test("init refuses a slug that already has a record", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  expect(() => initFeature(repo, "x", "big", "2026-10-22")).toThrow(/exists/);
  expect(readFeature(repo, "x").size).toBe("mid");
});

test("the record write leaves no temp file behind", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  expect(readdirSync(join(repo, ".git/fbs/features"))).toEqual(["x.json"]);
});

test("a worktree sees the same record", () => {
  initFeature(repo, "paid-plans", "mid", "2026-10-21");
  git(repo, "worktree", "add", "-q", wt, "-b", "wt");
  expect(readFeature(wt, "paid-plans").size).toBe("mid");
});

test("an approval made in a worktree is seen by the main checkout", () => {
  const rec = initFeature(repo, "x", "mid", "2026-10-21");
  git(repo, "worktree", "add", "-q", wt, "-b", "wt");
  mkdirSync(join(wt, rec.dir), { recursive: true });
  writeFileSync(join(wt, rec.dir, "spec.md"), PASSING_SPEC);
  approve(wt, "x", "spec", "ok", "2026-10-21");
  expect(readFeature(repo, "x").approvals.spec).toEqual({ at: "2026-10-21", by: "user", quote: "ok", sha256: PASSING_SHA });
});

test("documents git ignores are read from the main worktree inside a linked one", () => {
  writeFileSync(join(repo, ".gitignore"), "docs/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "ignore docs");
  const rec = initFeature(repo, "x", "big", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  writeDoc("x", "design.md", PASSING_DESIGN);
  approve(repo, "x", "spec", "ok", "2026-10-21");
  git(repo, "worktree", "add", "-q", wt, "-b", "wt");
  expect(existsSync(join(wt, rec.dir))).toBe(false);
  expect(docsMode(wt, rec)).toBe("local");
  expect(checkGate(wt, "x", "design")).toMatchObject({ missingSections: [] });
  expect(isApprovalCurrent(wt, readFeature(wt, "x"), "spec")).toBe(true);
  approve(wt, "x", "design", "ok", "2026-10-21");
  expect(isApprovalCurrent(repo, readFeature(repo, "x"), "design")).toBe(true);
});

test("a spec approved in the main checkout is current from a linked worktree when the documents are local", () => {
  writeFileSync(join(repo, ".gitignore"), "docs/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "ignore docs");
  initFeature(repo, "x", "mid", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  approve(repo, "x", "spec", "ok", "2026-10-21");
  git(repo, "worktree", "add", "-q", wt, "-b", "wt");
  expect(isApprovalCurrent(wt, readFeature(wt, "x"), "spec")).toBe(true);
  writeDoc("x", "spec.md", `${PASSING_SPEC}edited\n`);
  expect(isApprovalCurrent(wt, readFeature(wt, "x"), "spec")).toBe(false);
});

test("local documents in a bare repo's worktree are refused, since there is no main worktree", () => {
  const bare = join(tempDir(), "bare.git");
  git(repo, "clone", "-q", "--bare", repo, bare);
  git(bare, "worktree", "add", "-q", wt);
  writeFileSync(join(wt, ".gitignore"), "docs/\n");
  expect(() => initFeature(wt, "x", "mid", "2026-10-21")).toThrow("local documents need a main worktree; this repo is bare");
});

test("documents git tracks are read from the worktree's own checkout", () => {
  const rec = initFeature(repo, "x", "mid", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  approve(repo, "x", "spec", "ok", "2026-10-21");
  git(repo, "worktree", "add", "-q", wt, "-b", "wt");
  expect(docsMode(wt, rec)).toBe("tracked");
  expect(isApprovalCurrent(wt, readFeature(wt, "x"), "spec")).toBe(false);
});

test("reading an unknown slug is missing", () => {
  expect(() => readFeature(repo, "nope")).toThrow(/missing/);
});

test("reading an unsafe slug is bad-slug", () => {
  expect(() => readFeature(repo, "../x")).toThrow(/bad-slug/);
});

test("listFeatures returns every record by slug, and none in a fresh repo", () => {
  expect(listFeatures(repo)).toEqual([]);
  initFeature(repo, "b", "mid", "2026-10-21");
  initFeature(repo, "a", "big", "2026-10-21");
  expect(listFeatures(repo).map((r) => r.slug)).toEqual(["a", "b"]);
});

test("docPath names the spec or the design inside the feature dir", () => {
  const rec = initFeature(repo, "x", "big", "2026-10-21");
  expect(docPath(repo, rec, "spec")).toBe("docs/features/2026-10-21-x/spec.md");
  expect(docPath(repo, rec, "design")).toBe("docs/features/2026-10-21-x/design.md");
});

test("checkGate reads the document and reports its blockers", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  writeDoc("x", "spec.md", "## Facts\n- B\n## Assumptions\n- [ ] A\n");
  expect(checkGate(repo, "x", "spec")).toEqual({ missingSections: ["Open questions"], emptySections: [], unsourced: ["B"], unconfirmed: ["A"], openQuestions: [], unsupported: [], workUnits: [] });
});

test("checkGate wants Work units on a big design only", () => {
  initFeature(repo, "x", "big", "2026-10-21");
  writeDoc("x", "design.md", PASSING_SPEC);
  expect(checkGate(repo, "x", "design").missingSections).toEqual(["Work units"]);
  writeDoc("x", "design.md", PASSING_DESIGN);
  expect(checkGate(repo, "x", "design").missingSections).toEqual([]);
  initFeature(repo, "y", "mid", "2026-10-21");
  writeDoc("y", "design.md", PASSING_SPEC);
  expect(checkGate(repo, "y", "design").missingSections).toEqual([]);
});

test("checkGate on a missing document is doc-missing", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  expect(() => checkGate(repo, "x", "spec")).toThrow(/doc-missing/);
});

test("approve refuses while the gate fails and records nothing", () => {
  const rec = initFeature(repo, "paid-plans", "big", "2026-10-21");
  writeFileSync(join(repo, rec.dir, "spec.md"), "## Assumptions\n- [ ] Many clients\n## Open questions\nNone\n");
  expect(() => approve(repo, "paid-plans", "spec", "ok", "2026-10-21")).toThrow(GateRefusedError);
  expect(readFeature(repo, "paid-plans").approvals).toEqual({});
});

test("a refused approval carries the gate result", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  writeDoc("x", "spec.md", "## Assumptions\n- [ ] A\n## Open questions\nNone\n");
  try {
    approve(repo, "x", "spec", "ok", "2026-10-21");
    throw new Error("approve did not refuse");
  } catch (e) {
    expect(e).toBeInstanceOf(GateRefusedError);
    expect((e as GateRefusedError).result.unconfirmed).toEqual(["A"]);
  }
});

test("approve records the quote, the date and the document's sha256 when the gate passes", () => {
  initFeature(repo, "paid-plans", "big", "2026-10-21");
  writeDoc("paid-plans", "spec.md", PASSING_SPEC);
  const expected: Approval = { at: "2026-10-21", by: "user", quote: "looks good, ship it", sha256: PASSING_SHA };
  expect(approve(repo, "paid-plans", "spec", "looks good, ship it", "2026-10-21").approvals.spec).toEqual(expected);
  expect(readFeature(repo, "paid-plans").approvals.spec).toEqual(expected);
});

test("approve on an unknown slug is missing", () => {
  expect(() => approve(repo, "nope", "spec", "ok", "2026-10-21")).toThrow(/missing/);
});

test.each(["mid", "tiny", "bug"])("%s features have one approval: design is refused", (size) => {
  initFeature(repo, "x", size, "2026-10-21");
  writeDoc("x", "design.md", PASSING_DESIGN);
  expect(() => approve(repo, "x", "design", "ok", "2026-10-21")).toThrow(/wrong-kind-for-size/);
});

test("big design approval needs an approved spec first", () => {
  initFeature(repo, "x", "big", "2026-10-21");
  writeDoc("x", "design.md", PASSING_DESIGN);
  expect(() => approve(repo, "x", "design", "ok", "2026-10-21")).toThrow(/spec-not-approved/);
});

test("big design approval passes once the spec is approved", () => {
  initFeature(repo, "x", "big", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  writeDoc("x", "design.md", PASSING_DESIGN);
  approve(repo, "x", "spec", "spec ok", "2026-10-21");
  const rec = approve(repo, "x", "design", "design ok", "2026-10-22");
  expect(rec.approvals).toEqual({
    spec: { at: "2026-10-21", by: "user", quote: "spec ok", sha256: PASSING_SHA },
    design: { at: "2026-10-22", by: "user", quote: "design ok", sha256: DESIGN_SHA },
  });
});

test("big design approval refuses with spec-changed when the spec changed since its approval, and records nothing", () => {
  initFeature(repo, "x", "big", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  writeDoc("x", "design.md", PASSING_DESIGN);
  approve(repo, "x", "spec", "spec ok", "2026-10-21");
  writeDoc("x", "spec.md", `${PASSING_SPEC}\n## Notes\nadded after approval\n`);
  expect(() => approve(repo, "x", "design", "design ok", "2026-10-22")).toThrow(/spec-changed/);
  expect(readFeature(repo, "x").approvals).toEqual({ spec: { at: "2026-10-21", by: "user", quote: "spec ok", sha256: PASSING_SHA } });
});

test("big design approval refuses with spec-changed when the approved spec was deleted", () => {
  initFeature(repo, "x", "big", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  writeDoc("x", "design.md", PASSING_DESIGN);
  approve(repo, "x", "spec", "spec ok", "2026-10-21");
  rmSync(join(repo, readFeature(repo, "x").dir, "spec.md"));
  expect(() => approve(repo, "x", "design", "design ok", "2026-10-22")).toThrow(/spec-changed: .*spec\.md/);
  expect(readFeature(repo, "x").approvals.design).toBeUndefined();
});

test("isApprovalCurrent compares the recorded sha256 with the document on disk", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  const rec = approve(repo, "x", "spec", "ok", "2026-10-21");
  expect(isApprovalCurrent(repo, rec, "spec")).toBe(true);
  writeDoc("x", "spec.md", PASSING_SPEC.replace("\n", "\r\n"));
  expect(isApprovalCurrent(repo, rec, "spec")).toBe(false);
  rmSync(join(repo, rec.dir, "spec.md"));
  expect(isApprovalCurrent(repo, rec, "spec")).toBe(false);
});

test("approve without the document is doc-missing", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  expect(() => approve(repo, "x", "spec", "ok", "2026-10-21")).toThrow(/doc-missing/);
});

const RECORDS = ".git/fbs/features";

function writeRecordFile(name: string, content: unknown): void {
  mkdirSync(join(repo, RECORDS), { recursive: true });
  writeFileSync(join(repo, RECORDS, name), typeof content === "string" ? content : JSON.stringify(content));
}

const VALID = { slug: "x", dir: "docs/features/2026-10-21-x", size: "mid", approvals: {}, pr: null };
const APPROVAL = { at: "2026-10-21", quote: "ok", sha256: "a".repeat(64) };
const LANDED = { pr: 7, repo: "acme/app", commit: "c".repeat(40), at: "2026-10-25" };
const BRANCH = { name: "fbs/x", parent: "main", base: "d".repeat(40) };
const AGENT_APPROVAL = { at: "2026-10-21", by: "agent", reason: "follows from the approved spec change", sha256: "a".repeat(64) };
const STAMP = { tree: "b".repeat(40), at: "2026-10-23", verdict: "pass", criteria: 3, evidence: "docs/features/2026-10-21-x/verdict.md" };

test.each([
  ["invalid JSON", "{not json"],
  ["an empty object", {}],
  ["an array", []],
  ["a slug that differs from the file name", { ...VALID, slug: "y" }],
  ["a traversal slug", { ...VALID, slug: "../y" }],
  ["an unknown size", { ...VALID, size: "huge" }],
  ["an absolute dir", { ...VALID, dir: "/etc" }],
  ["a dir with ..", { ...VALID, dir: "docs/../../outside" }],
  ["a dir that is ..", { ...VALID, dir: ".." }],
  ["a dir under .git", { ...VALID, dir: ".git/hooks" }],
  ["a dir under .GIT", { ...VALID, dir: ".GIT/hooks" }],
  ["a dir with a .git segment further down", { ...VALID, dir: "docs/.git/x" }],
  ["a dir ending in a .Git segment", { ...VALID, dir: "docs/.Git" }],
  ["a dir that is not normalised", { ...VALID, dir: "docs//x" }],
  ["an empty dir", { ...VALID, dir: "" }],
  ["a dir that is the repo root", { ...VALID, dir: "." }],
  ["a non-string dir", { ...VALID, dir: 1 }],
  ["approvals that are not an object", { ...VALID, approvals: [] }],
  ["an unknown approval kind", { ...VALID, approvals: { plan: APPROVAL } }],
  ["an approval with an invalid date", { ...VALID, approvals: { spec: { ...APPROVAL, at: "2026-02-30" } } }],
  ["an approval with a blank quote", { ...VALID, approvals: { spec: { ...APPROVAL, quote: "  " } } }],
  ["an approval with an extra field", { ...VALID, approvals: { spec: { ...APPROVAL, note: "x" } } }],
  ["an approval by someone unknown", { ...VALID, approvals: { spec: { ...APPROVAL, by: "x" } } }],
  ["a user approval without a quote", { ...VALID, approvals: { spec: { at: "2026-10-21", by: "user", sha256: "a".repeat(64) } } }],
  ["a user approval with a reason", { ...VALID, approvals: { spec: { ...APPROVAL, reason: "r" } } }],
  ["an agent approval without a reason", { ...VALID, approvals: { design: { at: "2026-10-21", by: "agent", sha256: "a".repeat(64) } } }],
  ["an agent approval with a blank reason", { ...VALID, approvals: { design: { ...AGENT_APPROVAL, reason: " " } } }],
  ["an agent approval with a non-string reason", { ...VALID, approvals: { design: { ...AGENT_APPROVAL, reason: 1 } } }],
  ["an agent approval with a quote", { ...VALID, approvals: { design: { ...AGENT_APPROVAL, quote: "ok" } } }],
  ["an approval without a sha256", { ...VALID, approvals: { spec: { at: "2026-10-21", by: "user", quote: "ok" } } }],
  ["an approval with a short sha256", { ...VALID, approvals: { spec: { ...APPROVAL, sha256: "a".repeat(63) } } }],
  ["an approval with a non-hex sha256", { ...VALID, approvals: { spec: { ...APPROVAL, sha256: "g".repeat(64) } } }],
  ["an approval with an uppercase sha256", { ...VALID, approvals: { spec: { ...APPROVAL, sha256: "A".repeat(64) } } }],
  ["a non-integer pr", { ...VALID, pr: 1.5 }],
  ["a string pr", { ...VALID, pr: "12" }],
  ["a missing pr", { slug: "x", dir: VALID.dir, size: "mid", approvals: {} }],
  ["an unknown field", { ...VALID, owner: "alex" }],
  ["a stamp that is not an object", { ...VALID, stamp: "ok" }],
  ["a null stamp", { ...VALID, stamp: null }],
  ["a stamp with an extra field", { ...VALID, stamp: { ...STAMP, by: "x" } }],
  ["a stamp without criteria", { ...VALID, stamp: { tree: STAMP.tree, at: STAMP.at, verdict: "pass", evidence: STAMP.evidence } }],
  ["a stamp with a short tree", { ...VALID, stamp: { ...STAMP, tree: "b".repeat(39) } }],
  ["a stamp with an uppercase tree", { ...VALID, stamp: { ...STAMP, tree: "B".repeat(40) } }],
  ["a stamp with an invalid date", { ...VALID, stamp: { ...STAMP, at: "2026-02-30" } }],
  ["a stamp with a failing verdict", { ...VALID, stamp: { ...STAMP, verdict: "fail" } }],
  ["a stamp with negative criteria", { ...VALID, stamp: { ...STAMP, criteria: -1 } }],
  ["a stamp with fractional criteria", { ...VALID, stamp: { ...STAMP, criteria: 1.5 } }],
  ["a stamp with evidence outside the repo", { ...VALID, stamp: { ...STAMP, evidence: "../verdict.md" } }],
  ["a stamp with evidence under .git", { ...VALID, stamp: { ...STAMP, evidence: ".git/verdict.md" } }],
  ["a stamp with a short verifiedTree", { ...VALID, stamp: { ...STAMP, verifiedTree: "b".repeat(39) } }],
  ["a stamp with an uppercase verifiedTree", { ...VALID, stamp: { ...STAMP, verifiedTree: "B".repeat(40) } }],
  ["a stamp with a null verifiedTree", { ...VALID, stamp: { ...STAMP, verifiedTree: null } }],
  ["a stamp with a verifiedTree but no tree", { ...VALID, stamp: { at: STAMP.at, verdict: "pass", criteria: 3, evidence: STAMP.evidence, verifiedTree: STAMP.tree } }],
  ["a landed that is not an object", { ...VALID, landed: "yes" }],
  ["a landed with an extra field", { ...VALID, landed: { ...LANDED, by: "alex" } }],
  ["a landed by someone other than outside", { ...VALID, landed: { ...LANDED, head: "d".repeat(40), by: "alex" } }],
  ["a landed with a bad repo", { ...VALID, landed: { ...LANDED, repo: "nope" } }],
  ["a landed with a short commit", { ...VALID, landed: { ...LANDED, commit: "c".repeat(39) } }],
  ["a landed with a string pr", { ...VALID, landed: { ...LANDED, pr: "7" } }],
  ["a landed with an invalid date", { ...VALID, landed: { ...LANDED, at: "2026-02-30" } }],
  ["a branch that is not an object", { ...VALID, branch: "fbs/x" }],
  ["a branch with an extra field", { ...VALID, branch: { ...BRANCH, at: "2026-10-21" } }],
  ["a branch without a base", { ...VALID, branch: { name: "fbs/x", parent: "main" } }],
  ["a branch with an invalid name", { ...VALID, branch: { ...BRANCH, name: "fbs/../x" } }],
  ["a branch with a name that starts with a dash", { ...VALID, branch: { ...BRANCH, name: "-x" } }],
  ["a branch with an invalid parent", { ...VALID, branch: { ...BRANCH, parent: "a b" } }],
  ["a branch with a short base", { ...VALID, branch: { ...BRANCH, base: "d".repeat(39) } }],
  ["a branch with HEAD as its name", { ...VALID, branch: { ...BRANCH, name: "HEAD" } }],
  ["a branch with a short pushed commit", { ...VALID, branch: { ...BRANCH, pushed: "e".repeat(39) } }],
  ["a branch with an uppercase pushed commit", { ...VALID, branch: { ...BRANCH, pushed: "E".repeat(40) } }],
  ["a branch with a null pushed commit", { ...VALID, branch: { ...BRANCH, pushed: null } }],
  ["a branch with a previous name but nothing pushed", { ...VALID, branch: { ...BRANCH, previous: "feature/x" } }],
  ["a branch with an invalid previous name", { ...VALID, branch: { ...BRANCH, pushed: "e".repeat(40), previous: "a b" } }],
  ["a ticket that is not an object", { ...VALID, ticket: "ACM-1" }],
  ["a ticket without an id", { ...VALID, ticket: { url: "https://linear.app/x/issue/ACM-1" } }],
  ["a ticket with an extra field", { ...VALID, ticket: { id: "ACM-1", title: "x" } }],
  ["a ticket with a bad id", { ...VALID, ticket: { id: "ACM 1" } }],
  ["a ticket with an http url", { ...VALID, ticket: { id: "ACM-1", url: "http://linear.app/x" } }],
  ["a ticket with a url that isn't one", { ...VALID, ticket: { id: "ACM-1", url: "linear.app/x" } }],
  ["a unitOf without a unit", { ...VALID, unitOf: "f" }],
  ["a unit without a unitOf", { ...VALID, unit: 1 }],
  ["a unit of 0", { ...VALID, unitOf: "f", unit: 0 }],
  ["a fractional unit", { ...VALID, unitOf: "f", unit: 1.5 }],
  ["a string unit", { ...VALID, unitOf: "f", unit: "1" }],
  ["a unitOf that isn't a slug", { ...VALID, unitOf: "../f", unit: 1 }],
  ["a unit of itself", { ...VALID, unitOf: "x", unit: 1 }],
])("readFeature rejects a record with %s", (_, content) => {
  writeRecordFile("x.json", content);
  expect(() => readFeature(repo, "x")).toThrow(RecordError);
});

test.each([[{ id: "ACM-123" }], [{ id: "#42", url: "https://github.com/acme/app/issues/42" }], [{ id: "7" }]])("readFeature reads the ticket %j", (ticket) => {
  writeRecordFile("x.json", { ...VALID, ticket });
  expect(readFeature(repo, "x").ticket).toEqual(ticket);
});

test("setTicket records the ticket and its url, and clearTicket removes it", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  expect(setTicket(repo, "x", "ACM-123").ticket).toEqual({ id: "ACM-123" });
  const url = "https://linear.app/acme/issue/ACM-124/booking";
  expect(setTicket(repo, "x", "ACM-124", url).ticket).toEqual({ id: "ACM-124", url });
  expect(readFeature(repo, "x").ticket).toEqual({ id: "ACM-124", url });
  expect("ticket" in clearTicket(repo, "x")).toBe(false);
  expect(readFeature(repo, "x").ticket).toBeUndefined();
});

test.each([
  ["ACM", undefined],
  ["gro_1", undefined],
  ["1-2", undefined],
  ["ACM-1", "http://linear.app/x"],
  ["ACM-1", "not a url"],
])("setTicket refuses %p with url %p and records nothing", (id, url) => {
  initFeature(repo, "x", "mid", "2026-10-21");
  expect(() => setTicket(repo, "x", id, url)).toThrow(/bad-ticket/);
  expect(readFeature(repo, "x").ticket).toBeUndefined();
});

test("readFeature accepts a valid record with approvals, a pr and its repo", () => {
  const rec = { ...VALID, size: "big", approvals: { spec: { ...APPROVAL, by: "user" }, design: AGENT_APPROVAL }, pr: 12, repo: "acme/app" };
  writeRecordFile("x.json", rec);
  expect(readFeature(repo, "x")).toEqual(rec as FeatureRecord);
});

test("readFeature reads a landed record, which keeps it after the PR link is cleared", () => {
  writeRecordFile("x.json", { ...VALID, landed: LANDED });
  expect(readFeature(repo, "x")).toEqual({ ...VALID, landed: LANDED } as FeatureRecord);
});

test("readFeature reads a recorded branch, an adopted one without a parent, and the commit fbs last pushed", () => {
  writeRecordFile("x.json", { ...VALID, branch: BRANCH });
  expect(readFeature(repo, "x").branch).toEqual(BRANCH);
  const adopted = { name: "main", parent: null, base: BRANCH.base };
  writeRecordFile("x.json", { ...VALID, branch: adopted });
  expect(readFeature(repo, "x").branch).toEqual(adopted);
  const pushed = { ...BRANCH, pushed: "e".repeat(40) };
  writeRecordFile("x.json", { ...VALID, branch: pushed });
  expect(readFeature(repo, "x").branch).toEqual(pushed);
});

test("readFeature reads an approval without by as the user's", () => {
  writeRecordFile("x.json", { ...VALID, approvals: { spec: APPROVAL } });
  expect(readFeature(repo, "x").approvals.spec).toEqual({ ...APPROVAL, by: "user" });
});

test.each([
  ["a sha1", "b".repeat(40)],
  ["a sha256", "c".repeat(64)],
])("readFeature accepts a stamp with %s tree", (_, tree) => {
  const rec = { ...VALID, stamp: { ...STAMP, tree } };
  writeRecordFile("x.json", rec);
  expect(readFeature(repo, "x")).toEqual(rec as FeatureRecord);
});

test.each([
  ["a verified tree", { verifiedTree: "c".repeat(40) }],
  ["a sha256 verified tree", { verifiedTree: "c".repeat(64) }],
  ["a verified tree and a local verdict's sha256", { verifiedTree: "c".repeat(40), verdictSha256: "d".repeat(64) }],
])("readFeature keeps a stamp with %s", (_, extra) => {
  const rec = { ...VALID, stamp: { ...STAMP, ...extra } };
  writeRecordFile("x.json", rec);
  expect(readFeature(repo, "x")).toEqual(rec as FeatureRecord);
});

test("readFeature accepts a dir under .github", () => {
  writeRecordFile("x.json", { ...VALID, dir: ".github/features/x" });
  expect(readFeature(repo, "x").dir).toBe(".github/features/x");
});

test("approve with a tampered slug writes nothing", () => {
  const rec = initFeature(repo, "x", "mid", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  writeRecordFile("x.json", { ...rec, slug: "y" });
  expect(() => approve(repo, "x", "spec", "ok", "2026-10-21")).toThrow(RecordError);
  expect(readdirSync(join(repo, RECORDS))).toEqual(["x.json"]);
});

test("listFeatures skips a badly named file with a warning and lists the rest", () => {
  initFeature(repo, "a", "mid", "2026-10-21");
  writeRecordFile("Bad.json", "{not json");
  const warnings: string[] = [];
  expect(listFeatures(repo, (msg) => warnings.push(msg)).map((r) => r.slug)).toEqual(["a"]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("Bad.json");
});

test("listFeatures throws on a validly named corrupt record", () => {
  initFeature(repo, "a", "mid", "2026-10-21");
  writeRecordFile("b.json", "{}");
  expect(() => listFeatures(repo, () => {})).toThrow(RecordError);
});

test("listFeatures ignores lock and temp files", () => {
  initFeature(repo, "a", "mid", "2026-10-21");
  writeRecordFile("a.lock", "");
  writeRecordFile("a.json.1234.tmp", "{}");
  expect(listFeatures(repo, () => {}).map((r) => r.slug)).toEqual(["a"]);
});

test("init leaves no feature dir when the record cannot be written", () => {
  const records = join(repo, RECORDS);
  mkdirSync(records, { recursive: true });
  chmodSync(records, 0o555);
  try {
    expect(() => initFeature(repo, "x", "mid", "2026-10-21")).toThrow();
    expect(existsSync(join(repo, "docs"))).toBe(false);
  } finally {
    chmodSync(records, 0o755);
  }
  expect(readdirSync(records)).toEqual([]);
});

test("init removes the reserved record when the feature dir cannot be created", () => {
  writeFileSync(join(repo, "docs"), "not a directory");
  expect(() => initFeature(repo, "x", "mid", "2026-10-21")).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  expect(readdirSync(join(repo, RECORDS))).toEqual([]);
});

test("init refuses when the feature dir already exists and writes no record", () => {
  mkdirSync(join(repo, "docs/features/2026-10-21-x"), { recursive: true });
  expect(() => initFeature(repo, "x", "mid", "2026-10-21")).toThrow(/exists/);
  expect(existsSync(join(repo, RECORDS, "x.json"))).toBe(false);
});

test("re-approving the spec of a big feature clears the design approval", () => {
  initFeature(repo, "x", "big", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  writeDoc("x", "design.md", PASSING_DESIGN);
  approve(repo, "x", "spec", "spec ok", "2026-10-21");
  approve(repo, "x", "design", "design ok", "2026-10-22");
  const rec = approve(repo, "x", "spec", "spec v2", "2026-10-23");
  expect(rec.approvals).toEqual({ spec: { at: "2026-10-23", by: "user", quote: "spec v2", sha256: PASSING_SHA } });
  expect(readFeature(repo, "x").approvals).toEqual({ spec: { at: "2026-10-23", by: "user", quote: "spec v2", sha256: PASSING_SHA } });
});

test("approve refuses while another approve holds the lock, and leaves the record alone", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  writeRecordFile("x.lock", "");
  expect(() => approve(repo, "x", "spec", "ok", "2026-10-21")).toThrow(/locked/);
  expect(readFeature(repo, "x").approvals).toEqual({});
});

test("approve releases its lock, on success and on refusal", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  writeDoc("x", "spec.md", "## Assumptions\n- [ ] A\n## Open questions\nNone\n");
  expect(() => approve(repo, "x", "spec", "ok", "2026-10-21")).toThrow(GateRefusedError);
  writeDoc("x", "spec.md", PASSING_SPEC);
  approve(repo, "x", "spec", "ok", "2026-10-21");
  expect(readdirSync(join(repo, RECORDS))).toEqual(["x.json"]);
});

test.each(["2026-02-30", "", "21-10-2026"])("the library rejects today %p", (today) => {
  expect(() => initFeature(repo, "x", "mid", today)).toThrow(/bad-date/);
  expect(existsSync(join(repo, "docs"))).toBe(false);
  initFeature(repo, "y", "mid", "2026-10-21");
  writeDoc("y", "spec.md", PASSING_SPEC);
  expect(() => approve(repo, "y", "spec", "ok", today)).toThrow(/bad-date/);
  expect(readFeature(repo, "y").approvals).toEqual({});
});

test.each(["", "   ", "\n\t"])("approve rejects the blank quote %p", (quote) => {
  initFeature(repo, "x", "mid", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  expect(() => approve(repo, "x", "spec", quote, "2026-10-21")).toThrow(/bad-quote/);
  expect(readFeature(repo, "x").approvals).toEqual({});
});

test("git fixtures run without inherited GIT_* vars or global git config", () => {
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(tempDir(), "not-a-repo");
  try {
    const env = isolatedGitEnv({ GIT_CEILING_DIRECTORIES: "/x" });
    expect(Object.keys(env).filter((key) => key.startsWith("GIT_")).sort()).toEqual(["GIT_CEILING_DIRECTORIES", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]);
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    const dir = tempDir();
    git(dir, "init", "-q");
    expect(existsSync(join(dir, ".git"))).toBe(true);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

/** A big feature x with passing spec and design documents and an approved spec. */
function specApprovedBig(): void {
  initFeature(repo, "x", "big", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  writeDoc("x", "design.md", PASSING_DESIGN);
  approve(repo, "x", "spec", "spec ok", "2026-10-21");
}

test("approveAsAgent records the design approval as the agent's, with its reason", () => {
  specApprovedBig();
  const design: Approval = { at: "2026-10-22", by: "agent", reason: "simple amendment", sha256: DESIGN_SHA };
  expect(approveAsAgent(repo, "x", "design", "simple amendment", "2026-10-22").approvals.design).toEqual(design);
  expect(readFeature(repo, "x").approvals.design).toEqual(design);
});

test("approveAsAgent refuses the spec, and records nothing", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  expect(() => approveAsAgent(repo, "x", "spec", "simple", "2026-10-21")).toThrow(ApprovalRefusedError);
  expect(() => approveAsAgent(repo, "x", "spec", "simple", "2026-10-21")).toThrow("refused: the spec needs the user's approval");
  expect(readFeature(repo, "x").approvals).toEqual({});
});

test("approveAsAgent needs a current spec approval, like the user's", () => {
  initFeature(repo, "x", "big", "2026-10-21");
  writeDoc("x", "spec.md", PASSING_SPEC);
  writeDoc("x", "design.md", PASSING_DESIGN);
  expect(() => approveAsAgent(repo, "x", "design", "simple", "2026-10-22")).toThrow(/spec-not-approved/);
  approve(repo, "x", "spec", "spec ok", "2026-10-21");
  writeDoc("x", "spec.md", `${PASSING_SPEC}edited\n`);
  expect(() => approveAsAgent(repo, "x", "design", "simple", "2026-10-22")).toThrow(/spec-changed/);
  expect(readFeature(repo, "x").approvals.design).toBeUndefined();
});

test("approveAsAgent runs the gate on the design", () => {
  specApprovedBig();
  writeDoc("x", "design.md", "## Assumptions\n- [ ] A\n## Open questions\nNone\n");
  expect(() => approveAsAgent(repo, "x", "design", "simple", "2026-10-22")).toThrow(GateRefusedError);
  expect(readFeature(repo, "x").approvals.design).toBeUndefined();
});

test("approveAsAgent refuses a design on a feature that isn't big", () => {
  initFeature(repo, "x", "mid", "2026-10-21");
  writeDoc("x", "design.md", PASSING_DESIGN);
  expect(() => approveAsAgent(repo, "x", "design", "simple", "2026-10-21")).toThrow(/wrong-kind-for-size/);
});

test.each(["", "   ", "\n\t"])("approveAsAgent rejects the blank reason %p", (reason) => {
  specApprovedBig();
  expect(() => approveAsAgent(repo, "x", "design", reason, "2026-10-22")).toThrow(/bad-reason/);
  expect(readFeature(repo, "x").approvals.design).toBeUndefined();
});

test("re-approving the spec drops an agent design approval", () => {
  specApprovedBig();
  approveAsAgent(repo, "x", "design", "simple", "2026-10-22");
  expect(approve(repo, "x", "spec", "spec v2", "2026-10-23").approvals).toEqual({ spec: { at: "2026-10-23", by: "user", quote: "spec v2", sha256: PASSING_SHA } });
});

const UNITS_DESIGN = `${PASSING_SPEC}## Work units\n### U1: Api\n- Covers: none\n- Depends on: none\n### U2: Ui\n- Covers: none\n- Depends on: U1\n### U3: Extra\n- Covers: none\n- Depends on: U2\n`;

/** A big feature f with its spec and a three-unit design approved. */
function designApprovedFeature(): FeatureRecord {
  initFeature(repo, "f", "big", "2026-10-21");
  writeDoc("f", "spec.md", PASSING_SPEC);
  writeDoc("f", "design.md", UNITS_DESIGN);
  approve(repo, "f", "spec", "spec ok", "2026-10-21");
  return approve(repo, "f", "design", "design ok", "2026-10-21");
}

test("initUnit records a unit numbered next in its feature's stack, with its dir under the feature's", () => {
  const feature = designApprovedFeature();
  const first = initUnit(repo, "f-api", "f");
  expect(first).toEqual({ slug: "f-api", dir: `${feature.dir}/units/f-api`, size: "big", approvals: {}, pr: null, unitOf: "f", unit: 1 });
  expect(existsSync(join(repo, first.dir))).toBe(true);
  expect(readFeature(repo, "f-api")).toEqual(first);
  expect(initUnit(repo, "f-later", "f", 3).unit).toBe(3);
  expect(initUnit(repo, "f-ui", "f", 2).unit).toBe(2);
  expect(featureUnits(repo, "f").map((unit) => [unit.slug, unit.unit])).toEqual([["f-api", 1], ["f-ui", 2], ["f-later", 3]]);
  expect(readdirSync(join(repo, RECORDS)).sort()).toEqual(["f-api.json", "f-later.json", "f-ui.json", "f.json"]);
});

test("initUnit refuses a number the design's Work units don't list, given or next, and records nothing", () => {
  const feature = designApprovedFeature();
  const refused = `bad-unit: ${feature.dir}/design.md lists no U4 under Work units; amend the design to add it first`;
  expect(() => initUnit(repo, "f-four", "f", 4)).toThrow(refused);
  for (const slug of ["f-api", "f-ui", "f-extra"]) initUnit(repo, slug, "f");
  expect(() => initUnit(repo, "f-four", "f")).toThrow(refused);
  expect(existsSync(join(repo, RECORDS, "f-four.json"))).toBe(false);

  initFeature(repo, "g", "big", "2026-10-21");
  writeDoc("g", "spec.md", PASSING_SPEC);
  writeDoc("g", "design.md", PASSING_DESIGN);
  approve(repo, "g", "spec", "spec ok", "2026-10-21");
  approve(repo, "g", "design", "design ok", "2026-10-21");
  expect(() => initUnit(repo, "g-one", "g")).toThrow(/bad-unit: .*lists no U1 under Work units/);
});

test("initUnit refuses a number another unit has, and records nothing", () => {
  designApprovedFeature();
  initUnit(repo, "f-api", "f");
  expect(() => initUnit(repo, "f-ui", "f", 1)).toThrow(/unit-taken: unit 1 of f is f-api/);
  expect(existsSync(join(repo, RECORDS, "f-ui.json"))).toBe(false);
});

test("initUnit refuses a missing feature, a feature that isn't big, and a unit of a unit", () => {
  expect(() => initUnit(repo, "u", "nope")).toThrow(/missing/);
  initFeature(repo, "m", "mid", "2026-10-21");
  expect(() => initUnit(repo, "u", "m")).toThrow(/not-big/);
  designApprovedFeature();
  initUnit(repo, "f-api", "f");
  expect(() => initUnit(repo, "u", "f-api")).toThrow(/is-unit/);
  expect(existsSync(join(repo, RECORDS, "u.json"))).toBe(false);
});

test("initUnit refuses until the feature's design approval is current", () => {
  initFeature(repo, "f", "big", "2026-10-21");
  writeDoc("f", "spec.md", PASSING_SPEC);
  writeDoc("f", "design.md", UNITS_DESIGN);
  approve(repo, "f", "spec", "spec ok", "2026-10-21");
  expect(() => initUnit(repo, "u", "f")).toThrow(/design-not-approved: approve the design/);
  approve(repo, "f", "design", "design ok", "2026-10-21");
  writeDoc("f", "design.md", `${UNITS_DESIGN}edited\n`);
  expect(() => initUnit(repo, "u", "f")).toThrow(/design-not-approved: .*design\.md changed/);
  expect(existsSync(join(repo, RECORDS, "u.json"))).toBe(false);
  expect(readdirSync(join(repo, RECORDS)).sort()).toEqual(["f.json"]);
});

test("a unit's documents and approvals are its feature's, so a change to the feature's design stales them", () => {
  const feature = designApprovedFeature();
  const unit = initUnit(repo, "f-api", "f");
  expect(documentsRecord(repo, unit)).toEqual(feature);
  expect(documentsRecord(repo, feature)).toEqual(feature);
  expect(docPath(repo, unit, "spec")).toBe(`${feature.dir}/spec.md`);
  expect(docPath(repo, unit, "design")).toBe(`${feature.dir}/design.md`);
  expect(isApprovalCurrent(repo, unit, "spec")).toBe(true);
  expect(isApprovalCurrent(repo, unit, "design")).toBe(true);
  writeDoc("f", "design.md", `${UNITS_DESIGN}edited\n`);
  expect(isApprovalCurrent(repo, unit, "design")).toBe(false);
  expect(isApprovalCurrent(repo, unit, "spec")).toBe(true);
});

test("approve and the gate refuse a unit and point at its feature", () => {
  designApprovedFeature();
  initUnit(repo, "f-api", "f");
  expect(() => approve(repo, "f-api", "spec", "ok", "2026-10-22")).toThrow(/is-unit: f-api is unit 1 of f .*run this on f/);
  expect(() => approveAsAgent(repo, "f-api", "design", "simple", "2026-10-22")).toThrow(/is-unit/);
  expect(() => checkGate(repo, "f-api", "design")).toThrow(/is-unit/);
  expect(readFeature(repo, "f-api").approvals).toEqual({});
});

test("unitBelow and unitAbove find a unit's neighbours in the stack", () => {
  designApprovedFeature();
  const api = initUnit(repo, "f-api", "f");
  const ui = initUnit(repo, "f-ui", "f");
  expect(unitBelow(repo, api)).toBeNull();
  expect(unitBelow(repo, ui)).toEqual(api);
  expect(unitAbove(repo, api)).toEqual(ui);
  expect(unitAbove(repo, ui)).toBeNull();
});

test("plannedUnit reads the unit's entry from the feature's design, or null without one", () => {
  designApprovedFeature();
  const api = initUnit(repo, "f-api", "f");
  initUnit(repo, "f-ui", "f");
  const extra = initUnit(repo, "f-extra", "f");
  expect(plannedUnit(repo, api)).toEqual({ number: 1, name: "Api", covers: [], dependsOn: [] });
  expect(plannedUnit(repo, extra)).toMatchObject({ number: 3, name: "Extra" });
  writeDoc("f", "design.md", UNITS_DESIGN.slice(0, UNITS_DESIGN.indexOf("### U3")));
  expect(plannedUnit(repo, extra)).toBeNull();
  rmSync(join(repo, readFeature(repo, "f").dir, "design.md"));
  expect(plannedUnit(repo, api)).toBeNull();
});
