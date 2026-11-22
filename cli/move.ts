import { cpSync, existsSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import { projectConfig } from "./config";
import { gitCommonDir, NotAGitRepoError, repoRoot } from "./git";
import { createRecord, type DocKind, docPath, docsDir, docsMode, excludeLocalDocs, type FeatureRecord, featureUnits, isUnit, readFeature, recordPath, StatusError, withLock } from "./status";

/** What `fbs status move` did: where the feature's records and documents now live. */
export interface MovedFeature {
  slug: string;
  /** The target repo's root. */
  to: string;
  dir: string;
  docs: "local" | "tracked";
  docsRoot: string;
  units: string[];
  sourceRemoved: boolean;
  /** The source's tracked documents folder `--remove-source` deleted, a deletion left to commit; null when there is none. */
  deletionToCommit: string | null;
}

/**
 * Copy feature `slug` and its units' records into the repo at `target`, without what belongs to this repo (PR, branch,
 * stamp, rollout, independence), and its documents into the target's features dir, where the target's git decides
 * whether they are local or tracked. With `removeSource`, then remove the records and documents here. Refused once
 * any of it landed, since the target would rebuild merged work, and when an approved document isn't in this checkout.
 */
export function moveFeature(cwd: string, slug: string, target: string, removeSource: boolean): MovedFeature {
  const known = readFeature(cwd, slug);
  if (isUnit(known)) throw new StatusError("is-unit", `${slug} is unit ${known.unit} of ${known.unitOf}; move ${known.unitOf}, which takes its units along`);
  const to = targetRoot(cwd, target);
  return withLock(cwd, slug, () => {
    const feature = readFeature(cwd, slug);
    const units = featureUnits(cwd, slug);
    const all = [feature, ...units];
    const landed = all.find((rec) => rec.landed !== undefined);
    if (landed !== undefined) throw new StatusError("has-landed", `${landed.slug} has landed in this repo; a feature that has partly shipped stays here, and what's left moves as a new feature`);
    const open = all.find((rec) => rec.pr !== null && rec.landed === undefined);
    if (open !== undefined) throw new StatusError("open-pr", `${open.slug} has PR #${open.pr} open in this repo; land it first, or clear it with fbs status pr ${open.slug} none if it was closed`);
    const taken = all.find((rec) => existsSync(recordPath(to, rec.slug)));
    if (taken !== undefined) throw new StatusError("exists", `${taken.slug} already has a record in ${to}`);

    excludeLocalDocs(to);
    const dir = posix.join(projectConfig(to).featuresDir, posix.basename(feature.dir));
    const moved = all.map((rec) => withoutRepo(rec, rec === feature ? dir : posix.join(dir, posix.relative(feature.dir, rec.dir))));
    const source = docsDir(cwd, feature);
    for (const kind of Object.keys(feature.approvals) as DocKind[]) {
      if (!existsSync(join(source, `${kind}.md`))) throw new StatusError("doc-missing", `${docPath(cwd, feature, kind)} isn't in this checkout; run this where the feature's documents are, such as its branch`);
    }
    const deletionToCommit = removeSource && docsMode(cwd, feature) === "tracked" ? feature.dir : null;
    const created: FeatureRecord[] = [];
    try {
      for (const rec of moved) created.push(createRecord(to, rec));
      if (existsSync(source)) cpSync(source, docsDir(to, moved[0]), { recursive: true, verbatimSymlinks: true });
    } catch (e) {
      for (const rec of created) rmSync(recordPath(to, rec.slug), { force: true });
      if (created.length > 0) rmSync(docsDir(to, moved[0]), { recursive: true, force: true });
      throw e;
    }
    if (removeSource) {
      for (const rec of all) rmSync(recordPath(cwd, rec.slug), { force: true });
      rmSync(source, { recursive: true, force: true });
    }
    return { slug, to, dir, docs: docsMode(to, moved[0]), docsRoot: docsDir(to, moved[0]), units: units.map((unit) => unit.slug), sourceRemoved: removeSource, deletionToCommit };
  });
}

/** The root of the repo at `target`, refused when it isn't another git repo. */
function targetRoot(cwd: string, target: string): string {
  const notARepo = new StatusError("bad-target", `${target} is not a git repository`);
  if (!existsSync(target)) throw notARepo;
  let common: string;
  try {
    common = gitCommonDir(target);
  } catch (e) {
    if (e instanceof NotAGitRepoError) throw notARepo;
    throw e;
  }
  if (common === gitCommonDir(cwd)) throw new StatusError("bad-target", `${target} is this repo`);
  return repoRoot(target);
}

function withoutRepo(rec: FeatureRecord, dir: string): FeatureRecord {
  const { repo: _repo, branch: _branch, stamp: _stamp, rollout: _rollout, independent: _independent, ...kept } = rec;
  return { ...kept, dir, pr: null };
}
