---
name: impact-map
description: "Map everything in this project a change touches: code paths and consumers, APIs, data, jobs, external services, UI, permissions, tests and docs, each with path:line evidence. Use when someone asks what a feature or change would affect, and when a stage (architect) needs the impact map before a design."
user-invocable: false
---

# Impact map

Find every part of the project a change touches, before anyone designs it. A consumer the map misses turns up later as a surprise in the middle of implementation, which is the failure this map exists to prevent.

## Input

- The change: a request, an idea or a spec, from the user or the calling stage.
- A feature directory, when the caller gives one. Then write the map to `<dir>/impact.md` and reply with its path and one line per area. Otherwise the map is your reply.

## 1. Find the key identifiers

1. Read `CLAUDE.md` at the project root when it exists, then the `CLAUDE.md` of each workspace the change starts in and the feature doc it points to.
2. Note the repo layout: the workspaces, and where generated code lives (API clients, API types, migrations).
3. Locate where the change starts with Grep and Glob, and Read only those files. Never list the whole repo (`**/*`); take the layout from the CLAUDE.md files. Finding the consumers is the explorers' job, not yours.
4. List the key identifiers the change touches, each with its `path:line`:
   - types, functions, constants and their exported names;
   - tables, columns and the string values stored in them;
   - routes, request and response fields, events, queues, env vars and config keys.

Include the stored form of the data (a column name, a literal value), not only the code name: code that skips the module and reads the data directly is the consumer that gets missed. Search a stored literal together with its column (`plan = 'pro'`), never the bare word.

When the change adds something that doesn't exist yet, list the existing identifiers it will hook into, read or change: the entity it attaches to, the flow it extends, the screen that will show it.

## 2. Explore, one explorer per lens

Start four `fbs:explorer` agents **in one message**, as parallel Agent calls with `subagent_type: "fbs:explorer"`. Never one after another. Start them however small the repository is: a map built from the files you expected to matter misses the ones you didn't. The one exception is a repo with no code yet (below).

| Lens | What the explorer looks for |
|---|---|
| Code paths and consumers | Every importer and caller of the key identifiers, the logic that depends on their value, and what it computes from it. Cross process boundaries: HTTP routes and their callers, request and response field names, generated API clients and types, queue and event payloads. |
| Data, jobs and external services | Tables and columns, queries that read or write the data directly, migrations, scheduled jobs, queues, webhooks and third-party APIs. |
| UI and permissions | Screens and components that show or change the data, and the roles and checks that decide who may change it. |
| Tests and docs | Tests and fixtures that pin today's behaviour, and living docs that describe it: `CLAUDE.md` files, feature docs, current specs. Not dated historical plans. |

Give each explorer:

- the change, in one or two sentences;
- the repo layout from step 1;
- the key identifiers with their `path:line`;
- its lens, and only that lens;
- this instruction: "Follow re-exports, aliases, barrel files and wrappers (`export { a as b }`, `index.ts`), and search for every new name you find, until no new name appears. For each finding, say what in it depends on the change. Keep the report under 60 lines: at most three Evidence lines per file, the most telling ones; under Checked, nothing found, list directories rather than every file in them."

**Wait for all four reports before merging.** Never merge a partial set, and never draft rows from your own reads while explorers run. If the session can't wait and the turn must end, end it with one line naming the explorers still running, and continue at the merge only when the last report has arrived.

Only if the Agent tool is not available to you at all, work each lens yourself, in the same order, and say so in one line above the map.

**No code yet:** when a Glob for source files (`**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rb,java,kt,rs,swift,php,cs,sql}`) finds none outside `node_modules/`, there is nothing for explorers to search; Markdown, manifests and config don't count. Skip them and the completeness pass, build the table from the docs and the external services they name (each row's evidence a doc `path:line`), and say so in one line above the map.

## 3. Merge into the table

One row per place the change touches:

- **Area:** Code, API, Data, Job, External service, UI, Permissions, Test or Doc.
- **What:** the thing at that place, in a few words (`sendReminder`, the nightly invoice export).
- **Evidence:** one or more `path:line`, taken from an explorer's Evidence or from your own Read. A row with no `path:line` is dropped.
- **Why it matters:** what the code does with the change, concretely ("the export reads `invoices.total` directly, so a new discount column never reaches the accountant's file"). Never user counts, traffic, scale or product stage: those are business facts, and they go under `## Open`.

Merge rows that point at the same place. A file that only shares a word with the change (the same name used for something else) is not touched: it goes under Checked, not touched, never in the table.

## 4. Completeness pass

After the merge, start one more `fbs:explorer`. Give it:

- every key identifier, every alias and re-exported name the explorers found, and the stored forms of the data;
- the table rows, each as its `path:line` and What.

Ask it for every place missing from the table, including new lines in files the table already lists. Wait for its report as in step 2, then merge its additions with the same rules.

If its report names new aliases, start one more explorer for the new names only. Stop when a pass adds no row, and after at most two extra passes.

## 5. Checked, not touched

List the paths a reader would expect to be touched but aren't: files that matched a key name or word without depending on the change, and the usual homes of each lens that came up empty (the migrations folder, the generated API client). A directory counts as a path.

- Each line is `- <path>` and nothing else: no line number, no comment, no reason, no parenthesis.
- A path that is in the table is never listed here, not even for its other symbols.
- Only paths that exist. Kinds of things the project lacks ("no tests", "no migrations") go in one sentence above the map, not here.

## Output

```
## Impact map: <the change in a few words>

| Area | What | Evidence | Why it matters |
|---|---|---|---|
| <area> | <what> | `path:line` | <what the code does with this change> |

## Checked, not touched
- <path>
```

- The table comes first, then `## Checked, not touched`. Add `## Open` after them only when an explorer reported something the code can't answer, such as a business fact or an intent nobody recorded; Open items carry no `path:line`.
- The calling stage moves Open items into its own open questions.
- Never write a `path:line` for a file that is not in the table.
- Map, don't design. Say what is touched and why; leave how to change it to the design.
