#!/usr/bin/env bash
# Writes the impact-map plan tree, the Deskly CLAUDE.md, the private-pilot context fact, and an approved Big spec for paid plans with its feature record.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../impact-map-plan-switch/fixture.sh"

cat > CLAUDE.md <<'MD'
Deskly: booking app for coworking spaces.
Target: coworking operators with several locations; single-site spaces may come later.
Payments provider: Stripe.
MD

mkdir -p .fbs
echo "- Private pilot with 3 paying customers. ($(date +%F), alex)" > .fbs/context.md

dir=docs/features/2026-10-21-paid-plans
mkdir -p "$dir"

cat > "$dir/spec.md" <<'MD'
# Paid plans through Stripe

- Size: big
- Feature: paid-plans

## Problem
Coworking spaces use the pro plan without paying: Deskly can't charge them, and the only way a space reaches pro today is a trial that the nightly job ends.

## Goal and success measure
Coworking spaces pay a monthly pro subscription through Stripe, and the plan Deskly applies to each space matches what it pays for. Success: all three pilot spaces pay through Stripe, and the plan Deskly shows and enforces for each matches its Stripe subscription.

## Users affected
- Space owners, who subscribe, pay and cancel.
- The Deskly team, who decide which plan a space is on.

## Scope
- Monthly pro subscription checkout through Stripe.
- Keep each space's plan in Deskly in sync with its Stripe subscription.
- A way for the Deskly team to control which plan each space is on.

## Out of scope
- Annual billing: nobody asked for it yet.
- Tax invoices: a separate feature.
- New plans beyond free and pro: pricing isn't settled.

## Acceptance criteria
- [ ] A space owner can start a monthly pro subscription through Stripe Checkout.
- [ ] After a successful payment, the space's plan in Deskly matches its Stripe subscription.
- [ ] When a subscription is cancelled, the space goes back to the free plan at the end of the paid period.
- [ ] The Deskly team can set which plan a space is on.
- [ ] Only a space owner can start or cancel the space's subscription.

## Facts
- Three paying customers in a private pilot (.fbs/context.md)
- Payments provider is Stripe (CLAUDE.md)
- Coworking operators with several locations are the first market (CLAUDE.md)

## Assumptions
None

## Open questions
None

## Design
(Mid only; written by /fbs:architect)

## Decision log
- 2026-10-21: Charge a monthly subscription through Stripe. Why: Stripe is the chosen payments provider.
- 2026-10-21: Keep the two existing plans, free and pro. Why: pricing for other plans isn't settled.
- 2026-10-21: Sized big. Why: payments and an external integration.
MD

sha="$(shasum -a 256 "$dir/spec.md" | cut -d ' ' -f 1)"
mkdir -p .git/fbs/features
cat > .git/fbs/features/paid-plans.json <<JSON
{
  "slug": "paid-plans",
  "dir": "$dir",
  "size": "big",
  "approvals": {
    "spec": { "at": "$(date +%F)", "quote": "approved", "sha256": "$sha" }
  },
  "pr": null
}
JSON
