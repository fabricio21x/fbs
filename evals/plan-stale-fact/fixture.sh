#!/usr/bin/env bash
# Same as plan-payments-with-context, but the private-pilot fact is dated 60 days ago, so it is stale.
set -euo pipefail

git init -q

cat > CLAUDE.md <<'MD'
Deskly: booking app for coworking spaces.
Target: coworking operators with several locations; single-site spaces may come later.
Payments provider: Stripe.
MD

mkdir -p src/spaces src/billing db/seeds

cat > src/spaces/space.ts <<'TS'
import type { PlanId } from "../billing/plan";

export interface Space {
  id: number;
  name: string;
  city: string;
  plan: PlanId;
  createdAt: string;
}
TS

cat > src/billing/plan.ts <<'TS'
export type PlanId = "free" | "basic" | "pro";

export interface Plan {
  id: PlanId;
  name: string;
  monthlyPriceEur: number;
}

export const PLANS: Plan[] = [
  { id: "free", name: "Free", monthlyPriceEur: 0 },
  { id: "basic", name: "Basic", monthlyPriceEur: 15 },
  { id: "pro", name: "Pro", monthlyPriceEur: 35 },
];
TS

{
  echo 'import type { Space } from "../../src/spaces/space";'
  echo ''
  echo 'export const SEED_SPACES: Space[] = ['
  plans=(free basic pro)
  cities=(Madrid Barcelona Valencia Seville)
  for i in $(seq 1 40); do
    echo "  { id: $i, name: \"Space $i\", city: \"${cities[$((i % 4))]}\", plan: \"${plans[$((i % 3))]}\", createdAt: \"2026-01-01\" },"
  done
  echo '];'
} > db/seeds/spaces.ts

mkdir -p .fbs
echo "- Private pilot with 3 paying customers. ($(date -v-60d +%F), alex)" > .fbs/context.md
