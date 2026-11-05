#!/usr/bin/env bash
# Writes a TypeScript tree whose plan consumers hide behind two aliased re-exports and a raw SQL column, among many files that only share the word.
set -euo pipefail

git init -q
mkdir -p src/billing src/bookings src/jobs src/ui/settings src/auth src/members src/shared src/reports docs src/space/floors src/members/seating

cat > src/db.ts <<'EOF'
export interface Db {
  one<T>(sql: string, params: unknown[]): Promise<T>;
  many<T>(sql: string, params: unknown[]): Promise<T[]>;
  count(sql: string, params: unknown[]): Promise<number>;
  exec(sql: string, params: unknown[]): Promise<void>;
}

export declare const db: Db;
EOF

cat > src/billing/plan.ts <<'EOF'
import { db } from "../db";

export type Plan = "free" | "pro";

export async function getCompanyPlan(companyId: number): Promise<Plan> {
  const row = await db.one<{ plan: Plan }>("select plan from companies where id = $1", [companyId]);
  return row.plan;
}
EOF

cat > src/billing/index.ts <<'EOF'
export type { Plan as Tier } from "./plan";
export { getCompanyPlan as resolveTier } from "./plan";
EOF

cat > src/bookings/limits.ts <<'EOF'
import { resolveTier, type Tier } from "../billing";
import { db } from "../db";

const MONTHLY_CAP: Record<Tier, number> = { free: 40, pro: Number.POSITIVE_INFINITY };

export async function canBookDesk(companyId: number, startsAt: Date): Promise<boolean> {
  const tier = await resolveTier(companyId);
  const monthStart = new Date(startsAt.getFullYear(), startsAt.getMonth(), 1);
  const booked = await db.count(
    "select count(*) from bookings where company_id = $1 and starts_at >= $2",
    [companyId, monthStart],
  );
  return booked < MONTHLY_CAP[tier];
}
EOF

cat > src/jobs/trial-expiry.ts <<'EOF'
import { db } from "../db";

export const schedule = "0 2 * * *";

export async function run(now: Date): Promise<void> {
  const ended = await db.many<{ id: number }>(
    "select id from companies where plan = 'pro' and trial_ends_at < $1",
    [now],
  );
  for (const company of ended) {
    await db.exec("update companies set plan = 'free', trial_ends_at = null where id = $1", [company.id]);
  }
}
EOF

cat > src/ui/settings/PlanCard.tsx <<'EOF'
import type { Tier } from "../../billing";

const LABELS: Record<Tier, string> = { free: "Free", pro: "Pro" };

export function PlanCard({ tier, renewsOn }: { tier: Tier; renewsOn: string }) {
  return (
    <section>
      <h2>Your plan: {LABELS[tier]}</h2>
      <p>Renews on {renewsOn}</p>
    </section>
  );
}
EOF

cat > src/auth/permissions.ts <<'EOF'
export type Role = "owner" | "host" | "receptionist";

export function canChangePlan(role: Role): boolean {
  return role === "owner";
}

export function canEditSchedule(role: Role): boolean {
  return role !== "host";
}
EOF

cat > src/members/list.ts <<'EOF'
import { db } from "../db";

export interface MemberRow {
  id: number;
  name: string;
  teamName: string;
  seatingPlan: string | null;
}

export async function listMembers(companyId: number): Promise<MemberRow[]> {
  return db.many<MemberRow>(
    'select id, name, team_name as "teamName", seating_plan as "seatingPlan" from members where company_id = $1 order by name',
    [companyId],
  );
}
EOF

cat > src/shared/index.ts <<'EOF'
export { resolveTier as currentTier } from "../billing";
EOF

cat > src/reports/revenue.ts <<'EOF'
import { currentTier } from "../shared";

const MONTHLY_PRICE = { free: 0, pro: 49 } as const;

export async function monthlyRevenue(companyIds: number[]): Promise<number> {
  let total = 0;
  for (const companyId of companyIds) {
    total += MONTHLY_PRICE[await currentTier(companyId)];
  }
  return total;
}
EOF

cat > src/bookings/limits.test.ts <<'EOF'
import { describe, expect, it } from "bun:test";
import { canBookDesk } from "./limits";

describe("canBookDesk", () => {
  it("stops a company on the free plan at 40 bookings in the month", async () => {
    expect(await canBookDesk(1, new Date("2026-03-15"))).toBe(false);
  });

  it("never stops a company on the pro plan", async () => {
    expect(await canBookDesk(2, new Date("2026-03-15"))).toBe(true);
  });
});
EOF

cat > docs/billing.md <<'EOF'
# Billing

Each company is on one plan, `free` or `pro`, stored in `companies.plan`.

- The free plan allows 40 bookings per calendar month; pro has no cap.
- A plan change takes effect on the first day of the next month.
- Trials end at 02:00, when the nightly job moves the company back to free.
EOF

for i in $(seq -w 1 100); do
  cat > "src/space/floors/floor-$i.ts" <<EOF
export interface FloorPlan$i {
  desks: number;
  phoneBooths: number;
}

export const floorPlan$i: FloorPlan$i = { desks: $((10#$i % 4 + 1)), phoneBooths: $((10#$i % 3 + 1)) };
EOF
  cat > "src/members/seating/seating-$i.ts" <<EOF
export interface SeatingPlan$i {
  memberId: number;
  rotateEveryWeeks: number;
}

export function seatingPlan$i(memberId: number): SeatingPlan$i {
  return { memberId, rotateEveryWeeks: $((10#$i % 6 + 2)) };
}
EOF
done
