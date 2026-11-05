---
name: architect
description: "Design a feature whose spec is settled (Big: approved; Mid: passes the gate): impact map, constraints, structurally different options, then a design with data shapes, a file map, test seams and a rollout that fits the project's real stage, reviewed by the gulag and gated by the fbs CLI. Big writes design.md plus a one-page overview.html, with screen mockups when the feature has UI, for the reviewer; Mid fills the spec's Design section. Continues into implementation."
disable-model-invocation: true
argument-hint: "[feature slug]"
allowed-tools: Bash(fbs *)
---

# Architect

Turn an approved spec into a design someone can build without surprises. A consumer the design misses, or a fact it never checked, costs every stage after it.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the feature slug given in the arguments or by the calling skill: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected: only a bare `fbs …` call is pre-approved.

**Work from the files.** Load or read each skill, template and agent this stage names when its step comes, the way the step says, even if it ran earlier in this session. The documents hold what is settled. Once the spec is approved, anything the user says that changes it or the design, and anything this stage finds they can't hold, goes through the change path first (load `fbs:changes` with the Skill tool), so it's written down before it's acted on.

**Keep going.** Never ask the user to type a command. When this stage is done and nothing is pending (an approval, a decision, a blocker), say in one line what you're starting and continue into the next stage yourself: read its SKILL.md under `<plugin root>/skills/` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. Check the precondition

Run `fbs status show <slug>` and take `size`, `dir`, `docs` and `docsRoot` from its JSON. `dir` is relative to the repo root; write the feature's documents and mockups under `docsRoot` (its absolute path), and commit them only when `docs` is `tracked` (`local`: git ignores them).

- `error: missing`, or no slug given: there is no feature yet. Continue into plan with the user's input.
- Any other `error:` line, or exit 2: report it and stop.
- **Big:** needs `approvals.spec` with `current: true`. Without it, or with `current: false` (the spec changed since its approval), continue into plan to settle and approve the spec; it comes back here.
- **Mid:** run `fbs status gate <slug> spec`. Anything but `ok`: continue into plan to settle the spec. Skip this check when the spec's `## Design` already holds subsections: that is a revision (below), and step 9 runs the gate.
- Tiny or bug: this stage isn't needed. A bug continues into tdd; a tiny change is implemented directly, test-first.

Then look for earlier work on this stage:

