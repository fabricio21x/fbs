---
name: plan
description: "Plan a feature: grill an idea or request into a spec with confirmed assumptions, sized mid or big, and gate it with the fbs CLI. Continues into /fbs:architect."
disable-model-invocation: true
argument-hint: "[idea or feature slug]"
allowed-tools: Bash(fbs *)
---

# Plan

Turn an idea into a spec whose every assumption is confirmed. The spec is what `/fbs:architect` designs from, so a wrong fact here costs every later stage.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the idea, request or feature slug given in the arguments or by the calling skill: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected: only a bare `fbs …` call is pre-approved.

**Work from the files.** Load or read each skill, template and agent this stage names when its step comes, the way the step says, even if it ran earlier in this session. The documents hold what is settled. Once the spec is approved, anything the user says that changes it or the design, and anything this stage finds they can't hold, goes through the change path first (load `fbs:changes` with the Skill tool), so it's written down before it's acted on.

**Keep going.** Never ask the user to type a command. When this stage is done and nothing is pending (an approval, a decision, a blocker), say in one line what you're starting and continue into the next stage yourself: read its SKILL.md under `<plugin root>/skills/` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

## 1. Load and check the context

1. Load the `fbs:grilling` and `fbs:principle-check-the-facts` skills with the Skill tool. Follow both for the rest of this stage.
2. Run `fbs context check`.
   - `stale:` lines: each stale fact is a business-fact question in the first round, asked first, ahead of the assumptions check ("Is this still true?").
   - `error:` lines: report them in one line each, and keep going.
   - If `fbs` can't run (not installed, not a git repo), say so in one line and read `.fbs/context.md` directly when it exists.
