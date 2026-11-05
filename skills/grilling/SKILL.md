---
name: grilling
description: "Use when the user asks to be grilled on an idea, plan or design, or when a stage (plan, architect, setup) needs decisions from the user. Asks rounds of up to 4 questions (with the question UI when it is available), each recommending one answer; looks code facts up instead of asking; asks business facts directly and never takes them from code; pushes back once when an answer is wrong."
user-invocable: false
---

# Grilling

Turn an idea into confirmed decisions. Find what is wrong, missing or assumed before anything is built. You are not here to agree.

## Input

- What to grill: an idea, a request or a document, from the user or the calling stage.
- Settled input, when the caller passes it: an approved spec, earlier decisions, a stated what and why. Treat it as settled and don't re-ask it.

## Before the first round

1. Load the `fbs:principle-check-the-facts` skill with the Skill tool. Follow it for every business fact.
2. Read `CLAUDE.md` and `.fbs/context.md` at the project root when they exist. With the user, they are the only sources for business facts.
3. List the unknowns the input depends on, and classify each one:

| Kind | Example | How to settle it |
|---|---|---|
| Code fact | "Which modules read the appointment status?" | Look it up yourself with Read, Grep and Glob. Never ask. For a slow or broad lookup, start a background `fbs:explorer` agent. |
| Business fact | "How many customers are live?" | Read it from `CLAUDE.md` or `.fbs/context.md`. If it is missing or stale, ask. Never infer it from code. |
| Decision | "Offer a freed slot to one client at a time, or to everyone at once?" | Ask, with your recommendation. |

