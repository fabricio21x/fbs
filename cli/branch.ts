import {
  commitOf,
  commitsBetween,
  currentBranch,
  deleteOriginBranch,
  fetchOriginBranch,
  GitError,
  hasRemote,
  isAncestor,
  makeEmptyRootCommit,
  mergeBase,
  originDefaultBranch,
  pushBranch,
  rebaseOnto,
  renameBranch,
  switchBranch,
  uncommittedFiles,
} from "./git";
import { protectedBranches } from "./guard";
import { type FeatureBranch, type FeatureRecord, isBranchName, isUnit, listFeatures, readFeature, StatusError, type UnitRecord, unitBelow, updateFeature } from "./status";

/** A switch fbs won't make, such as one that would overwrite uncommitted changes. */
export class BranchRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`refused: ${reason}`);
    this.reason = reason;
  }
}

export interface BranchResult {
  branch: string;
  parent: string | null;
  base: string;
  created: boolean;
  switched: boolean;
  moved: boolean;
  renamed: boolean;
}

export interface PushResult {
  branch: string;
  pushed: string;
  forced: boolean;
  /** The name pushed before a rename; deleted is false when origin moved it since or the delete failed. */
  previous?: { name: string; deleted: boolean };
}

/**
 * `type` and `ticket` name a new branch, `<type>/<ticket>-<slug>` or `<type>/<slug>`; `type` is ignored once one is recorded and both with `use`;
 * a new branch takes the record's ticket when `ticket` is unset; a recorded branch fbs cut is renamed to carry an explicit `ticket`;
 * `parent` is where a new branch starts, or where a recorded one moves to; a unit's comes from its stack instead;
 * `existing` never creates a branch; `use` adopts a branch the user named instead.
 */
export interface BranchChoice {
  type?: string;
  ticket?: string;
  parent?: string;
  use?: string;
  existing?: boolean;
}

export const BRANCH_TYPES: readonly string[] = ["feature", "bugfix", "hotfix", "chore"];

const SEGMENT = "[a-z0-9]+(\\.[a-z0-9]+)*";
const CONVENTIONAL_BRANCH = new RegExp(`^(${BRANCH_TYPES.join("|")})/${SEGMENT}(-${SEGMENT})*$`);

/** `<type>/<description>` per conventionalbranch.org: lowercase letters and digits in hyphen-joined segments, dots only inside one. */
export function isConventionalBranchName(name: string): boolean {
  return CONVENTIONAL_BRANCH.test(name);
}

/** The name a new branch gets; the ticket is left out of the description when the slug already starts with it. */
function newBranchName(slug: string, { type, ticket }: BranchChoice): string {
  if (type === undefined) throw new BranchRefusedError(`a new branch needs --type <${BRANCH_TYPES.join("|")}>`);
  if (!BRANCH_TYPES.includes(type)) throw new BranchRefusedError(`unknown type ${JSON.stringify(type)}; --type is one of ${BRANCH_TYPES.join(", ")}`);
  const id = ticket === undefined ? undefined : ticketId(ticket);
  const description = id === undefined || slug === id || slug.startsWith(`${id}-`) ? slug : `${id}-${slug}`;
  const name = `${type}/${description}`;
  if (!isConventionalBranchName(name)) throw new BranchRefusedError(`${name} is not a conventional branch name`);
  return name;
}

/** A ticket id in lowercase, such as `acm-123`; a bare issue number, with or without `#`, is `issue-<n>`. */
function ticketId(ticket: string): string {
  const issue = /^#?([0-9]+)$/.exec(ticket);
  if (issue !== null) return `issue-${issue[1]}`;
  const id = ticket.toLowerCase();
  if (!/^[a-z][a-z0-9]*-[0-9]+$/.test(id)) throw new BranchRefusedError(`bad ticket ${JSON.stringify(ticket)}: use a tracker id like ACM-123 or an issue number`);
  return id;
}

