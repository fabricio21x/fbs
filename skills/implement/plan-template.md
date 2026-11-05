# Plan: <title>

- Feature: <slug>
- Branch: <branch>, from <parent>, branch base <base> (from `fbs branch <slug>`)
- Test command: `<command>`; type check: `<command>` or none
- Baseline: <tests that already failed before any change, or None>
- Workers: <one at a time | up to N in parallel worktrees>, because <the scope check in one line>

<!-- The task graph built from the design's file map and test seams. Each task is the smallest unit a reviewer can judge on its own: one behaviour, its tests, the files it needs. Order tasks so each one's dependencies come first. Status is todo, done, blocked or escalated; this file is updated and committed as tasks finish, so a new session can resume from it. -->

## Tasks

### T1: <goal in a few words>
- Serves: <acceptance criteria, quoted short, or "setup">
- Files: <paths>
- Depends on: <task ids, or none>
- UI: <yes when it builds or changes a screen, else no>
- Status: todo
- Review: <verdict and fix rounds, filled in when done>
- Notes: <non-blocking findings and deviations, filled in when done>

## Final review
- Status: todo
- Review: <verdict and fix rounds>
- Notes: <non-blocking findings>

## Escalations
<!-- Findings still blocking after two fix rounds, and blocked tasks with the decision each needs; or None. -->
