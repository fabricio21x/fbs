---
name: changes
description: "Use whenever a feature changes after its spec was approved: the user gives feedback or asks for something new, or a stage finds the spec or design can't hold (a spike result, a limit, a failed assumption). Writes the change down first, sizes it (build, design or scope), amends the spec or design in place, gets the right approval inline, turns it into plan tasks, and lets the work carry on."
user-invocable: false
---

# Changes

A feature changes while it's being built: the user sees it and wants something different, or building it shows the design was wrong. Absorb the change where it happens, keep it on record, and keep going. Never send the user to another command to make a change, and never lose what they said.

Plugin root: the plugin root the calling stage gave you. While the spec or design is still being drafted and isn't approved yet, answers simply go into the draft; this path is for approved documents.

## 1. Write it down first

Run `fbs status show <slug>` and take `dir`, `docs` and `docsRoot`. Write the feature's documents under `docsRoot` (the absolute path of `dir`), and make every commit of them below only when `docs` is `tracked` (`local`: git ignores them, and they stay on this machine).

Then run `fbs branch <slug> --type feature`, so the entry and every amendment are committed on the feature's branch (a feature with work units, whose record lists `units`: `fbs branch <the lowest unit not landed> --existing`, since its documents ship with that unit, or the feature's own branch while no unit has a branch yet; after committing there, run `fbs stack sync <slug>` so every unit above gets them and is verified against the same documents; with local documents every unit reads the same files, so there is nothing to carry); say each `note:` in one line; on `refused:`, show it to the user and do what they choose, never discarding their changes.

