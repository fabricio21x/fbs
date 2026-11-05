---
name: principle-guard-the-context
description: "Use when a step needs bulk reading (many files, long logs, large diffs) or hands work to another stage: send the reading to subagents, keep summaries and paths in the main thread, and hand off through files."
user-invocable: false
---

# Guard the context

The main thread's context is where decisions get made. Fill it with raw dumps and the decisions get worse, the session costs more, and old conversation starts steering new work: in one long session, architect skipped loading its own skills.

## When it applies

In the main thread or a stage that orchestrates: before a search across many files, reading a long log or a large diff, and whenever one stage or task hands work to the next. An agent whose task is the reading (a reviewer reading a diff) does it itself.

## The rules

1. **Delegate bulk reading.** A broad search, a long log or a big diff goes to an agent that returns a summary with `path:line`, not the content.
2. **Read ranges, not files.** When you know where to look, read that range. Read a whole file only when you need the whole file.
3. **Keep conclusions, drop dumps.** After a lookup, carry forward what it showed and where, not what it printed.
4. **Hand off through files.** A stage hands the next one documents (spec, design, plan, evidence), never "as we discussed". The next stage starts in a fresh session and reads them.
5. **Brief agents completely.** An agent gets everything it needs in its prompt: the goal, the paths, the constraints, the format of its report. It can't see your conversation.

## The test

The main thread holds decisions, conclusions and paths, not pasted content; and a fresh session given only the stage's files could carry on the work.