/** How origin looked: no remote, fetched just now, or unreachable so the last fetched refs stand in. */
type Origin = "none" | "fetched" | "offline";

const STASH_HINT = "stash them or commit them where they are, then run this again";

/** Put the work tree on the feature's branch, creating it when needed, and record it. */
export function enterFeatureBranch(cwd: string, slug: string, choice: BranchChoice, note: (line: string) => void): BranchResult {
  for (const name of [choice.parent, choice.use]) {
    if (name !== undefined && !isBranchName(name)) throw new StatusError("bad-branch", `${JSON.stringify(name)} is not a valid branch name`);
  }
  const withTicket = (rec: FeatureRecord): BranchChoice => ({ ...choice, ticket: choice.ticket ?? rec.ticket?.id });
  const known = readFeature(cwd, slug);
  if (isUnit(known) && choice.parent !== undefined) throw new BranchRefusedError(`${slug} is unit ${known.unit} of ${known.unitOf}; its stack sets its parent, so --parent isn't used`);
  // Only a new branch takes the record's ticket; a recorded one is renamed only for an explicit --ticket.
  const naming = known.branch === undefined ? withTicket(known) : choice;
  // The fetch runs before the lock, so a slow or failing network never holds it.
  const origin = refreshOrigin(cwd, namesOnOrigin(cwd, known, naming), note);
  let result: BranchResult | undefined;
  updateFeature(cwd, slug, (rec) => {
    let step: Step;
    if (choice.use !== undefined) step = adopt(cwd, choice.use, rec.branch, isUnit(rec) ? rec : null, origin, note);
    else if (rec.branch !== undefined) {
      const newName = renameTarget(slug, rec.branch, choice.ticket);
      if (newName !== null) assertRenamable(cwd, slug, rec.branch, newName, rec.pr !== null, origin, note);
      step = resume(cwd, rec.branch, rec.pr !== null, choice.parent, origin, note);
      if (newName !== null) step = rename(cwd, step, newName, note);
    } else if (choice.existing) throw new BranchRefusedError(`no branch recorded for ${slug}`);
    else if (isUnit(rec)) step = createUnit(cwd, newBranchName(slug, withTicket(rec)), rec, origin, note);
    else step = create(cwd, newBranchName(slug, withTicket(rec)), choice.parent ?? defaultBranch(cwd), origin, note);
    result = step.result;
    return { ...rec, branch: step.branch };
  });
  return result as BranchResult;
}

type Step = { branch: FeatureBranch; result: BranchResult };

function step(branch: FeatureBranch, change: { created?: boolean; switched?: boolean; moved?: boolean; renamed?: boolean }): Step {
  const { created = false, switched = false, moved = false, renamed = false } = change;
  return { branch, result: { branch: branch.name, parent: branch.parent, base: branch.base, created, switched, moved, renamed } };
}

/** The conventional name of a recorded branch fbs cut, with the ticket; null when it already has it, or isn't fbs's or conventional. */
function renameTarget(slug: string, recorded: FeatureBranch, ticket: string | undefined): string | null {
  const type = recorded.name.split("/")[0];
  if (ticket === undefined || recorded.parent === null || !BRANCH_TYPES.includes(type)) return null;
  const name = newBranchName(slug, { type, ticket });
  return name === recorded.name ? null : name;
}