- **Already approved:** Big with `approvals.design` at `current: true`, or Mid with `approvals.spec` at `current: true`. If the input asks for a change, or `<dir>/changes.md` has an `open` entry, load `fbs:changes` and follow it; it continues into implement. If the design has work units the record doesn't list yet, or `<dir>/tracker.md` is missing or not yet `created` or `Skipped`, go to step 10's work units and tracker steps. Otherwise say the design is approved and continue into implement.
- **A revision:** `<dir>/design.md` exists (Mid: the spec's `## Design` holds subsections, not the placeholder). Reuse `<dir>/impact.md`, rerunning the map only for areas the spec change adds. Revise only the parts of the document the spec change affects, going through steps 4 to 7 for those parts, and never rewrite the document from scratch. Then go on to step 8.

Read `<dir>/spec.md`, and `<dir>/changes.md` when it exists: design to the spec and to its `open` design-level entries, and mark those `planned` once the design holds them. The spec's scope, criteria and decisions are settled input; don't reopen them.

Run `fbs branch <slug> --type feature` before writing anything (the type only names a branch plan didn't create), so the design is committed on the feature's branch; say each `note:` in one line; on `refused:`, show it to the user and do what they choose, never discarding their changes.

## 2. Load the principles

Load `fbs:principle-model-the-domain`, `fbs:principle-smallest-change` and `fbs:principle-check-the-facts` with the Skill tool, and follow them for the rest of this stage. When one changes a decision, that decision's log line names it.

## 3. Impact map

Load the `fbs:impact-map` skill with the Skill tool and run it on the spec, giving it `<dir>` so it writes `<dir>/impact.md`. It waits for its explorers; don't draft the design while they run.

Then take each item of the map's `## Open` section, one by one:

- a code fact: look it up yourself and put the answer in Impact, with its `path:line`;
- a business fact that `CLAUDE.md` or `.fbs/context.md` answers: put it in Constraints with its source;
- anything else: carry it into the design's `## Open questions` (Mid: the spec's), or grill on it in step 6.

Never drop an Open item silently.

## 4. Constraints

Run `fbs context check`. A `stale:` fact is a question for step 6. Report an `error:` line in one line and keep going. If `fbs` can't run, read `.fbs/context.md` directly when it exists. Then list what the design must fit:

- the project's stage and business facts, each with its source (`CLAUDE.md`, `.fbs/context.md`, the spec, or the user and date); these go in Facts;
- the user's technology preferences the spec records, as preferences, not decisions;
- chosen providers, and the conventions in `CLAUDE.md` and `.claude/rules/` when they exist;
- timeline and outside limits the spec or the context state.

## 5. Options

- Name the data shape of the change before any flow.
- When the right answer isn't obvious, write at least two structurally different options: a different data shape or module boundary, not two names for one idea. Include the smallest one that meets every acceptance criterion.
- For each: its data shape, its structure (modules and files), its cost (to build, run and reverse), and what it changes for the user.
- **Technology choices** (stack, framework, hosting, data store) belong to this stage. When the project has no stack yet, they are part of the options: weigh the user's stated preference as a constraint, and recommend what fits the spec, even when it isn't the preference.
- End with one recommendation and its reason. When one answer is obvious, write it and say in one line why nothing else competes.
- A quick check of a fact (one request, one lookup) is fine. A longer experiment, or anything left running in the background, is a spike: offer it to the user with its cost, and run it only on their go-ahead; otherwise list it in Risks as a spike for implementation. A spike the approved spec already includes is in scope: run it yourself in the background and watch it, asking the user only for steps only they can do.
- **Rollout and control machinery** (admin screens, feature flags, phased or staged releases, backfills) never goes ahead of the integration it would precede. It needs a sourced fact or a spec criterion that calls for it, and then the chosen provider's own dashboard, portal and records come first. When a sourced fact says users are few, a one-off manual step beats tooling.

## 6. Grill only real decisions

Load `fbs:grilling` with the Skill tool and run it, passing the spec and its decisions as settled input, plus your options and recommendation. Ask only:

- a product or business call, or a fact only the user knows;
- a tradeoff with no clear winner;
- anything irreversible.

Settle every other point yourself and list it under **Assuming**. When nothing qualifies, skip the round and say so in one line.

## 7. Write the design

**Big:** read `${CLAUDE_SKILL_DIR}/design-template.md` (if unexpanded: `<plugin root>/skills/architect/design-template.md`) and write `<dir>/design.md` from it.

- Keep every `##` heading exactly as written, in order, and add no other `##` heading.
- Replace each guidance comment with the content. A section with nothing to say gets `None`; leave `## Gulag outcome` as `(Filled after the gulag.)`.
- **Data shapes** come before any flow. **File map** is a tree with a one-line purpose per entry. **UI direction**, when the feature has screens: read `${CLAUDE_SKILL_DIR}/ui-direction.md` (if unexpanded: `<plugin root>/skills/architect/ui-direction.md`) and follow it.
- **Rollout** fits the project's real stage and cites the sourced fact it rests on.
- **Work units:** split the feature into the PRs it ships as, so each review is small. A unit is approvable on its own (a reviewer can judge it without the next one) and ships something whole: cut by feature, not by layer (an endpoint and its only screen are one unit), and fold types, constants and helpers into the first unit that uses them. Order units so each one's dependencies come first; when two units touch the same file, say so and make the later one depend on the earlier. Every acceptance criterion is covered by exactly one unit (the gate checks it); a unit covering none is setup that the next unit needs. When the feature came from a ticket that already has sub-issues, start from them and say where your split differs. A feature small enough for one PR gets `None`.

**Mid:** replace the placeholder under the spec's `## Design` with these `###` subsections, in order: Impact, Constraints, Options and recommendation, Data shapes, UI direction, File map, Test seams, Risks, Rollout, Gulag outcome. Merge this stage's facts, assumptions, open questions and decisions into the spec's top-level `## Facts`, `## Assumptions`, `## Open questions` and `## Decision log`; never repeat them under `## Design`.

**Both:**

- **Impact** holds only the map's table and its `Checked, not touched` list. Retitle the map's heading to plain `Impact map` and demote every heading so it sits below the Impact heading. The map's `## Open` section is never copied: its items went through step 3.
- **Apart from the three gate sections themselves, no heading below the title, at any level, contains the words "fact", "question" or "assumption".** The gate reads such a heading as a gate section.
- **Diagrams:** a mermaid diagram where a picture reads faster than prose: a state diagram for a state machine, an entity diagram for related tables, a graph of the modules, a sequence for the main flow. Never inside a gate section.
- **Gate sections** (Facts, Assumptions, Open questions): one line each, exactly as the template's comment for the section says (Mid: the spec template's). A confirmed assumption moves to Facts. An empty section is `None`; when you add a line to it, remove the `None`.
- **Decision log:** one line per decision, its alternatives in the reason: `- <YYYY-MM-DD>: <decision>. Why: <reason>.`, ending `Principle: <skill name>` (for example `Principle: principle-smallest-change`) when a principle changed it.

## 8. Gulag

Read `${CLAUDE_PLUGIN_ROOT}/skills/gulag/SKILL.md` (if unexpanded: `<plugin root>/skills/gulag/SKILL.md`) with the Read tool, never the Skill tool, and follow it as its calling skill. Give it the document path (`<dir>/design.md`; Mid: `<dir>/spec.md`), the expanded plugin root, and the review model when the user asked for one (for example Fable). Wait for it to hand back.