3. **The tracker.** Load `fbs:tracker` with the Skill tool and run its setting step (it asks once per repo when the tracker isn't set). Its question isn't asked on its own: it goes into the first round, as a numbered question right after the stale-fact rechecks. When the input is a ticket (an id like `ACM-123` or `#45`, or a tracker URL), also read the ticket now with its read step: its content is input to grill on, like the rest of the request. It is recorded once the feature has a record (step 5).
4. If the input names an existing feature (a slug such as `paid-plans`, alone or followed by a request), run `fbs status show <slug>` and skip `init` later:
   - `error: missing`: treat the input as a new idea and continue below.
   - The record has a spec approval with `current: true`: if the input asks for a change, or `<dir>/changes.md` has an `open` entry, this is a change to an approved feature: load `fbs:changes` and follow it; it continues into implement. Otherwise say where the feature stands in one line and continue into the next stage (Big without a current design approval: architect; otherwise implement).
   - The record has a spec approval with `current: false`: the spec changed since it was approved. For Big, read it, run the gate (step 6), and ask the user to approve it again. For Mid, continue into architect; it owns the single Mid approval.
   - No approval: read `<dir>/spec.md`, grill what is still open, and continue from where it stands.

## 2. Pick the mode

- **Directed:** the input already states a *what* and a *why*.
- **Brainstorm:** the idea isn't formed yet: the problem, the goal or the expected outcome is missing.

The message that carries the first question round starts with this line:

```
**Mode:** <directed|brainstorm>, because <one-line reason>
```

**Directed.**
- Treat the stated what and why as settled input for grilling.
- If the input also proposes a *how* (a named method, schedule or flow), add one line right after the mode line: `**Set aside:** <the proposed how>. I'll work out the approach independently and compare both with you before we decide.`
- Part of the what, not a how, so never set aside:
  - a need without a method ("a way to X");
  - a provider or constraint already chosen in `CLAUDE.md` or the context (the payments provider, the market).
- A technology choice (stack, framework, hosting, data store, module structure, or the mechanism that runs the work: a cron job, a queue, a worker) is never plan's to decide, whoever proposes it. Instead of the set-aside line, write `**Technology:** <the proposal>. That's for /fbs:architect; I'll record it as your preference.` Record it as a fact (`- Prefers <the proposal> (user, <YYYY-MM-DD>)`). Never ask a technology question here.
- Don't ask questions that tune the proposed how. Find the best how yourself; the comparison comes as one decision question once the what is settled (step 4).
- The work is finding the best how as the user experiences it (the flow, the channel, the timing), structuring the idea, defining the goal and how success is measured.

**Brainstorm.**
- The first round asks only product questions (the problem, the goal, the expected outcome), the stale-fact rechecks from step 1, and the tracker question when the tracker is unset.
- Hold every question about how it works until the what and why are settled.

## 3. Size

Propose a size in one line after the mode line (and the set-aside line): `**Size:** <mid|big>, because <reason>`. The user may override it.

| Size | Signals |
|---|---|
| Mid | A feature inside existing modules, about a day of work |
| Big | A new module or domain, cross-cutting work, an external integration, a data migration, a security-sensitive area (payments, auth, permissions), or several PRs |

If the work is tiny (one or two files, obvious approach, no new data shape, no business fact) or a bug, say that `plan` isn't needed and take that route now: a bug continues into tdd; a tiny change gets a record (`fbs status init <slug> --size tiny`), its branch (`fbs branch <slug> --type <feature, or chore when no behaviour changes>`, as in step 5) and its ticket (`fbs:tracker`: the one it came from, recorded before the branch, or one issue on a one-line go-ahead after it), then is implemented directly, test-first, and verified.

## 4. Grill

Run the grilling skill on the input, passing the settled input and the mode. These rules add to it:

- **Rollout and control machinery** (admin screens, feature flags, phased or staged releases, backfills) is never sequenced ahead of the integration it would precede.
  - Offer it only as a costed alternative.
  - Recommend it only when a sourced fact or the user's stated need calls for it, and then prefer the chosen provider's own dashboard, portal and records first.
  - When a sourced fact says users are few, recommend a one-off manual step over tooling.
- **Directed with a set-aside how:** once the what is settled, ask one decision question that contrasts the proposed how with yours, each explained, with one recommendation. A set-aside technology choice gets no question: it goes to the Facts as a preference.
- Keep grilling round by round until the frontier is empty and the user confirms the decisions and assumptions.

## 5. Write the spec

1. Pick a slug: lowercase words joined by `-`, at most four words (`paid-plans`).
2. Unless step 1 found the record, run `fbs status init <slug> --size <size>` and take `dir` from its JSON. `dir` is relative to the repo root.
   - `error: exists`: ask whether to continue that feature or pick another slug.
   - Any other failure: report it and stop; the spec needs a feature record.
   - **Where the documents go,** a found record too: run `fbs status show <slug>` and take `docs` and `docsRoot`. Write the feature's documents under `docsRoot` (the absolute path of `dir`), and commit them only when `docs` is `tracked`: `local` means git ignores them, so they stay on this machine.
3. When the work comes from a ticket, record it: `fbs status ticket <slug> '<id>' --url <its url>`. Then run `fbs branch <slug> --type feature` (it takes the ticket from the record): a feature lives on its own branch from the moment it has a record, so none of its commits land on the default branch. It switches to the feature's branch, creating it the first time from the remote's default branch with a conventional name (`feature/<ticket>-<slug>`, all lowercase). Pass `--parent <the other feature's branch>` when the user says this feature builds on another feature's unmerged work (its PR then stacks on that one), and `--use <branch>` only when the user explicitly asked to work on that branch for this feature, the default branch included. Say each `note:` in one line; on `refused:`, show it to the user and do what they choose, never discarding their changes. When step 1's tracker step wrote `.fbs/config.json`, commit it now (`chore: set the issue tracker`), unless git ignores it (`git check-ignore -q .fbs/config.json` exits 0).
4. Read the template at `${CLAUDE_SKILL_DIR}/spec-template.md` (if unexpanded: `<plugin root>/skills/plan/spec-template.md`) and write `<dir>/spec.md` from it.
   - Keep every heading exactly as written, in order, and add no other heading. Fill the two metadata lines under the title.
   - The title must not contain the words "question" or "assumption".
   - Replace each guidance comment with the content. A section with nothing to say gets `None`.
   - Leave `## Design` as `(Mid only; written by /fbs:architect)`.
   - Acceptance criteria are `- [ ]` lines, each checkable.
   - Where a flow or a structure is easier to see than to read (the user's journey, the states something moves through), add a short mermaid diagram inside the section it explains. Never inside Facts, Assumptions or Open questions, which the gate reads line by line.
5. **Gate sections, exact format,** one line each, no nesting or other markers:
   - **Facts:** every business fact the spec rests on that is confirmed, `- <fact> (<source>)`, the source being `CLAUDE.md`, `.fbs/context.md`, another file path (optionally `:line`), a URL, or `user, <YYYY-MM-DD>`, with nothing after the closing parenthesis and no parentheses inside it. A fact goes here only from a source or the user's confirmation.
   - **Assumptions:** only what nobody confirmed. `- [ ] <assumption>` while open; once the user explicitly accepts it as an unknown, `- [x] <assumption> (user, <YYYY-MM-DD>)`. When the user confirms it instead, it moves to Facts.
   - **Open questions:** `- <question>` lines.
   - A section with nothing in it is `None`; when you add a line to it, remove the `None`.
6. **Decision log:** every decision from grilling, one line each: `- <YYYY-MM-DD>: <decision>. Why: <reason>.` When a loaded principle changed the decision, end with `Principle: <skill name>`, such as `Principle: principle-smallest-change`.

## 6. Gate and approval

Run `fbs status gate <slug> spec`, and handle what `gate` or `approve` prints:

| Output | Do |
|---|---|
| `ok` (gate) or the record JSON (approve) | Go on. |
| An `error:` line, or exit 2 | Report it and stop. Don't retry. |
| `missing section`, `empty section`, `unsupported markup` | A format slip: fix the spec yourself and rerun the gate. If the same line comes back, report it and stop. |
| `unsourced` | A fact without its source: add the source it came from. If it has none, move it to Assumptions as `- [ ]` and grill on it. |
| `unconfirmed`, `open question` | Grill the user on them, update the spec with the answers, and rerun the gate. |

Never flip `[ ]` to `[x]`, or delete a question, without the user's answer. A format fix changes the markup, never what a line says.

Once the gate prints `ok`, write a short summary (problem, goal, scope, size), then the Facts and Assumptions exactly as written in the spec. Show them in the chat; for Big, right before the approval question below.

**Big:**
1. Ask for approval only after the gate prints `ok`.
2. Only an explicit approval of the spec counts. A "yes" to a question round does not.
3. Ask with `fbs:grilling`'s approval question, in the same message as the summary and the Facts and Assumptions. On approval, pass the answer verbatim, nothing summarised, in single quotes, writing each `'` inside as `'\''`:
   `fbs status approve <slug> spec --quote '<the answer, exactly>'`
4. If the spec changes after approval, rerun the gate and ask for approval again.

**Mid:** don't ask for approval. The single Mid approval happens in `/fbs:architect`.

Never record an approval the user didn't give.

## 7. End

Once the spec is approved (Big) or gated (Mid), commit the feature's documents when `docs` is `tracked` (`docs: spec for <slug>`), push it with `fbs push <slug>`: the feature's branch is pushed whenever it gets commits, so the work is backed up and visible. Say a `skipped:` or `refused:` from it in one line; it never blocks this stage. Then continue into architect.