/** Refuse a rename that would strand a PR, commits on origin or a stacked feature, or take a name in use. */
function assertRenamable(cwd: string, slug: string, recorded: FeatureBranch, newName: string, prOpen: boolean, origin: Origin, note: (line: string) => void): void {
  const { name } = recorded;
  if (prOpen) throw new BranchRefusedError(`${name} has an open PR; it can't be renamed to ${newName}`);
  if (origin === "offline" && recorded.pushed !== undefined) throw new BranchRefusedError(`can't reach origin to check ${name} before renaming it`);
  const originTip = commitOf(cwd, `refs/remotes/origin/${name}`);
  if (originTip !== null && originTip !== recorded.pushed) throw new BranchRefusedError(`origin has commits fbs didn't push to ${name}; it can't be renamed`);
  if (isLocal(cwd, newName) || onOrigin(cwd, newName)) throw new BranchRefusedError(`${newName} already exists; ${name} can't be renamed to it`);
  const child = listFeatures(cwd, note).find((other) => other.slug !== slug && other.branch?.parent === name);
  if (child !== undefined) throw new BranchRefusedError(`${child.slug} is stacked on ${name}; rename it before it has children`);
}

/** Rename the local branch; origin keeps the old name until the next `fbs push` deletes it. */
function rename(cwd: string, resumed: Step, newName: string, note: (line: string) => void): Step {
  const { name, pushed, previous } = resumed.branch;
  renameBranch(cwd, name, newName);
  note(`note: renamed ${name} to ${newName}`);
  const onOriginAs = previous ?? (pushed !== undefined ? name : undefined);
  const branch = { ...resumed.branch, name: newName, ...(onOriginAs !== undefined && { previous: onOriginAs }) };
  const { created, switched, moved } = resumed.result;
  return step(branch, { created, switched, moved, renamed: true });
}

/** The branches whose origin copies this run reads. */
function namesOnOrigin(cwd: string, rec: FeatureRecord, choice: BranchChoice): string[] {
  const { slug, branch: recorded } = rec;
  if (choice.use !== undefined) {
    const below = isUnit(rec) ? stackedOn(cwd, rec) : null;
    return [choice.use, defaultBranch(cwd), ...(below !== null ? [below.name] : [])];
  }
  if (recorded !== undefined) {
    const newName = renameTarget(slug, recorded, choice.ticket);
    const parent = choice.parent !== undefined && choice.parent !== recorded.parent ? [choice.parent] : [];
    return [recorded.name, ...(newName !== null ? [newName] : []), ...parent];
  }
  if (choice.existing) return [];
  if (isUnit(rec)) return [newBranchName(slug, choice), stackedOn(cwd, rec)?.name ?? defaultBranch(cwd)];
  return [newBranchName(slug, choice), ...(choice.parent !== undefined ? [choice.parent] : defaultNames(cwd))];
}

/** The default branch; an unborn repo can't tell it before fetching, so main and master are fetched too. */
function defaultNames(cwd: string): string[] {
  const known = defaultBranch(cwd);
  if (commitOf(cwd, "HEAD") !== null || originDefaultBranch(cwd) !== null) return [known];
  return [...new Set(["main", "master", known])];
}

function refreshOrigin(cwd: string, names: string[], note: (line: string) => void): Origin {
  if (!hasRemote(cwd, "origin")) return "none";
  let origin: Origin = "fetched";
  for (const name of names) {
    if (origin === "fetched") {
      try {
        fetchOriginBranch(cwd, name);
        continue;
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        origin = "offline";
      }
    }
    if (onOrigin(cwd, name)) note(`note: could not reach origin; using the last fetched ${name}`);
  }
  return origin;
}

function create(cwd: string, name: string, parent: string, origin: Origin, note: (line: string) => void): Step {
  refuseUnrecorded(cwd, name);
  const start = startPoint(cwd, parent, origin, note);
  const base = commitOf(cwd, start) as string;
  switchTo(cwd, name, note, start);
  return step({ name, parent, base }, { created: true, switched: true });
}

/**
 * A unit's branch, cut from the tip of the branch below it in the stack. Unit 1 takes the feature branch's parent and
 * base, so the spec and design commits ship in its PR; unit k's parent is unit k-1's branch, and its base that tip.
 * Once the unit below has landed, such as for a follow-up unit on top, it starts from the default branch instead.
 */
