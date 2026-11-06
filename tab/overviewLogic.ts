// =============================================================================
// All-plans overview — pure summary, row-building, and filtering helpers.
//
// Used by the tab renderer when a build has more than one plan attachment.
// The overview lists every resource change across all plans on one page,
// each tagged with the plan it came from. Kept free of DOM so the defaults
// and filters can be unit-tested.
// =============================================================================

import {
    type ActionKind,
    type ResourceChange,
    classifyAction,
    countResourceChanges,
    countsHaveChanges,
    emptyCounts,
} from './planLogic';

/**
 * Sentinel <option> value for the combined overview.
 * Empty string is not a legal task attachmentName (`VALID_NAME` requires 1+
 * `[A-Za-z0-9_-]` chars) and cannot collide with {@link planId}.
 */
export const ALL_PLANS_VALUE = '';

/** Stable identity for a plan attachment across duplicate display names. */
export function planId(ref: { name: string; timelineId?: string; recordId?: string }): string {
    return `${ref.timelineId ?? ''}\t${ref.recordId ?? ''}\t${ref.name}`;
}

/**
 * Top-level key the task adds to the attached plan JSON for display settings.
 * Contract with buildAndReleaseTask/viewerSettings.ts — keep both in sync.
 */
export const VIEWER_SETTINGS_KEY = 'terraform_plan_viewer';

export interface ViewerSettings {
    hideNoChangePlans?: boolean;
}

export type LoadStatus = 'pending' | 'loaded' | 'error';

export interface PlanSummary {
    id: string;
    name: string;
    status: LoadStatus;
    counts: Record<ActionKind, number>;
    /** True when any resource or output would change. Unknown while pending. */
    hasChanges: boolean | null;
    terraformVersion?: string;
    /** The task step asked for this plan to be hidden from the dropdown when it has no changes. */
    hideWhenNoChanges?: boolean;
    error?: string;
}

export interface OverviewFilter {
    search: string;
    actionFilters: ReadonlySet<ActionKind>;
    /** No-op resources are hidden unless this is on (same as the single-plan view). */
    showNoop: boolean;
}

/** One resource change in the combined list, tagged with its source plan. */
export interface ResourceRow {
    /** Unique across all plans; stable across re-renders (used for open state and focus). */
    key: string;
    planId: string;
    /** Display label for the plan, including any duplicate-name suffix. */
    planLabel: string;
    resource: ResourceChange;
    kind: ActionKind;
}

/**
 * Short suffixes that tell apart attachments sharing a display name (e.g. two
 * jobs both publishing `prod`). Keyed by {@link planId}; plans with a unique
 * name get no entry.
 */
export function duplicateNameSuffixes(
    refs: Array<{ name: string; timelineId?: string; recordId?: string }>,
): Map<string, string> {
    const nameCounts = new Map<string, number>();
    for (const r of refs) nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1);
    const out = new Map<string, string>();
    for (const r of refs) {
        if ((nameCounts.get(r.name) ?? 0) > 1 && r.recordId) {
            out.set(planId(r), ` (${r.recordId.slice(0, 8)})`);
        }
    }
    return out;
}

export function shouldShowOverview(planCount: number): boolean {
    return planCount > 1;
}

export function defaultSelectorValue(refs: Array<{ name: string; timelineId?: string; recordId?: string }>): string {
    if (refs.length > 1) return ALL_PLANS_VALUE;
    return refs[0] ? planId(refs[0]) : ALL_PLANS_VALUE;
}

export function pendingSummary(name: string, id: string = name): PlanSummary {
    return {
        id,
        name,
        status: 'pending',
        counts: emptyCounts(),
        hasChanges: null,
    };
}

export function loadedSummary(
    name: string,
    plan: {
        resource_changes?: ResourceChange[];
        terraform_version?: string;
        output_changes?: Record<string, { actions: string[] }>;
        [VIEWER_SETTINGS_KEY]?: ViewerSettings;
    },
    id: string = name,
): PlanSummary {
    // Attachments are JSON.parse'd; a non-array here would throw inside
    // countResourceChanges (string is iterable) and must not be treated as a
    // successful load.
    const resources = Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
    const counts = countResourceChanges(resources);
    return {
        id,
        name,
        status: 'loaded',
        counts,
        hasChanges: countsHaveChanges(counts) || outputsHaveChanges(plan.output_changes),
        terraformVersion: plan.terraform_version,
        hideWhenNoChanges: plan[VIEWER_SETTINGS_KEY]?.hideNoChangePlans === true,
    };
}

