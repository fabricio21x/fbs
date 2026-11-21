import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { run } from "./main";
import { moveFeature } from "./move";
import { approve, type FeatureRecord, initFeature, initUnit, isApprovalCurrent, readFeature, setTicket, StatusError, updateFeature } from "./status";
import { isolatedGitEnv } from "./test-env";

const SPEC = "## Facts\n- Two beta clients (.fbs/context.md)\n## Assumptions\nNone\n## Open questions\nNone\n";
const DESIGN = `${SPEC}## Work units\n### U1: Api\n- Covers: none\n- Depends on: none\n### U2: Ui\n- Covers: none\n- Depends on: none\n`;
const DIR = "docs/features/2026-10-21-f";

let dirs: string[] = [];
let source: string;
let target: string;

function git(cwd: string, ...args: string[]): void {
  const identity = ["-c", "user.name=fbs", "-c", "user.email=fbs@example.com", "-c", "commit.gpgsign=false"];
  const result = Bun.spawnSync(["git", ...identity, ...args], { cwd, env: isolatedGitEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fbs-move-")));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

beforeEach(() => {
  source = repo();
  target = repo();
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Big feature f in the source repo with its spec and design approved, a ticket, and units f-api and f-ui, each with a plan. */
function feature(): void {
  initFeature(source, "f", "big", "2026-10-21");
  writeFileSync(join(source, DIR, "spec.md"), SPEC);
  writeFileSync(join(source, DIR, "design.md"), DESIGN);
  approve(source, "f", "spec", "spec ok", "2026-10-21");
  approve(source, "f", "design", "design ok", "2026-10-21");
  setTicket(source, "f", "ACM-123");
  for (const slug of ["f-api", "f-ui"]) {
    initUnit(source, slug, "f");
    writeFileSync(join(source, DIR, "units", slug, "plan.md"), `# ${slug}\n`);
  }
}

const BRANCH = { name: "feature/f-api", parent: "main", base: "d".repeat(40) };
const STAMP = { tree: "b".repeat(40), at: "2026-10-23", verdict: "pass" as const, criteria: 1, evidence: `${DIR}/units/f-api/verdict.md` };
const LANDED = { pr: 7, repo: "acme/app", commit: "c".repeat(40), at: "2026-10-25" };

function refusal(body: () => unknown): string {
  try {
    body();
  } catch (e) {
    if (e instanceof StatusError) return e.message;
    throw e;
  }
  throw new Error("moveFeature did not refuse");
}

const targetRecords = () => (existsSync(join(target, ".git/fbs/features")) ? Bun.spawnSync(["ls", join(target, ".git/fbs/features")]).stdout.toString().trim() : "");

test("moves the feature and its units into the target repo without what belongs to the old one, and keeps the source", () => {
  feature();
  updateFeature(source, "f-api", (rec) => ({ ...rec, branch: BRANCH, stamp: STAMP }));
  updateFeature(source, "f-ui", (rec) => ({ ...rec, independent: true, branch: { ...BRANCH, name: "feature/f-ui" } }));
  const before = ["f", "f-api", "f-ui"].map((slug) => readFeature(source, slug));

  expect(moveFeature(source, "f", target, false)).toEqual({ slug: "f", to: target, dir: DIR, docs: "tracked", docsRoot: join(target, DIR), units: ["f-api", "f-ui"], sourceRemoved: false, deletionToCommit: null });
  const moved = readFeature(target, "f");
  expect(moved).toEqual({ ...before[0], ticket: { id: "ACM-123" } } as FeatureRecord);
  expect(isApprovalCurrent(target, moved, "design")).toBe(true);
  for (const slug of ["f-api", "f-ui"]) {
    expect(readFeature(target, slug)).toEqual({ slug, dir: `${DIR}/units/${slug}`, size: "big", approvals: {}, pr: null, unitOf: "f", unit: slug === "f-api" ? 1 : 2 });
    expect(readFileSync(join(target, DIR, "units", slug, "plan.md"), "utf8")).toBe(`# ${slug}\n`);
  }
  expect(readFileSync(join(target, DIR, "design.md"), "utf8")).toBe(DESIGN);
  expect(["f", "f-api", "f-ui"].map((slug) => readFeature(source, slug))).toEqual(before);
  expect(existsSync(join(source, DIR, "design.md"))).toBe(true);
});

test("the documents go to the target's features dir, local when the target's git ignores it", () => {
  feature();
  mkdirSync(join(target, ".fbs"));
  writeFileSync(join(target, ".fbs", "config.json"), '{"featuresDir":"specs"}');
  writeFileSync(join(target, ".gitignore"), "specs/\n");
  expect(moveFeature(source, "f", target, false)).toMatchObject({ dir: "specs/2026-10-21-f", docs: "local", docsRoot: join(target, "specs/2026-10-21-f") });
  expect(readFeature(target, "f-ui").dir).toBe("specs/2026-10-21-f/units/f-ui");
  expect(readFileSync(join(target, "specs/2026-10-21-f/spec.md"), "utf8")).toBe(SPEC);
});

test("--remove-source removes the records and the documents from the source repo, naming tracked documents' deletion to commit", () => {
  feature();
  expect(moveFeature(source, "f", target, true)).toMatchObject({ sourceRemoved: true, deletionToCommit: DIR });
  for (const slug of ["f", "f-api", "f-ui"]) expect(existsSync(join(source, ".git/fbs/features", `${slug}.json`))).toBe(false);
  expect(existsSync(join(source, DIR))).toBe(false);
  expect(readFeature(target, "f").approvals.design).toBeDefined();
});

test("refuses a unit, an open PR, a slug the target has, the same repo and a path that isn't a repo, and writes nothing", () => {
  feature();
  expect(refusal(() => moveFeature(source, "f-api", target, false))).toBe("is-unit: f-api is unit 1 of f; move f, which takes its units along");
  updateFeature(source, "f-ui", (rec) => ({ ...rec, pr: 12, repo: "acme/app" }));
  expect(refusal(() => moveFeature(source, "f", target, false))).toBe("open-pr: f-ui has PR #12 open in this repo; land it first, or clear it with fbs status pr f-ui none if it was closed");
  updateFeature(source, "f-ui", ({ repo: _, ...rec }) => ({ ...rec, pr: null }));
  expect(refusal(() => moveFeature(source, "f", source, false))).toBe(`bad-target: ${source} is this repo`);
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "fbs-move-plain-")));
  dirs.push(plain);
  expect(refusal(() => moveFeature(source, "f", plain, false))).toBe(`bad-target: ${plain} is not a git repository`);
  initFeature(target, "f-api", "mid", "2026-10-21");
  expect(refusal(() => moveFeature(source, "f", target, false))).toBe(`exists: f-api already has a record in ${target}`);
  expect(targetRecords()).toBe("f-api.json");
  expect(existsSync(join(target, DIR))).toBe(false);
  expect(existsSync(join(source, ".git/fbs/features/f.json"))).toBe(true);
});

test("fbs status move takes a path relative to the checkout, prints the move, and refuses on stdout with exit 1", () => {
  feature();
  const out: string[] = [];
  const io = { cwd: source, today: "2026-10-25", out: (line: string) => out.push(line), err: (line: string) => out.push(`err ${line}`) };
  expect(run(["status", "move", "f"], io)).toBe(2);
  out.length = 0;
  expect(run(["status", "move", "f", "--to", "."], io)).toBe(1);
  expect(out).toEqual([`error: bad-target: ${source} is this repo`]);
  out.length = 0;
  expect(run(["status", "move", "f", "--to", relative(source, target), "--remove-source"], io)).toBe(0);
  expect(JSON.parse(out[0])).toMatchObject({ slug: "f", to: target, sourceRemoved: true });
});

test("refuses a feature with a landed unit, since moving it would rebuild merged work", () => {
  feature();
  updateFeature(source, "f-api", (rec) => ({ ...rec, pr: 7, repo: "acme/app", landed: LANDED }));
  expect(refusal(() => moveFeature(source, "f", target, true))).toBe("has-landed: f-api has landed in this repo; a feature that has partly shipped stays here, and what's left moves as a new feature");
  expect(targetRecords()).toBe("");
  expect(existsSync(join(source, ".git/fbs/features/f.json"))).toBe(true);
});

test("refuses when an approved document isn't in this checkout, so --remove-source never loses it", () => {
  feature();
  rmSync(join(source, DIR, "design.md"));
  expect(refusal(() => moveFeature(source, "f", target, true))).toBe(`doc-missing: ${DIR}/design.md isn't in this checkout; run this where the feature's documents are, such as its branch`);
  expect(targetRecords()).toBe("");
  expect(existsSync(join(source, ".git/fbs/features/f.json"))).toBe(true);
});

test("relative symlinks among the documents stay relative", () => {
  feature();
  symlinkSync("../../spec.md", join(source, DIR, "units", "f-api", "spec-link.md"));
  moveFeature(source, "f", target, false);
  expect(readlinkSync(join(target, DIR, "units", "f-api", "spec-link.md"))).toBe("../../spec.md");
});

test("a copy that fails partway leaves no record or document behind in the target", () => {
  feature();
  const unreadable = join(source, DIR, "units", "f-ui", "plan.md");
  chmodSync(unreadable, 0o000);
  try {
    expect(() => moveFeature(source, "f", target, true)).toThrow();
  } finally {
    chmodSync(unreadable, 0o644);
  }
  expect(targetRecords()).toBe("");
  expect(existsSync(join(target, DIR))).toBe(false);
  for (const slug of ["f", "f-api", "f-ui"]) expect(existsSync(join(source, ".git/fbs/features", `${slug}.json`))).toBe(true);
  expect(existsSync(join(source, DIR, "design.md"))).toBe(true);
});

test("documents local in the source become tracked in a target that doesn't ignore them, with no deletion to commit here", () => {
  writeFileSync(join(source, ".git/info/exclude"), "docs/features/\n");
  feature();
  expect(moveFeature(source, "f", target, true)).toMatchObject({ docs: "tracked", docsRoot: join(target, DIR), deletionToCommit: null });
  expect(readFileSync(join(target, DIR, "design.md"), "utf8")).toBe(DESIGN);
  expect(existsSync(join(source, DIR))).toBe(false);
});