function createUnit(cwd: string, name: string, unit: UnitRecord, origin: Origin, note: (line: string) => void): Step {
  const below = stackedOn(cwd, unit);
  if (below === null) return create(cwd, name, defaultBranch(cwd), origin, note);
  refuseUnrecorded(cwd, name);
  const start = tipOf(cwd, below);
  const branch = unit.unit === 1 ? { name, parent: below.parent ?? defaultBranch(cwd), base: below.base } : { name, parent: below.name, base: commitOf(cwd, start) as string };
  switchTo(cwd, name, note, start);
  return step(branch, { created: true, switched: true });
}

/** The ref of the branch below's tip, local else origin's. */
function tipOf(cwd: string, below: FeatureBranch): string {
  const ref = [`refs/heads/${below.name}`, `refs/remotes/origin/${below.name}`].find((ref) => commitOf(cwd, ref) !== null);
  if (ref === undefined) throw new BranchRefusedError(`branch ${below.name} is gone: not here and not on origin`);
  return ref;
}

/** The recorded branch a unit stacks on: its feature's for unit 1, else unit k-1's; null once that one has landed. */
function stackedOn(cwd: string, unit: UnitRecord): FeatureBranch | null {
  const below = unit.unit === 1 ? readFeature(cwd, unit.unitOf) : unitBelow(cwd, unit);
  if (below === null) throw new BranchRefusedError(`unit ${unit.unit - 1} of ${unit.unitOf} has no record; ${unit.slug} stacks on it`);
  if (below.landed !== undefined) return null;
  if (below.branch === undefined) throw new BranchRefusedError(`${below.slug} has no branch yet; ${unit.slug} stacks on it, so run fbs branch ${below.slug} first`);
  return below.branch;
}

function refuseUnrecorded(cwd: string, name: string): void {
  if (isLocal(cwd, name) || onOrigin(cwd, name)) throw new BranchRefusedError(`${name} exists but isn't recorded; pass --use ${name} to adopt it`);
}

function resume(cwd: string, recorded: FeatureBranch, prOpen: boolean, parent: string | undefined, origin: Origin, note: (line: string) => void): Step {
  const { name } = recorded;
  const local = isLocal(cwd, name);
  if (!local && !onOrigin(cwd, name)) {
    if (origin === "offline") throw new GitError(`cannot find ${name}: it isn't here and origin can't be reached`);
    throw new BranchRefusedError(`branch ${name} is gone: not here and not on origin`);
  }
  if (parent !== undefined && parent !== recorded.parent) return move(cwd, recorded, prOpen, parent, origin, note);
  if (currentBranch(cwd) === name) return step(recorded, {});
  switchTo(cwd, name, note, local ? undefined : `refs/remotes/origin/${name}`);
  return step(recorded, { switched: true });
}

/** Re-cut a branch with no PR onto a new parent; origin's copy may only be what fbs pushed, which the next push overwrites. */
function move(cwd: string, recorded: FeatureBranch, prOpen: boolean, parent: string, origin: Origin, note: (line: string) => void): Step {
  const { name } = recorded;
  if (recorded.parent === null) throw new BranchRefusedError(`${name} was adopted with --use; it has no parent to move`);
  if (prOpen) throw new BranchRefusedError(`${name} has an open PR; it can't move`);
  if (origin === "offline" && recorded.pushed !== undefined) throw new BranchRefusedError(`can't reach origin to check ${name} before moving it`);
  const originTip = commitOf(cwd, `refs/remotes/origin/${name}`);
  if (originTip !== null && originTip !== recorded.pushed) throw new BranchRefusedError(`origin has commits fbs didn't push to ${name}; it can't move`);
  if (parent === name) throw new BranchRefusedError(`${name} can't be its own parent`);
  const dirty = uncommittedFiles(cwd);
  if (dirty.length > 0) throw new BranchRefusedError(`moving ${name} needs a clean work tree: ${dirty.join(", ")}; ${STASH_HINT}`);
  const wasOnIt = currentBranch(cwd) === name;
  if (!isLocal(cwd, name)) switchTo(cwd, name, note, `refs/remotes/origin/${name}`);
  const start = startPoint(cwd, parent, origin, note);
  const base = commitOf(cwd, start) as string;
  if (!rebaseOnto(cwd, base, recorded.base, name)) throw new BranchRefusedError(`moving ${name} onto ${parent} conflicts`);
  return step({ ...recorded, parent, base }, { switched: !wasOnIt, moved: true });
}

