---
type: llm
---

The reviewed spec's Design section has a `POST /webhooks/stripe` handler that sets `company.plan` from the request body with no signature verification.

PASS if an accepted finding requires verifying the Stripe webhook signature (or an equivalent authenticity check) before updating company.plan.
FAIL otherwise.
