// =============================================================================
// All-plans overview — pure grouping, filtering, and selection helpers.
//
// Used by the tab renderer when a build has more than one plan attachment.
// Kept free of DOM so the defaults, grouping, and filters can be unit-tested.
// =============================================================================

import {
    type ActionKind,
    type ResourceChange,
    classifyAction,
    countResourceChanges,
    countsHaveChanges,
    emptyCounts,
} from './planLogic';

/** Sentinel <option> value for the combined overview. Not a legal task attachmentName. */
export const ALL_PLANS_VALUE = '__all__';

const ACTION_PRIORITY: ActionKind[] = ['delete', 'recreate', 'update', 'create'];

export type LoadStatus = 'pending' | 'loaded' | 'error';

export interface PlanSummary {
    name: string;
    status: LoadStatus;
    counts: Record<ActionKind, number>;
    /** True when any resource or output would change. Unknown while pending. */
    hasChanges: boolean | null;
    /** Lowercased blob of name + resource addresses/types for search. */
    haystack: string;
    terraformVersion?: string;
    error?: string;
}

export interface PlanGroup {
    /** Empty string means the list is flat (grouping did not help). */
    key: string;
    items: Array<{ name: string; label: string }>;
}

export interface OverviewFilter {
    search: string;
    onlyWithChanges: boolean;
    actionFilters: ReadonlySet<ActionKind>;
}

export function shouldShowOverview(planCount: number): boolean {
    return planCount > 1;
}

export function defaultSelectorValue(refs: Array<{ name: string }>): string {
    if (refs.length > 1) return ALL_PLANS_VALUE;
    return refs[0]?.name ?? '';
}

export function pendingSummary(name: string): PlanSummary {
    return {
        name,
        status: 'pending',
        counts: emptyCounts(),
        hasChanges: null,
        haystack: name.toLowerCase(),
    };
}

export function loadedSummary(
    name: string,
    plan: {
        resource_changes?: ResourceChange[];
        terraform_version?: string;
        output_changes?: Record<string, { actions: string[] }>;
    },
): PlanSummary {
    const counts = countResourceChanges(plan.resource_changes ?? []);
    const haystack = [
        name,
        ...(plan.resource_changes ?? []).flatMap(r => [r.address, r.type]),
    ].join('\n').toLowerCase();
    return {
        name,
        status: 'loaded',
        counts,
        hasChanges: countsHaveChanges(counts) || outputsHaveChanges(plan.output_changes),
        haystack,
        terraformVersion: plan.terraform_version,
    };
}

