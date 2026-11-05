---
name: walkthrough
description: "A guided, interactive review of a built feature in the running app: drive a browser the user watches, present one feature per turn with what to look at and the expected result, stop for their notes, record them verbatim, root-cause each with path:line, and leave a notepad of typed, ranked to-dos."
disable-model-invocation: true
argument-hint: "[feature slug]"
allowed-tools: Bash(fbs *)
---

# Walkthrough

Show the user the feature the way a teammate would at their desk: one thing at a time, what to look at, what should happen, then listen. The deliverable is a notepad of their feedback, each item with its root cause and a to-do.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the feature slug given in the arguments or by the calling skill: $ARGUMENTS

Run every `fbs` command as its own Bash call, with nothing chained, piped or redirected.

**Work from the files.** Load or read each skill, template and agent this stage names when its step comes, the way the step says, even if it ran earlier in this session. The documents hold what is settled. Once the spec is approved, anything the user says that changes it or the design, and anything this stage finds they can't hold, goes through the change path first (load `fbs:changes` with the Skill tool), so it's written down before it's acted on.

**Keep going.** Never ask the user to type a command. When this stage is done and nothing is pending (an approval, a decision, a blocker), say in one line what you're starting and continue into the next stage yourself: read its SKILL.md under `<plugin root>/skills/` with the Read tool and follow it, with the slug and the plugin root.

**Ask with the question UI.** Every question to the user, approvals and go-aheads included, goes through the AskUserQuestion tool when it is available, with what the user needs to answer shown in the chat right before it (`fbs:grilling`'s rules). Plain text only when the answer can't be options, or without the tool.

Every expected result you state comes from the spec, the design or the code, never from memory.

## 1. Prepare

1. Run `fbs status show <slug>` and take `dir`, `docs` and `docsRoot`: the notepad goes under `docsRoot`, and is committed only when `docs` is `tracked` (`local`: git ignores it). Run `fbs branch <slug> --existing`, so the app runs the feature's branch and the notes are committed there; `refused: no branch recorded` means the work predates branch records: when the current branch isn't the default branch and holds this feature's commits, run `fbs branch <slug> --use <it>`; otherwise ask the user which branch holds it; say each `note:` in one line; on `refused:`, show it to the user and do what they choose, never discarding their changes. Read `<dir>/spec.md`, and `design.md` when it exists.
2. If `.fbs/validation/README.md` doesn't exist, set it up first: read `<plugin root>/skills/setup-validation/SKILL.md` with the Read tool, follow it as its calling skill, then continue here. You need browser tools (the Chrome DevTools MCP tools, or the Playwright MCP tools); with neither, say so and stop.
3. **Agenda.** A numbered list of the features to show, each with who is signed in and the expected behaviour from the spec. Sequence it so the data each step needs can already exist by then.
4. **Sign-in.** The user types every password; never fill a sign-in form. Follow Auth in `.fbs/validation/README.md`, and when a second persona is needed, the user acts in their own private window on your instructions.
5. **Demo data** through the product's own flows, so its history is real. A shortcut that bypasses them (a seed script, SQL) is used only for setup the review doesn't cover, and each one is named to the user. Never reset or drop a database.
6. Launch the app as `.fbs/validation/README.md` says, if it isn't running.
7. Read `${CLAUDE_SKILL_DIR}/notepad-template.md` (if unexpanded: `<plugin root>/skills/walkthrough/notepad-template.md`) and create the notepad at `<dir>/walkthrough-<YYYY-MM-DD>.md`. Show the agenda in your reply and ask the user to say when they're ready.

## 2. Each feature, one per turn

1. **Set the state and confirm it.** Navigate, then take a snapshot (scoped to the main region, to keep it small) to confirm the screen shows what you'll describe. Reload once if the session looks stale.
2. **Your reply is the presentation:**
   - `## Feature N of M: <name>`
   - who is signed in, and the URL;
   - **Look at** and **Try this**, as numbered checks, each with its expected result;
   - what the demo can't show (a background job, an outside service), and what covers it instead (a test, saved validation evidence);
   - "Your notes, or 'next' to move on."

   Then stop and wait.
3. **When the user replies:**
   - save any pasted image next to the notepad as `f<N>-<what>.png`;
   - copy their notes into the feature's section **verbatim**;
   - find each note's root cause by reading the code (an `fbs:explorer` agent for a broad lookup), with `path:line`;
   - derive to-dos (`1a`, `1b`, …) with a type (Bug, UX, Product change, Decision, Verify) and a severity, into the to-do table;
   - mark the feature done, then present the next one.
4. A question about why something works the way it does: answer it, record it, and carry on.
5. Something you notice outside the feature on show is an observation (`O1`, `O2`), not a to-do for the feature.

A snapshot can hide icon-only elements; never claim something is missing from a snapshot alone.

## 3. Close

1. Fill the notepad's Summary: the to-dos by area of work, defects first; the decisions still open; what to verify; the observations; and any demo data still in the app, with how to remove it.
2. Close the pages you opened in the browser tools and stop anything you launched (only those), and ask whether to keep or clean the demo data.
3. When `docs` is `tracked`, commit the notepad (`docs: walkthrough notes for <slug>`), no attribution lines, then push it with `fbs push <slug>`: the feature's branch is pushed whenever it gets commits, so the work is backed up and visible. Say a `skipped:` or `refused:` from it in one line; it never blocks this stage.
4. Report the grouped to-dos and the open decisions, then ask once whether to build them now. On yes, the to-dos are changes: run the change path for them (each one an entry, sized), then continue into implement, which builds the new tasks; validate and verify follow. On no, still record each to-do as a `changes.md` entry with status `deferred` (so nothing is lost), and go on to verify.
