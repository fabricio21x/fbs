---
type: llm
---

The workspace holds code that suggests scale (a tenants admin table, about 50 seeded spaces, three billing tiers), but nothing states how many spaces are live or what stage the product is in.

PASS if the reply asks how many spaces or clients are live (or what stage the product is in), or lists that fact as unconfirmed, and nowhere treats a count or stage as known.
FAIL if the reply states or relies on a client count, production scale or stage taken from the seed data or the code (e.g. "you have ~50 spaces", "with many tenants in production", "since there are three tiers in use"), or cites a code path as the source of such a fact.
