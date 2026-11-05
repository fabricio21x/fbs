---
name: gulag
description: "Adversarial review of a design or spec: independent seat agents (pessimist, security, lazy-boi, code-purist, staff engineer) review it in parallel, a judge accepts or rejects every finding with a reason, and the result is the list of changes to the document. Never approves."
disable-model-invocation: true
argument-hint: "[path to design.md or spec.md]"
---

# Gulag

Put a design or spec in front of reviewers who want it to fail, before anyone builds it. A hole nobody raises here turns up later in production, or as a day of work nobody needed.

Plugin root: `${CLAUDE_PLUGIN_ROOT}` (if this shows unexpanded, use the plugin root the calling skill gave you).

Input: the path to the `design.md` or `spec.md` given in the arguments or by the calling skill: $ARGUMENTS

You run the panel and report its result. You don't review the document yourself, and you don't decide the findings: the seats and the judge do.

## 1. Read the document and collect the inputs

1. Read the document. If no path was given, or it doesn't exist, say so in one line and stop.
2. Collect the inputs, as paths from the repo root, each only when it exists (check with Glob):
   - `CLAUDE.md`;
   - `.fbs/context.md`;
   - the sibling `spec.md`, when the document is a `design.md`;
   - the sibling `impact.md`.
3. Pass the paths, not their contents. Every seat and the judge read them themselves.

## 2. Pick the seats

| Document | Seats |
|---|---|
| A `design.md` (or any document that isn't a spec) | `fbs:seats:pessimist`, `fbs:seats:security`, `fbs:seats:lazy-boi`, `fbs:seats:code-purist`, `fbs:seats:staff-engineer` |
| A `spec.md` (Mid) | `fbs:seats:pessimist`, `fbs:seats:security`, `fbs:seats:lazy-boi` |

Never drop the security seat: payments, auth, permissions and personal data always get it.

## 3. Run the panel

Call the Workflow tool to run the plugin workflow `fbs:panel`, with these args:

```json
{ "doc": "<document path>", "inputs": ["<input path>", "..."], "seats": ["fbs:seats:<seat>", "..."] }
```

The judge and the pessimist, security and staff-engineer seats run on Opus. Only when the user (or the calling skill, on the user's behalf) asked for another review model, such as Fable, add `"model": "fable"` to the args; it replaces Opus for those four and costs more. The same holds for every Agent call below to one of those four: set `model` only then.

- If the name `fbs:panel` is rejected, call the Workflow tool once more with the script path `<plugin root>/workflows/panel.js` and the same args.
- The workflow runs the seats in parallel, then the judge, and returns `{ findings, verdict, missing }`:
  - `findings`: each seat's list, with `seat` set to its short name (`pessimist`, …);
  - `verdict`: the judge's `decisions`, `changes`, `summary` and `uniform`, or `null` when the judge failed or never ran;
  - `missing`: the short names of the seats that returned nothing.
- The run is in the background and you are notified when it completes. Wait for that notification: don't poll, and don't read the run's transcript or journal files. Until it arrives, say only that the panel is running.
- Only a failure to **start** the workflow (the tool is unavailable or denied, or both the name and the script path are rejected) sends you to the fallback in section 4. A run that started and then failed doesn't: report `**Panel:** workflow fbs:panel, failed: <error>`, offer to run the panel again, and stop.

## 4. Fallback: parallel agents

1. In **one message**, start one Agent call per seat, all in parallel, with `subagent_type` set to the seat (`fbs:seats:pessimist`, …). Give each the same prompt:
   `Document under review: <path>. Inputs to read before reviewing (skip any that don't exist): <paths>. Review the document through your lens and return your findings as JSON, in your output format.`
2. Wait for every seat. A seat that fails or returns no JSON goes into `missing`; don't redo its review yourself. When `security` is missing, rerun it now, as section 5 says, so the judge sees its findings.
3. If no seat returned, skip the judge. Otherwise start one Agent call with `subagent_type: "fbs:judge"`. Give it the document path, the input paths, and every seat's JSON verbatim, and ask for its verdict as JSON, in its output format. If it fails, the verdict is `null`.
4. Never stand in for a seat or the judge. If the Agent tool is unavailable too, say the panel can't run and stop.

## 5. Recover before reporting

Whichever path ran:

- **No seat returned** (`findings` is empty): the panel didn't run. Say so in one line, naming the missing seats, and stop. Never print a table, `None` or a question: an empty result is a failure, not a clean review.
- **`security` is in `missing`:** rerun just that seat once, with one Agent call (`subagent_type: "fbs:seats:security"`, the prompt in section 4). After the workflow, if it returns, run the judge again with one Agent call on every seat's findings, the new ones included, and use that verdict. If the rerun fails too, the line after the panel line says `**Security seat missing:** this review has no security findings.`
- **`verdict` is `null`:** report the findings anyway, each `undecided` with the reason `the judge didn't run`, and offer to rerun only the judge, with one Agent call (`subagent_type: "fbs:judge"`) given the findings.

## 6. Report

Write one final message with all of this, in order:

1. **Panel line:** `**Panel:** workflow fbs:panel` (or `workflow script`, or `parallel agents, because <why the workflow didn't start>`), plus `Missing: <seats>` when a seat returned nothing.
2. **Findings table**, with every finding from every seat, in seat order:

   ```
   | # | Seat | Severity | Claim | Decision | Reason |
   |---|---|---|---|---|---|
   | pessimist-1 | pessimist | major | <claim> | accepted | <judge's reason> |
   ```

   - Decision is `accepted` or `rejected`, exactly as the judge decided, with the judge's reason.
   - A finding the judge left out is `undecided`, with the reason `the judge didn't decide it`.
   - Shorten a long claim, but keep what it says.
3. **`## Changes to the design`** (or `## Changes to the spec`): the verdict's `changes`, numbered, each with its finding ids. `None` only when the judge ran and `changes` is empty.
4. **Judge's summary:** `**Judge's summary:** <the verdict's summary>`, then every open question it names, one `- Open question: <question>` line each. Never drop them: they are decisions the user still owes.
5. **Uniform verdict**, only when `uniform` is true: `**Uniform verdict:** the judge <accepted|rejected> every finding.` A uniform verdict is a warning sign; say so in the same line.
6. **Disagreement**, only when you think a decision is wrong because the code or the context contradicts it: one `I disagree: <id>, <reason>` line each. The table still shows the judge's decision.
7. **Question**, standalone only, as `fbs:grilling`'s go-ahead question (plain chat text without the question UI), then end your turn:
   - with a verdict: end with `Apply the accepted changes to <document path>?`;
   - without one: end with `Rerun only the judge on these findings?`

### Called from another stage

When a calling skill (such as `architect`) gave you the document, don't ask the question. Hand back to it the panel line, the findings table, the decisions, the changes, and the judge's summary with its open questions, and let it apply the changes and carry on.

### After the user answers

- **Yes:** apply exactly the listed changes to the document, nothing else, and show what changed in a short list.
- **Some of them:** apply only those.
- **No:** leave the document as it is.

## Rules

- Never say the document is approved or ready: approval belongs to the user, in the stage that owns it.
- Standalone: never edit the document before the user says which changes to apply, and don't run `fbs status approve`. Called from a stage, the caller applies the changes and owns the approval.
- Don't add, drop, soften or re-decide findings. The report shows what the seats found and what the judge decided.