/**
 * Push the feature's branch to origin and record the commit pushed. Before a PR it overwrites only what fbs pushed
 * last; after one it only adds commits. Null when there is no origin to push to.
 */
export function pushFeatureBranch(cwd: string, slug: string, note: (line: string) => void): PushResult | null {
  const rec = readFeature(cwd, slug);
  if (rec.branch === undefined) throw new BranchRefusedError(`no branch recorded for ${slug}`);
  const { name, pushed, previous } = rec.branch;
  const on = currentBranch(cwd);
  if (on !== name) throw new BranchRefusedError(`on ${on ?? "a detached HEAD"}, not ${name}`);
  if (!hasRemote(cwd, "origin")) return null;
  if (protectedBranches(cwd).includes(name)) throw new BranchRefusedError(`${name} is the default branch; pushing it is the user's call`);
  const tip = commitOf(cwd, `refs/heads/${name}`) as string;
  // The push runs before the lock, so a slow or failing network never holds it.
  // After a rename `pushed` is on the old name, so the new one gets a plain push.
  const lease = rec.pr === null && previous === undefined ? (pushed ?? null) : null;
  let outcome = pushBranch(cwd, name, tip, lease);
  // A lease that fails only because origin moved ahead to commits already merged here loses nothing as a plain push.
  if (outcome === "rejected" && lease !== null) outcome = pushBranch(cwd, name, tip, null);
  if (outcome === "rejected") throw new BranchRefusedError(rejection(cwd, name, pushed, rec.pr !== null, tip));
  updateFeature(cwd, slug, (latest) => {
    if (latest.branch?.name !== name || latest.branch.pushed !== pushed) throw new BranchRefusedError(`the record of ${slug} changed during the push; run fbs push ${slug} again`);
    const { previous: _, ...branch } = latest.branch;
    return { ...latest, branch: { ...branch, pushed: tip } };
  });
  const result = { branch: name, pushed: tip, forced: outcome === "forced" };
  if (previous === undefined || pushed === undefined) return result;
  return { ...result, previous: { name: previous, deleted: deleteOldName(cwd, previous, pushed, note) } };
}

/** Delete a renamed branch's old name on origin while it is still what fbs pushed; a failure only leaves it there. */
function deleteOldName(cwd: string, name: string, pushed: string, note: (line: string) => void): boolean {
  try {
    if (deleteOriginBranch(cwd, name, pushed)) return true;
    if (!fetchOriginBranch(cwd, name)) {
      note(`note: ${name} is already gone from origin`);
      return true;
    }
    note(`note: left ${name} on origin: it isn't at the commit fbs pushed`);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    note(`note: left ${name} on origin: ${e.message}`);
  }
  return false;
}

function rejection(cwd: string, name: string, pushed: string | undefined, prOpen: boolean, tip: string): string {
  if (pushed === undefined) {
    return (
      `fbs has no record of pushing ${name} and origin has commits it lacks; run git fetch origin ${name} and git log ${name}..origin/${name}: ` +
      `if those are this branch's own earlier pushes, the user pushes once with git push --force-with-lease=${name}:<sha of origin/${name}> origin ${name} ` +
      "and fbs push works from then on; otherwise look before pushing"
    );
  }
  if (prOpen && mergeBase(cwd, pushed, tip) !== pushed) return `${name} has an open PR and its history was rewritten; after a PR opens, only add commits (if that PR was already merged, run fbs stack sync on the feature first: it records the landing)`;
  return `origin has commits fbs didn't push to ${name}; fetch and look before pushing`;
}

