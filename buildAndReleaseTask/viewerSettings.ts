// =============================================================================
// Viewer settings carried inside the attached plan JSON
//
// The Plan Review tab only ever sees the attachment, so per-step display
// options travel as one extra top-level key next to the Terraform fields.
// The key name is a contract with tab/tab.ts (VIEWER_SETTINGS_KEY) — keep both
// in sync.
// =============================================================================

export const VIEWER_SETTINGS_KEY = 'terraform_plan_viewer';

export interface ViewerSettings {
    /** Hide this plan from the tab's plan dropdown when it has no changes. */
    hideNoChangePlans: boolean;
}

/** Return `plan` with viewer settings attached. Non-object plans are returned unchanged. */
export function withViewerSettings(plan: unknown, settings: ViewerSettings): unknown {
    if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return plan;
    return { ...(plan as Record<string, unknown>), [VIEWER_SETTINGS_KEY]: { ...settings } };
}
