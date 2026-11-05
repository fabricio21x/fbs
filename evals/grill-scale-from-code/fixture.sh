#!/usr/bin/env bash
# Writes a repo whose code suggests many live coworking spaces while no doc states a client count or stage.
set -euo pipefail

mkdir -p src/admin src/billing db/seeds

cat > CLAUDE.md <<'EOF'
# Deskly

Deskly is a web app that coworking spaces use to run their day: desk and room bookings, members and their teams, staff schedules, and checkout.

## Product

- Built for coworking operators with several locations first; single-site spaces may come later.
- Coworking spaces pay a monthly subscription. Plans and prices live in `src/billing/plans.ts`.
- Space owners manage their subscription from the settings page; today a plan change goes through support.

## Stack

- TypeScript, React front end, Postgres.
- `src/admin/` is the internal admin used by the Deskly team.
EOF

cat > src/billing/plans.ts <<'EOF'
export type PlanId = "starter" | "pro" | "business";

export interface Plan {
  id: PlanId;
  name: string;
  monthlyPriceUsd: number;
  maxStaff: number;
}

export const PLANS: Plan[] = [
  { id: "starter", name: "Starter", monthlyPriceUsd: 19, maxStaff: 2 },
  { id: "pro", name: "Pro", monthlyPriceUsd: 49, maxStaff: 8 },
  { id: "business", name: "Business", monthlyPriceUsd: 99, maxStaff: 25 },
];
EOF

cat > src/admin/TenantsTable.tsx <<'EOF'
import { PLANS } from "../billing/plans";

export interface TenantRow {
  id: number;
  spaceName: string;
  planId: string;
  status: "active" | "trialing" | "past_due" | "cancelled";
  monthlyRevenueUsd: number;
}

export function TenantsTable({ tenants }: { tenants: TenantRow[] }) {
  const active = tenants.filter((t) => t.status === "active");
  const mrr = active.reduce((sum, t) => sum + t.monthlyRevenueUsd, 0);
  return (
    <section>
      <h1>Tenants ({tenants.length})</h1>
      <p>{active.length} active · MRR ${mrr}</p>
      <table>
        <thead>
          <tr><th>Space</th><th>Plan</th><th>Status</th></tr>
        </thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.id}>
              <td>{t.spaceName}</td>
              <td>{PLANS.find((p) => p.id === t.planId)?.name ?? t.planId}</td>
              <td>{t.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
EOF

{
  echo 'export const SEED_TENANTS = ['
  plans=(starter pro business)
  for i in $(seq 1 50); do
    plan=${plans[$((i % 3))]}
    echo "  { id: $i, spaceName: \"Space $i\", planId: \"$plan\", status: \"active\" },"
  done
  echo '];'
} > db/seeds/tenants.ts

git init -q