/**
 * A branch the user named, recorded without a parent and based where it left the default branch. A unit's takes the
 * parent and base its stack implies, as if fbs had cut it, and must contain the tip of the branch below it; a unit's
 * branch already recorded with a parent stays as recorded.
 */
function adopt(cwd: string, name: string, recorded: FeatureBranch | undefined, unit: UnitRecord | null, origin: Origin, note: (line: string) => void): Step {
  const onIt = currentBranch(cwd) === name;
  const unborn = onIt && commitOf(cwd, "HEAD") === null;
  const local = unborn || isLocal(cwd, name);
  if (!local && !onOrigin(cwd, name)) {
    if (origin === "offline") throw new GitError(`cannot find ${name}: it isn't here and origin can't be reached`);
    throw new BranchRefusedError(`no branch ${name}`);
  }
  const tipRef = local ? `refs/heads/${name}` : `refs/remotes/origin/${name}`;
  const kept = recorded?.name === name ? recorded : undefined;
  const placed = unit !== null && (kept === undefined || kept.parent === null) ? placeInStack(cwd, name, unborn ? null : (commitOf(cwd, tipRef) as string), unit) : null;
  if (unborn) startWithEmptyCommit(cwd, name, note);
  const branch = placed !== null ? { ...kept, ...placed, name } : (kept ?? { name, parent: null, base: adoptedBase(cwd, name, tipRef) });
  if (!onIt) switchTo(cwd, name, note, local ? undefined : tipRef);
  return step(branch, { switched: !onIt });
}

/**
 * The parent and base createUnit would have given the unit whose branch `name` is at `tip` (null while unborn), refused
 * when it doesn't contain the tip below it. One cut before the unit below landed stays on that unit's branch, based on
 * its landed head, so a sync restacks it; one cut after starts from the default branch, as does any once a merge commit
 * put that head on the default branch.
 */
function placeInStack(cwd: string, name: string, tip: string | null, unit: UnitRecord): { parent: string; base: string } {
  const contains = (commit: string) => tip !== null && commitOf(cwd, commit) !== null && isAncestor(cwd, commit, tip);
  const belowRec = unit.unit === 1 ? readFeature(cwd, unit.unitOf) : unitBelow(cwd, unit);
  const head = belowRec?.landed?.head;
  if (belowRec?.landed !== undefined && belowRec.branch !== undefined && head !== undefined && contains(head) && !onDefaultBranch(cwd, head)) return { parent: belowRec.branch.name, base: head };
  const below = stackedOn(cwd, unit);
  if (below === null) {
    if (tip === null) throw new BranchRefusedError(`${name} has no commits; it shares no history with ${defaultBranch(cwd)}`);
    return { parent: defaultBranch(cwd), base: adoptedBase(cwd, name, tip) };
  }
  const tips = [`refs/heads/${below.name}`, `refs/remotes/origin/${below.name}`].map((ref) => commitOf(cwd, ref)).filter((c): c is string => c !== null);
  if (tips.length === 0) throw new BranchRefusedError(`branch ${below.name} is gone: not here and not on origin`);
  const held = tips.filter(contains);
  if (held.length === 0) throw new BranchRefusedError(`${name} doesn't contain the tip of ${below.name}, which ${unit.slug} stacks on; rebase it onto ${below.name} first`);
  // When the local and origin tips differ, the newer one the branch holds is where it was cut.
  const belowTip = held.find((c) => held.every((other) => isAncestor(cwd, other, c))) ?? held[0];
  return unit.unit === 1 ? { parent: below.parent ?? defaultBranch(cwd), base: below.base } : { parent: below.name, base: belowTip };
}