export function errorSummary(name: string, error: string): PlanSummary {
    return {
        name,
        status: 'error',
        counts: emptyCounts(),
        hasChanges: null,
        haystack: name.toLowerCase(),
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

export function dominantAction(counts: Record<ActionKind, number>): ActionKind | null {
    for (const k of ACTION_PRIORITY) {
        if (counts[k] > 0) return k;
    }
    return null;
}

export function uniqueTerraformVersions(summaries: PlanSummary[]): string[] {
    const set = new Set<string>();
    for (const s of summaries) {
        if (s.status === 'loaded' && s.terraformVersion) set.add(s.terraformVersion);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
}

export function shouldShowPlan(summary: PlanSummary, filter: OverviewFilter): boolean {
    if (filter.onlyWithChanges && summary.status === 'loaded' && summary.hasChanges === false) {
        return false;
    }
    if (!matchesSearch(summary, filter.search)) return false;
    if (summary.status === 'loaded' && !matchesActionFilter(summary, filter.actionFilters)) {
        return false;
    }
    return true;
}

function matchesSearch(summary: PlanSummary, search: string): boolean {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return summary.haystack.includes(q);
}

function matchesActionFilter(summary: PlanSummary, filters: ReadonlySet<ActionKind>): boolean {
    if (filters.size === 0) return true;
    for (const k of ACTION_PRIORITY) {
        if (filters.has(k) && summary.counts[k] > 0) return true;
    }
    return false;
}

export function hiddenNoChangeCount(summaries: PlanSummary[], filter: OverviewFilter): number {
    if (!filter.onlyWithChanges) return 0;
    let n = 0;
    for (const s of summaries) {
        if (s.status !== 'loaded' || s.hasChanges !== false) continue;
        // Count plans the toggle hid, even if search would also hide them.
        n++;
    }
    return n;
}

// ------------------------------ Grouping ------------------------------------

interface ParsedName {
    name: string;
    parts: string[];
    join: string;
}

function splitPlanName(name: string): ParsedName {
    if (/[\\/]/.test(name)) {
        return { name, parts: name.split(/[\\/]+/).filter(Boolean), join: '/' };
    }
    return { name, parts: name.split('-').filter(Boolean), join: '-' };
}

function bucketAtDepth(parsed: ParsedName[], depth: number): PlanGroup[] {
    const buckets = new Map<string, PlanGroup>();
    const order: string[] = [];
    for (const p of parsed) {
        const keyParts = p.parts.slice(0, depth + 1);
        const rest = p.parts.slice(depth + 1);
        const key = keyParts.join(p.join) || p.name;
        const label = rest.length ? rest.join(p.join) : p.name;
        let g = buckets.get(key);
        if (!g) {
            g = { key, items: [] };
            buckets.set(key, g);
            order.push(key);
        }
        g.items.push({ name: p.name, label });
    }
    return order.map(k => buckets.get(k)!);
}

function groupScore(groups: PlanGroup[], total: number): number | null {
    const multi = groups.filter(g => g.items.length >= 2).length;
    if (multi === 0) return null;
    const stripped = groups.some(g => g.items.some(i => i.label !== i.name));
    if (!stripped) return null;
    if (groups.length === 1 && multi === 1) {
        // A single wrapper is useful (app-web / app-api → group "app") but
        // lose out to a deeper split that actually differentiates units.
    } else if (groups.length < 2) {
        return null;
    }
    const maxShare = Math.max(...groups.map(g => g.items.length)) / total;
    return multi * 10 + groups.length - maxShare * 8;
}

/**
 * Cluster attachment names into groups using path separators when present,
 * otherwise hyphens. Picks the depth that yields the most multi-item groups
 * without collapsing everything into one dominant bucket.
 *
 * Terragrunt pipelines often publish names like `prod-platform-network-hub-vnet`
 * (path separators get stripped by attachmentName validation). Path-style names
 * such as `prod-platform/network/hub-vnet` from ##vso[task.addattachment] work
 * the same way.
 */
export function groupPlanNames(names: string[]): PlanGroup[] {
    const flat: PlanGroup[] = [{ key: '', items: names.map(name => ({ name, label: name })) }];
    if (names.length < 2) return flat;

    const parsed = names.map(splitPlanName);
    if (parsed.every(p => p.parts.length <= 1)) return flat;

    const maxDepth = Math.max(0, Math.max(...parsed.map(p => p.parts.length)) - 1);
    let best: { score: number; groups: PlanGroup[] } | null = null;

    for (let depth = 0; depth <= maxDepth; depth++) {
        const groups = bucketAtDepth(parsed, depth);
        const score = groupScore(groups, names.length);
        if (score === null) continue;
        if (!best || score > best.score) best = { score, groups };
    }

    return best ? best.groups : flat;
}

export function visibleGroups(
    groups: PlanGroup[],
    summaries: Map<string, PlanSummary>,
    filter: OverviewFilter,
): PlanGroup[] {
    const out: PlanGroup[] = [];
    for (const g of groups) {
        const items = g.items.filter(i => {
            const s = summaries.get(i.name);
            return s ? shouldShowPlan(s, filter) : false;
        });
        if (items.length) out.push({ key: g.key, items });
    }
    return out;
}