export function errorSummary(name: string, error: string, id: string = name): PlanSummary {
    return {
        id,
        name,
        status: 'error',
        counts: emptyCounts(),
        hasChanges: null,
        error,
    };
}

function outputsHaveChanges(outputs: Record<string, { actions: string[] }> | undefined): boolean {
    if (!outputs) return false;
    return Object.values(outputs).some(o => {
        const kind = classifyAction(o.actions);
        return kind !== 'noop' && kind !== 'read';
    });
}

export function uniqueTerraformVersions(summaries: PlanSummary[]): string[] {
    const set = new Set<string>();
    for (const s of summaries) {
        if (s.status === 'loaded' && s.terraformVersion) set.add(s.terraformVersion);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
}

// --------------------------- Plan dropdown filter ---------------------------

/**
 * Default for the tab's "Hide plans without changes" checkbox: on when any
 * loaded plan's task step set `hideNoChangePlans`. Plans from one pipeline
 * loop normally share the setting, so "any" and "all" agree in practice.
 */
export function defaultHideNoChangePlans(summaries: Iterable<PlanSummary>): boolean {
    for (const s of summaries) {
        if (s.status === 'loaded' && s.hideWhenNoChanges) return true;
    }
    return false;
}

/**
 * True once any loaded plan is known to have no changes. Until then the
 * "Hide plans without changes" checkbox would have nothing to hide, so the tab
 * keeps it out of view.
 */
export function anyPlanWithoutChanges(summaries: Iterable<PlanSummary>): boolean {
    for (const s of summaries) {
        if (s.status === 'loaded' && s.hasChanges === false) return true;
    }
    return false;
}

/**
 * Plan ids to leave out of the dropdown. Only loaded plans known to have no
 * changes are hidden; pending and failed plans stay listed. `keepId` (the plan
 * currently shown) always stays so the dropdown never loses its selection.
 */
export function plansHiddenFromSelector(
    summaries: Iterable<PlanSummary>,
    hide: boolean,
    keepId?: string,
): Set<string> {
    const out = new Set<string>();
    if (!hide) return out;
    for (const s of summaries) {
        if (s.status === 'loaded' && s.hasChanges === false && s.id !== keepId) out.add(s.id);
    }
    return out;
}

// ------------------------------ Resource rows -------------------------------

/**
 * Flatten loaded plans into one list of resource rows, in plan order and then
 * each plan's own resource order. Plans not yet loaded contribute nothing.
 */
export function buildResourceRows(
    plans: Array<{ id: string; label: string; resources: ResourceChange[] }>,
): ResourceRow[] {
    const rows: ResourceRow[] = [];
    for (const p of plans) {
        const resources = Array.isArray(p.resources) ? p.resources : [];
        const seen = new Map<string, number>();
        for (const r of resources) {
            // Addresses are unique within a plan except for deposed objects;
            // a counter keeps keys unique without depending on that.
            const n = seen.get(r.address) ?? 0;
            seen.set(r.address, n + 1);
            rows.push({
                key: `${p.id}\n${r.address}${n ? `\n${n}` : ''}`,
                planId: p.id,
                planLabel: p.label,
                resource: r,
                kind: classifyAction(r.change.actions),
            });
        }
    }
    return rows;
}

/** Search matches resource address, resource type, or the plan's name. */
export function rowMatches(row: ResourceRow, filter: OverviewFilter): boolean {
    if (row.kind === 'noop' && !filter.showNoop) return false;
    if (filter.actionFilters.size > 0 && !filter.actionFilters.has(row.kind)) return false;
    const q = filter.search.trim().toLowerCase();
    if (!q) return true;
    return row.resource.address.toLowerCase().includes(q)
        || row.resource.type.toLowerCase().includes(q)
        || row.planLabel.toLowerCase().includes(q);
}

export function noopRowCount(rows: ResourceRow[]): number {
    return rows.filter(r => r.kind === 'noop').length;
}