- A business fact is stale when its date is more than `context.staleDays` days old (`.fbs/config.json`, default 30), or when `fbs context check` flags it.
- A business fact that no decision depends on may stay `unconfirmed` without asking.
- Settle a technical point yourself when one option clearly wins and it is cheap to reverse, and list it under **Assuming**. Ask when no option clearly wins or the choice can't be undone.
- Don't ask an empirical question ("which is faster?"). A quick check (one request, one lookup, a few minutes) you may run yourself. Anything longer, or anything left running in the background, is a spike: offer it as a decision with its time and what it would settle, and run it only on the user's go-ahead; otherwise list it as a spike for implementation (architect: in the design's Risks). A spike the approved spec already includes needs no go-ahead. Never write product code here.
- Scope and product behaviour are never yours to settle: ask them, unless settled input already decides them.
- While a background explorer runs, keep working on the questions that don't need its answer. Don't send a round that depends on it until it reports.

## Challenge the premise

Check the input against the code and the context. Does it solve the stated problem? Is there a simpler way? Does anything contradict it? If something is wrong, say it plainly in the first question of the first round. A business or market claim you can't source (what competitors offer, how customers behave) is a question or `unconfirmed`, never a statement. Challenge settled input only this once, and only when code or context contradicts it. Don't praise the idea, and don't agree by default.

If whether the premise holds depends on facts nobody has answered yet, don't turn it into a decision this round. State the concern in one sentence, ask the facts, and hold the premise decision.

Only when the problem or the goal is genuinely unclear, or you challenged the premise, ask about them first. Questions about how the feature behaves depend on them: hold those until they are clear.

## Rounds

- Ask at most 4 questions per round, most important first.
- Ask only frontier questions: ones whose prerequisites are already settled. A question depends on another when a different answer there could make it moot or change its options. Hold it for a later round, and name the held topics in one line.
- Ask with the AskUserQuestion tool when it is available: one call per round. What the user reads first (the **Assuming** block, the stage's opening lines, a correction to their input, what a lookup found) goes in the chat as formatted text in the same message, right before the call: it stays visible above the questions, and it reads better there than in the UI. Thinking is not the chat: write it as text in the message that makes the call, after any other tool call in that message (loading a skill, opening a file). A hook denies an `Assuming`, `Confirm` or `Approve` question, a go-ahead with `Request changes`, or one that points "above", when the message making the call has no text. Without the tool (not available, denied, or no human in the run), write the whole round as plain text in the formats below.

### What a round says

- Write a decision in this format:

```
**Q1. <short title>**
<The question, in one sentence, worded so that "yes" accepts the recommendation.>
- <Option A>: what it is, what it costs, what it changes for the user.
- <Option B>: what it is, what it costs, what it changes for the user.
→ Recommendation: <exactly one option>, because <why>.
```

- Explain each option in plain words, ending with what it changes for the user. An option may name a data shape, a module boundary or a structure when that is the decision being made. Don't write the design or the spec here; that comes after the grilling.
- A question that records a value as the user's preference, not decided here (such as plan's technology preference), has no recommendation: word it as a choice, not yes or no, drop the `→ Recommendation` line, and in AskUserQuestion list the options in neutral order with none marked `(Recommended)`. Every real decision keeps its recommendation.
- A recommendation picks exactly one option. "It depends", "say which" and "tell me" are not recommendations. If the choice depends on an open fact, ask the fact this round and hold the decision.
- Before sending, check the round for dependencies:
  - If a decision's recommendation or reason says "only if", "unless", "provided", "assuming" or "if Q<n>…", the decision depends on an open question.
  - If a business fact in this round would hold a decision, and that decision is also in this round, it depends on the fact.
  - Remove each dependent decision from the round and name it in the held line.
- Write a business fact in this format:

```
**Q2. <short title>** (business fact)
<The fact, asked directly, e.g. "How many customers use the product today?">
→ Recommendation if you don't know: mark it `unconfirmed` and hold <the decisions that wait for it>, because <why>.
```

- Ask one fact per question: "how many customers" and "what stage" are two questions.
- In plain text, every question, decision or fact, ends with a line that starts exactly `→ Recommendation`; keep the formats' wording.
- Never guess the fact, recommend a value for it, or make a choice because it is unknown ("assume X", "plan for one customer", "keep it small since we don't know" all guess).
- The recommendation is one action, with no second action and no "if", its reason included: hold the decisions that wait for the fact, and keep grilling the rest. Recommend an option instead only when it holds whatever the fact turns out to be.
- Show the assumptions the round rests on, but only the lines that are new or changed since the last round; when nothing changed, leave them out:

```
**Assuming:**
1. <business fact> (source: CLAUDE.md | .fbs/context.md | user, <date>)
2. <code fact or technical point> (source: `path:line`)
3. <fact> (unconfirmed)
```

- The lines shown cover every business fact the round asks or relies on, and every technical point you settled yourself, that is new or changed since the last round. A business fact's source is `CLAUDE.md`, `.fbs/context.md` or the user, never a code path. A code fact speaks only about the repository ("the repo has no booking code"), never about the product or the business ("no booking system exists yet", "the product is new"): an empty or small repo says nothing about either.

### With the question UI

- When the **Assuming** block has lines the user can judge better than the code (a business fact, an `unconfirmed` fact, a technical point you settled yourself), the round's first question is the assumptions check. A code fact you looked up, with its `path:line`, is shown in the block but never checked: when only those are new, there is no check.
  - `header`: `Assuming`. `question`: those lines, by their block numbers, each cut to a few words, then the ask: "Assuming 1) fewer than 200 organizations exist; 3) the shared hook lives in `packages/admin`. Do these hold?" It reads on its own; never write "above".
  - At most 3 lines in the check. More than that means the round settled too much by itself: ask the riskiest as their own questions.
  - Options: `Yes, all hold` (Recommended) and `One is wrong`, whose description asks for its number and the correction through "Other". No preview.
  - It takes one of the round's 4 slots. A correction is an answer: record it, and recheck the decisions it touches before the next round.
- Every other question is one decision or fact:
  - `header`: the short title, at most 12 characters. `question`: the one-sentence question.
  - Options: the recommended one first, its label ending ` (Recommended)`, then the others; each `description` says what it costs and what it changes for the user, and the recommended one's also says why it is recommended. Add `preview` when the options are data shapes or structures worth seeing side by side.
  - A business fact's options are the likely answers, plus `I don't know` (Recommended), whose description names the decisions it holds. The user types any other answer through "Other".
- A `preview` is only for comparing options that are shapes (a data structure, a layout), side by side. It sits in a narrow box that shows plain text and doesn't wrap: no Markdown markup, lines broken at about 50 characters. A summary, a list of decisions or facts, or anything being confirmed or approved never goes in a preview: it goes in the chat above the call.
- A challenge to the premise is the round's first decision, in its question and options.
- A question without at least two sensible options (paste a request, name a date, a fact with no likely answers) goes as plain text in the same message, before the call.

### In plain text

- Put the **Assuming** block before the questions, as with the question UI.
- Close the round with one line: answer like "1 yes, 2 no because …"; for a business fact, "yes" means you don't know. This also applies when any question went as plain text next to the call. Then end your turn and wait.

## Approvals and go-aheads

A question that waits on a yes (approving a spec, a design or a change; a go-ahead to apply or run something) goes through the question UI too when it is available, so the user is prompted:

- It is its own call, never inside a round of decisions: a "yes" to a round never counts as an approval.
- `header`: `Approve`, or a short name for the go-ahead. `question`: what is approved and where it lives, e.g. "Approve the amended design (`docs/features/<slug>/design.md`)?", never "shown above".
- Options: `Approve` first, then `Request changes`, whose description asks for them through "Other". What the user needs to judge it, as the calling stage names it (a summary, the Facts and Assumptions, the change), goes in the chat in the same message, right before the call.
- The approval's quote is the answer exactly as the tool returns it: the chosen label plus any note the user added. "Other" text that isn't a clear approval is feedback, not an approval.
- Without the tool, ask in plain text and quote the user's reply.
- **Except a land.** The go-ahead to land a PR is always asked in plain text, as land's "Landing on request" says: only the user's typed `land` reaches the hook that writes the land token, never a question UI answer.

## Answers and pushback

- "Yes", or picking the recommended option, accepts the recommendation. For a business fact, "yes" or `I don't know` means the user doesn't know: record the fact as `unconfirmed` and apply the recommendation. "Yes" to the round does both.
- Record each answer as a decision with its reason.
- When an answer conflicts with the code or the context, or adds scope nothing justifies, reply `I disagree: <reason>` once for that point. Don't push back on answers that are merely different from your recommendation.
- If the user holds their answer, record it with their reason and move on. Never reopen it.
- Don't fake agreement or add praise. Record a fine answer and continue.
- Answers open new questions. Add them to the frontier for the next round.

## End gate

You are done only when no question is left on the frontier and the user confirms. An `unconfirmed` fact that a decision rests on is still a frontier question. Then show:

- **Decisions:** each with its reason, and the principle that changed it, if one did.
- **Facts:** what is confirmed, each with its source.
- **Assumptions:** only what is still unconfirmed, or unknowns the user accepted.

Show the list in the chat and, in the same message, ask the user to confirm it with the approval question (`header`: `Confirm`; no preview; the question names what is confirmed, never "above"). Their confirmation ends the grilling. If a stage skill called you, hand the decisions, facts and assumptions back to it; it writes them into its documents.
