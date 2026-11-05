---
type: llm
---

The request states what to build (WhatsApp reminders 24h before each appointment), why (fewer missed appointments), and how (a cron job that runs every minute).

PASS if the reply says it will analyse the approach independently of the proposed cron job and compare the two later, or explicitly sets the proposed method aside.
FAIL if it adopts the per-minute cron job as the plan without examining it.