- Apply every line of the judge's changes to the document (a `Risks:` line goes into Risks), and nothing else.
- Log each rejected finding: `- <YYYY-MM-DD>: Rejected <id>: <claim>. Why: <judge's reason>.`, ending `Principle: <name>` when the finding named one.
- Add each of the judge's open questions to the open questions.
- Fill the template's `Gulag outcome` section without repeating its heading: the panel line, then one line per finding (`<id> (<severity>): accepted|rejected|undecided, <reason>`), then the changes applied.
- If the panel didn't run, a seat is missing or the verdict is `null`, write that in `Gulag outcome` exactly as the gulag reported it, tell the user, offer to rerun, and end your turn. Go on to step 9 only after a rerun, or after the user explicitly says to go ahead without one; write that go-ahead into `Gulag outcome`. Never stand in for the panel.

## 9. Gate and approval

**Big:** first read `${CLAUDE_SKILL_DIR}/overview-template.html` (if unexpanded: `<plugin root>/skills/architect/overview-template.html`) and write `<dir>/overview.html`, replacing each guidance comment with its content: the one page the user reviews, drawn from `design.md` plus the spec's Problem and Out of scope. `design.md` stays the source of truth.

Run `fbs status gate <slug> design` (Mid: `spec`), and handle what `gate` or `approve` prints:

| Output | Do |
|---|---|
| `ok` (gate) or the record JSON (approve) | Go on. |
| `error: spec-changed` | The spec was edited after its approval: re-approve it through the change path's approval step, then approve again. |
| Any other `error:` line, or exit 2 | Report it and stop. Don't retry. |
| `missing section`, `empty section`, `unsupported markup` | A format slip: fix it and rerun the gate. If the same line comes back, report it and stop. |
| `unsourced` | A fact without its source: add the source it came from, or move it to Assumptions as `- [ ]` and grill on it. |
| `unconfirmed`, `open question` | Grill the user on them, write the answers in (decision log; a confirmed fact moves to Facts with `user, <date>`; an accepted unknown becomes `[x]`), and rerun the gate. |

Never flip `[ ]` to `[x]`, or delete a question, without the user's answer.

- **An answer that changes a decision:** update the design, add a `Stale:` line to `Gulag outcome` naming what changed after the review, and offer to rerun the gulag.
- **An answer that contradicts the spec** (Big): it's a scope change. Run the change path for it, then come back here.

Once the gate prints `ok`:

- **Big:** a fresh `fbs status show <slug>` must still have `approvals.spec` at `current: true`; if not, re-approve it through the change path first. If `design.md` changed since the overview was written, rewrite the overview. Open it in the user's browser (`open <dir>/overview.html` on macOS; otherwise give its path) and show its `Needs your call` section.
- **Mid:** show a short summary (the recommended option, key decisions, rollout, gulag outcome, and with screens the UI direction's design direction and key states, opening each mockup).

Then ask the user to approve the design with `fbs:grilling`'s approval question, right after showing the Facts and Assumptions exactly as written. Open the overview or mockups first: the summary, the Facts and Assumptions and the question go in one message. Only an explicit approval of the design counts. Pass the answer verbatim in single quotes, writing each `'` inside as `'\''`:

- Big: `fbs status approve <slug> design --quote '<the answer, exactly>'`
- Mid: `fbs status approve <slug> spec --quote '<the answer, exactly>'`, the single Mid approval.

If the document changes after approval, rerun the gate, rewrite the overview (Big), and ask again. Never record an approval the user didn't give.

## 10. End

Once the design is approved, commit everything this stage wrote (the feature's documents and mockups when `docs` is `tracked`, plus any `PRODUCT.md`, `DESIGN.md` or `CLAUDE.md` change from the UI direction; `docs: design for <slug>`) and push it with `fbs push <slug>`, so the issues can link to it.

**The work units** (Big, when `## Work units` isn't `None`). Each unit gets its own record, so it gets its own branch, verify stamp and PR: for each `### U<n>: <name>` in order, pick a unit slug (the unit's name as lowercase words joined by `-`, at most four words, unique among `fbs status list`) and run `fbs status init <unit slug> --unit-of <slug>`, which numbers it next. Skip units the record already lists (`fbs status show <slug>` lists `units`).

**The tracker.** Load `fbs:tracker` with the Skill tool and run its propose-and-create step for this feature, with `<dir>`: the approved design (Mid: the spec) and its work units become the tracker structure, created only on the user's go-ahead, before any implementation. With no tracker it does nothing.

Then push again with `fbs push <slug>` (the tracker's commit, and a renamed branch): the feature's branch is pushed whenever it gets commits, so the work is backed up and visible. Say a `skipped:` or `refused:` from it in one line; it never blocks this stage. Then continue into implement; for a feature with work units, continue into assemble with the slug instead: it builds the units in order.