function onDefaultBranch(cwd: string, commit: string): boolean {
  const main = defaultBranch(cwd);
  const mainRef = [`refs/remotes/origin/${main}`, `refs/heads/${main}`].find((ref) => commitOf(cwd, ref) !== null);
  return mainRef !== undefined && isAncestor(cwd, commit, mainRef);
}

function adoptedBase(cwd: string, name: string, tipRef: string): string {
  const tip = commitOf(cwd, tipRef) as string;
  const main = defaultBranch(cwd);
  if (name === main) return tip;
  const mainRef = [`refs/remotes/origin/${main}`, `refs/heads/${main}`].find((ref) => commitOf(cwd, ref) !== null);
  const base = mainRef === undefined ? null : mergeBase(cwd, tip, mainRef);
  if (base === null) throw new BranchRefusedError(`${name} shares no history with ${main}`);
  return base;
}

/** origin's `parent` when it has one, else the local one; an unborn `parent` gets an empty first commit. */
function startPoint(cwd: string, parent: string, origin: Origin, note: (line: string) => void): string {
  const local = `refs/heads/${parent}`;
  const remote = `refs/remotes/origin/${parent}`;
  if (origin !== "none" && onOrigin(cwd, parent)) {
    if (isLocal(cwd, parent)) {
      const ahead = commitsBetween(cwd, remote, local);
      const commits = `${ahead} commit${ahead === 1 ? "" : "s"}`;
      // A feature branch's unpushed commits are its own work; the default branch's never belong to a feature.
      if (ahead > 0 && parent !== defaultBranch(cwd) && commitsBetween(cwd, local, remote) === 0) {
        note(`note: starting from the local ${parent}, ${commits} ahead of origin`);
        return local;
      }
      if (ahead > 0) note(`note: local ${parent} has ${commits} not on origin`);
    }
    return remote;
  }
  if (!isLocal(cwd, parent)) {
    if (commitOf(cwd, "HEAD") !== null || currentBranch(cwd) !== parent) {
      throw new GitError(`cannot start from ${parent}: no branch ${parent} here${origin === "none" ? "" : " or on origin"}`);
    }
    startWithEmptyCommit(cwd, parent, note);
    return local;
  }
  if (origin === "fetched") note(`note: origin has no ${parent}; starting from the local one`);
  if (origin === "offline") note(`note: could not reach origin; starting from the local ${parent}`);
  return local;
}

function startWithEmptyCommit(cwd: string, branch: string, note: (line: string) => void): void {
  makeEmptyRootCommit(cwd, branch, "chore: initial commit");
  note(`note: the repo had no commits; started ${branch} with an empty initial commit`);
}

function switchTo(cwd: string, name: string, note: (line: string) => void, startPoint?: string): void {
  const carried = uncommittedFiles(cwd);
  const blocking = switchBranch(cwd, name, startPoint);
  if (blocking.length > 0) throw new BranchRefusedError(`uncommitted changes would be overwritten: ${blocking.join(", ")}; ${STASH_HINT}`);
  if (carried.length > 0) note(`note: carrying uncommitted changes: ${carried.join(", ")}`);
}

function isLocal(cwd: string, name: string): boolean {
  return commitOf(cwd, `refs/heads/${name}`) !== null;
}

function onOrigin(cwd: string, name: string): boolean {
  return commitOf(cwd, `refs/remotes/origin/${name}`) !== null;
}

/** origin/HEAD's branch, else `main` or `master`, whichever exists here or on origin, else the unborn branch HEAD is on. */
export function defaultBranch(cwd: string): string {
  const fromOrigin = originDefaultBranch(cwd);
  if (fromOrigin !== null) return fromOrigin;
  const found = ["main", "master"].find((name) => isLocal(cwd, name) || onOrigin(cwd, name));
  if (found !== undefined) return found;
  const unborn = commitOf(cwd, "HEAD") === null ? currentBranch(cwd) : null;
  if (unborn === null) throw new GitError("cannot tell the default branch: no origin/HEAD, main or master");
  return unborn;
}
