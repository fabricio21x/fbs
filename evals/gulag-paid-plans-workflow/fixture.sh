#!/usr/bin/env bash
# Writes the Deskly CLAUDE.md, the private-pilot context fact, and a Mid spec for paid plans whose Design section has two planted flaws: a portal and phased rollout first, and an unauthenticated Stripe webhook.
set -euo pipefail

git init -q

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

- Size: mid
- Feature: paid-plans

## Problem
Coworking spaces use Deskly for free today. Deskly can't charge them, and nothing records which plan a space pays for.

## Goal and success measure
Coworking spaces pay a monthly subscription through Stripe, and Deskly knows which plan each space is on. Success: all three pilot spaces pay through Stripe, and the plan Deskly shows for each matches its Stripe subscription.

## Users affected
- Space owners, who subscribe and pay.
- The Deskly team, who decide which plan a space is on.

## Scope
- Monthly subscription checkout through Stripe.
- Keep each space's plan in Deskly in sync with its Stripe subscription.
- A way for the Deskly team to control which plan each space is on.

## Out of scope
- Annual billing: nobody asked for it yet.
- Tax invoices: a separate feature.

## Acceptance criteria
- [ ] A space owner can start a monthly subscription through Stripe Checkout.
- [ ] After a successful payment, the space's plan in Deskly matches its Stripe subscription.
- [ ] When a subscription is cancelled, the space goes back to the free plan.
- [ ] The Deskly team can set which plan a space is on.

## Facts
- Three paying customers in a private pilot (.fbs/context.md)
- Payments provider is Stripe (CLAUDE.md)
- Coworking operators with several locations are the first market (CLAUDE.md)

## Assumptions
None

## Open questions
None

## Design

### Impact
- `company` gains the plan and the Stripe ids.
- New `billing/`, `admin/` and `flags/` modules.

### Constraints
- Stripe is the payments provider.

### Decisions
1. **Ship in two phases.** Phase 1 builds an admin portal where the Deskly team assigns plans by hand, plus per-space feature flags to roll plans out space by space. Phase 2 adds Stripe Checkout.
   - Alternative: ship Stripe Checkout directly. Rejected: moving every space onto billing at once is risky, so plans roll out gradually behind flags first.
2. **Stripe tells us about subscription changes through a webhook.** `POST /webhooks/stripe` takes the company id and the price id from the request body and writes `company.plan`. There is no signature verification: the URL is not published anywhere.
   - Alternative: poll Stripe's API every night. Rejected: a space would wait up to a day for its plan.
3. **The admin portal writes `company.plan` directly.** Checkout is hidden unless the `paid-plans` flag is on for the space.

### Data shapes
- `company.plan`: `"free" | "basic" | "pro"`, default `"free"`.
- `company.stripe_customer_id`, `company.stripe_subscription_id`: nullable text.
- `feature_flags`: `(company_id, flag, enabled)`, one row per space and flag.

### File map
```
src/
├── admin/                          # Phase 1: internal portal to assign plans by hand
│   ├── plan-portal.controller.ts
│   └── plan-portal.page.tsx
├── flags/                          # Phase 1: per-space feature flags for the staged rollout
│   ├── flags.service.ts
│   └── flags.repository.ts
└── billing/                        # Phase 2: Stripe Checkout and webhook
    ├── stripe-checkout.ts
    └── stripe-webhook.controller.ts
```

### Test seams
- Unit test `planFromPriceId` for each price id.
- e2e: POST a sample `customer.subscription.updated` event to `/webhooks/stripe` and check `company.plan`.

### Risks
- A Stripe outage delays plan changes.

### Rollout
- Phase 1, week 1: ship the admin portal and flags. The Deskly team assigns plans by hand.
- Phase 2, weeks 2 and 3: ship Stripe Checkout and the webhook. Turn `paid-plans` on for 10% of spaces, then 50%, then all.

### Gulag outcome
(Filled after the gulag.)

## Decision log
- 2026-10-21: Charge a monthly subscription through Stripe. Why: Stripe is the chosen payments provider.
- 2026-10-21: Sized mid. Why: one integration inside existing modules.
MD
