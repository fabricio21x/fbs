---
name: principle-smallest-change
description: "Use when sizing a change, choosing a structure or reviewing scope: prefer the smallest change and the simplest structure, and bias to deletion. Cuts abstractions with one caller and machinery for scale the business facts don't show."
user-invocable: false
---

# Smallest change

Every piece a design adds is built, tested, read and maintained, and most of it is hard to take back. A design once put an admin portal and a customer-by-customer rollout ahead of the payment integration for a product with two beta clients; a day of work shipped and never ran.

## When it applies

When you size a change, choose a structure or a file layout, or review a spec or design for scope. Also whenever a piece of the work exists "for later", "to be safe" or "in case it grows".

## The rules

1. **Prefer deletion.** Before adding, ask whether removing or reusing something meets the need. A change that deletes code is the best change.
2. **One caller needs no abstraction.** No interface, base class, registry, factory or config switch until a second caller exists. Write it inline; extract it when the second one arrives.
3. **No machinery for scale the business facts don't show.** Admin portals, feature flags, phased or percentage rollouts, queues, caches and backfills each need a sourced business fact that calls for them (user count, stage, load). With few users, a one-off manual step or the provider's own dashboard wins. Source the facts as `principle-check-the-facts` says; never take scale from code.
4. **The simplest structure a reader can follow wins.** Fewer layers, files and folders, unless a reader gains more than the extra hop costs. Name what the reader gains.
5. **Cut to the spec.** Build what the spec's acceptance criteria require. Anything else is a separate decision for the user, offered with its cost, never added silently.

## The test

For each piece the change adds (file, module, table, flag, screen, phase), name what would break or which acceptance criterion would fail if it were removed. If nothing would, remove it, or ask the user to keep it with its cost stated.
