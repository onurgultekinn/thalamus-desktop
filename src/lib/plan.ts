import type { PlanId, User } from '../types';

// Subscription plan infrastructure.
//
// The app runs entirely on-device/offline and there is currently no payment or
// subscription system. The plan feature is therefore kept OFF at release: the
// plan row is not shown in the UI and no plan is written to the profile. Once
// billing is wired up, the only thing to do is set PLAN_FEATURE_ENABLED to
// true and, if needed, add a new plan to the PLANS catalog.

export interface PlanInfo {
  id: PlanId;
  name: string;   // "Free" | "Pro" | "Team"
  label: string;  // full label shown in the UI: "Free plan"
}

/** Registered plan catalog — add a row here to introduce a real plan. */
export const PLANS: Record<PlanId, PlanInfo> = {
  free: { id: 'free', name: 'Free', label: 'Free plan' },
  pro: { id: 'pro', name: 'Pro', label: 'Pro plan' },
  team: { id: 'team', name: 'Team', label: 'Team plan' },
};

/** Off at release. Set to true once subscription/server support is wired up. */
export const PLAN_FEATURE_ENABLED = false;

export const DEFAULT_PLAN: PlanId = 'free';

/** Safely falls back to the default plan for an unknown or missing value. */
export function resolvePlan(value: string | null | undefined): PlanInfo {
  return value && Object.prototype.hasOwnProperty.call(PLANS, value)
    ? PLANS[value as PlanId]
    : PLANS[DEFAULT_PLAN];
}

/**
 * Plan label to show in the UI. Returns null while the feature is off; the
 * caller should then show some other information instead of the plan row.
 */
export function visiblePlanLabel(user: User | null | undefined): string | null {
  if (!PLAN_FEATURE_ENABLED) return null;
  return resolvePlan(user?.plan).label;
}