An `open` entry already in `<dir>/changes.md` is written down: start at step 2 with it. Otherwise, before anything else, add an entry (create the file from `<plugin root>/skills/changes/changes-template.md` when it doesn't exist): the date, the source, the user's words **verbatim** (or the finding with its evidence), status `open`. Several points in one message are one entry each. Commit it (`docs: record change <n> for <slug>`).

## 2. Size it

Read the spec's scope and acceptance criteria and the design's decisions, and place each change at the lowest level that holds it:

- **Build:** the spec and design already allow it (a bug, a layout fix, a field the design names). No document changes.
- **Design:** the spec still holds, but a design decision changes.
- **Scope:** what the spec promises changes (a criterion, a limit, something new the user will see).

Say the level of each change in one line, with the spec line or design decision it touches.

## 3. Ask only what's open

If a change leaves a real question (a product call, a fact only the user knows, a trade-off with no clear winner), load `fbs:grilling` with the Skill tool and ask just those, in one round, with the question UI when available. Everything else, settle yourself and say what you assumed.

## 4. Amend in place

- **Scope:** edit the affected parts of `spec.md` (scope, out of scope, acceptance criteria, facts), then the design decisions they move. Acceptance criteria keep their positions, because work units cite them as `AC<i>`: a new criterion goes at the end (and into a unit's `Covers`), and a dropped one stays where it is, struck through after its checkbox (`- [ ] ~~<criterion>~~`), and leaves its unit's `Covers`.
- **Design:** edit the affected decisions, data shapes, file map, test seams and risks in `design.md` (Mid: the spec's Design section). When the design doesn't exist yet (Big, before architect has run), leave the entry `open` at level design: architect designs to it.
- **Screens:** when the change adds or reshapes a screen, follow `<plugin root>/skills/architect/ui-direction.md` for the screens it touches (`shape` with the user, mockups) and update the design's UI direction.
- Add a decision-log line per change: `- <YYYY-MM-DD>: Amended: <what>. Why: change <n> (<source>).`
- Touch nothing else. Never rewrite a document or rerun a whole stage for a change.
- **Review only when it adds risk:** a new module, data shape or outside integration, or anything touching payments, auth, permissions or personal data. Then read `<plugin root>/skills/gulag/SKILL.md` with the Read tool, follow it as its calling skill on the amended design (Mid: on the spec), and apply its outcome the way architect's step 8 says. Otherwise no panel.

## 5. Approve inline

Gate what changed: `fbs status gate <slug> spec` after a spec edit, `fbs status gate <slug> design` after a design edit (Mid: always `spec`). Fix format slips as the stage skills say.

Then show the change in chat as one overview, so the user decides from it alone. The files hold the detail, not the decision: never ask the user to read `changes.md`, `spec.md` or `design.md` to decide.

```
**Change C<n>: <the change in a few words>** (<build | design | scope>)
- **Why:** <what was found or asked, with its evidence or the user's words, in one or two lines>
- **What changes for the user:** <what someone using the product sees or can do differently, or "nothing visible">
- **Decisions:** <each choice in the change: what was picked over what, and why, including the ones you settled yourself>
- **Cost and risk:** <tasks added or reopened, what it touches (payments, auth, permissions, personal data), what could go wrong>
- **Detail:** C<n> in `changes.md`; <the spec sections and design decisions amended>.
```

- Several changes at once: one block each, in one message.
- A change that needs no user approval gets the overview too, ending with who approved it and why, and the work carries on: nothing changes out of the user's sight.
- When the user approves, load `fbs:grilling` with the Skill tool first if it isn't loaded, then write the overview and ask its approval question in the same message, so the overview sits right above it.

Then:

- **Spec changed:** the user approves it: `fbs status approve <slug> spec --quote '<their answer, exactly>'`. That drops the design approval, so the design is approved next.
- **Design approval:** approve it yourself with `fbs status approve <slug> design --auto '<reason>'` only when **all** hold: the design had been approved before this change, the amendment follows from a spec change the user just approved (or from no spec change), it adds no module, data shape or outside integration, it touches nothing in payments, auth, permissions or personal data, and no question is open. The reason names why. Otherwise the user approves it. A design that was never approved is architect's to take to the user: hand back to its step 9.
- **When both need the user,** one overview covers both and you ask once; record their answer for each.
- **Mid:** the spec is the single document; one user approval covers it.
- When the design changed and `overview.html` exists, rewrite it (and any mockup the change affects) from the amended design.

Commit the amended documents (when tracked; `docs: amend <slug> for change <n>`): the next stage needs a clean tree. Never record an approval the user didn't give; a refusal from `approve` is reported, never worked around.

## 6. Turn it into work and carry on

- **A feature with work units:** each change that needs building goes to the unit that owns the code it touches (the lowest unit not landed whose files it touches), in that unit's `plan.md`, never to whichever unit is checked out; implement builds it there and `fbs stack sync` carries it up the stack. When that unit already landed, or the user decides it stands apart, it's a follow-up unit: a design-level amendment adds a `### U<n>` section on top of the stack (approved as section 5 says), `fbs status init <unit slug> --unit-of <slug>` records it, and `fbs:tracker` proposes its sub-issue, created on the user's go-ahead.
- When `<dir>/plan.md` exists, add a task for each change that needs building, including code the change makes obsolete. A blocked or escalated task the change settles goes back to `todo` (or `superseded`, when the change replaces it). Commit `plan.md` (when tracked; with local documents there is no plan commit to fix up) as a fixup of the plan's first commit (`git commit --fixup=<that commit>`) while the PR isn't open yet, so organizing the branch folds it into the plan; once the PR is open, a plain commit. Without a plan yet, the entry stays for implement to plan.
- Set the entry's status to `planned` (or leave it `open` as above) with its outcome: what was amended, who approved, which tasks. Commit `changes.md` (when tracked), then push it with `fbs push <slug>`: the feature's branch is pushed whenever it gets commits, so the work is backed up and visible. Say a `skipped:` or `refused:` from it in one line; it never blocks this stage; in a review round, camp-pr pushes once for the round instead.
- Hand back so the work continues: to the stage that was running, or, when you came from plan, architect or assemble, into implement, which builds the new tasks. Implement marks an entry `done` when its tasks are done.
