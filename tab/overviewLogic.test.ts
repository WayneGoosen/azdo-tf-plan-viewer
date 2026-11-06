import { describe, it, expect } from 'vitest';
import {
    type ActionKind,
    type ResourceChange,
} from './planLogic';
import {
    ALL_PLANS_VALUE,
    type OverviewFilter,
    VIEWER_SETTINGS_KEY,
    anyPlanWithoutChanges,
    buildResourceRows,
    defaultHideNoChangePlans,
    defaultSelectorValue,
    duplicateNameSuffixes,
    errorSummary,
    loadedSummary,
    noopRowCount,
    pendingSummary,
    planId,
    planShapeError,
    plansHiddenFromSelector,
    rowMatches,
    shouldShowOverview,
    uniqueTerraformVersions,
} from './overviewLogic';

function rc(address: string, type: string, actions: string[]): ResourceChange {
    return {
        address,
        type,
        name: address.split('.').pop() ?? address,
        change: { actions, before: null, after: {} },
    };
}

describe('default selection', () => {
    it('hides the overview when only one plan is attached', () => {
        expect(shouldShowOverview(1)).toBe(false);
        expect(shouldShowOverview(0)).toBe(false);
        expect(defaultSelectorValue([{ name: 'staging' }])).toBe(planId({ name: 'staging' }));
    });

    it('defaults to All plans when two or more plans are attached', () => {
        expect(shouldShowOverview(2)).toBe(true);
        expect(shouldShowOverview(34)).toBe(true);
        expect(defaultSelectorValue([{ name: 'a' }, { name: 'b' }])).toBe(ALL_PLANS_VALUE);
    });

    it('uses a sentinel that cannot collide with a valid attachmentName', () => {
        expect(ALL_PLANS_VALUE).toBe('');
        expect(/^[A-Za-z0-9_-]+$/.test(ALL_PLANS_VALUE)).toBe(false);
        expect(ALL_PLANS_VALUE).not.toBe(planId({ name: 'terraform-plan' }));
        expect(ALL_PLANS_VALUE).not.toBe(planId({ name: '__all__', timelineId: 't', recordId: 'r' }));
    });

    it('gives distinct ids to attachments that share a display name', () => {
        const a = planId({ name: 'terraform-plan', timelineId: 'one', recordId: 'aaa' });
        const b = planId({ name: 'terraform-plan', timelineId: 'two', recordId: 'bbb' });
        expect(a).not.toBe(b);
    });
});

describe('loadedSummary / hasChanges', () => {
    it('counts resource actions and treats create/update/recreate/delete as changes', () => {
        const summary = loadedSummary('hub', {
            terraform_version: '1.7.4',
            resource_changes: [
                rc('azurerm_resource_group.main', 'azurerm_resource_group', ['create']),
                rc('azurerm_storage_account.logs', 'azurerm_storage_account', ['update']),
                rc('azurerm_key_vault.main', 'azurerm_key_vault', ['delete', 'create']),
                rc('azurerm_app_service.old', 'azurerm_app_service', ['delete']),
                rc('data.azurerm_client_config.current', 'azurerm_client_config', ['read']),
                rc('azurerm_log_analytics_workspace.shared', 'azurerm_log_analytics_workspace', ['no-op']),
            ],
        });
        expect(summary.status).toBe('loaded');
        expect(summary.hasChanges).toBe(true);
        expect(summary.counts.create).toBe(1);
        expect(summary.counts.update).toBe(1);
        expect(summary.counts.recreate).toBe(1);
        expect(summary.counts.delete).toBe(1);
        expect(summary.counts.read).toBe(1);
        expect(summary.counts.noop).toBe(1);
        expect(summary.terraformVersion).toBe('1.7.4');
    });

    it('treats a plan with only no-op resources as having no changes', () => {
        const summary = loadedSummary('noop', {
            resource_changes: [
                rc('azurerm_resource_group.main', 'azurerm_resource_group', ['no-op']),
            ],
        });
        expect(summary.hasChanges).toBe(false);
    });

    it('treats output-only changes as having changes', () => {
        const summary = loadedSummary('outputs-only', {
            resource_changes: [],
            output_changes: {
                connection_string: { actions: ['update'] },
            },
        });
        expect(summary.hasChanges).toBe(true);
        expect(summary.counts.create).toBe(0);
    });

    it('pending and failed summaries have unknown change status', () => {
        const s = pendingSummary('still-loading');
        expect(s.status).toBe('pending');
        expect(s.hasChanges).toBeNull();
        const e = errorSummary('broken', 'not json');
        expect(e.status).toBe('error');
        expect(e.hasChanges).toBeNull();
        expect(e.error).toBe('not json');
    });
});

describe('buildResourceRows', () => {
    const hub = { id: 'id-hub', label: 'network-hub', resources: [
        rc('azurerm_subnet.app', 'azurerm_subnet', ['create']),
        rc('azurerm_dns_zone.priv', 'azurerm_dns_zone', ['no-op']),
    ] };
    const aks = { id: 'id-aks', label: 'aks-cluster', resources: [
        rc('azurerm_kubernetes_cluster.main', 'azurerm_kubernetes_cluster', ['update']),
    ] };

    it('flattens plans in order, tagging each row with its plan', () => {
        const rows = buildResourceRows([hub, aks]);
        expect(rows.map(r => [r.planLabel, r.resource.address, r.kind])).toEqual([
            ['network-hub', 'azurerm_subnet.app', 'create'],
            ['network-hub', 'azurerm_dns_zone.priv', 'noop'],
            ['aks-cluster', 'azurerm_kubernetes_cluster.main', 'update'],
        ]);
        expect(rows[2].planId).toBe('id-aks');
    });

    it('gives unique keys even when two plans share an address', () => {
        const a = { id: 'a', label: 'a', resources: [rc('x.y', 'x', ['create'])] };
        const b = { id: 'b', label: 'b', resources: [rc('x.y', 'x', ['create'])] };
        const dup = { id: 'c', label: 'c', resources: [rc('x.y', 'x', ['delete']), rc('x.y', 'x', ['create'])] };
        const keys = buildResourceRows([a, b, dup]).map(r => r.key);
        expect(new Set(keys).size).toBe(4);
    });

    it('counts no-op rows for the unchanged-resources toggle', () => {
        expect(noopRowCount(buildResourceRows([hub, aks]))).toBe(1);
    });
});

describe('rowMatches', () => {
    const rows = buildResourceRows([
        { id: 'h', label: 'prod-platform-network-hub-vnet', resources: [
            rc('azurerm_subnet.app', 'azurerm_subnet', ['create']),
            rc('azurerm_dns_zone.priv', 'azurerm_dns_zone', ['no-op']),
        ] },
        { id: 'l', label: 'legacy', resources: [
            rc('azurerm_app_service.old', 'azurerm_app_service', ['delete']),
        ] },
    ]);
    const [subnet, zone, app] = rows;
    const f = (over: Partial<OverviewFilter> = {}): OverviewFilter => ({
        search: '', actionFilters: new Set<ActionKind>(), showNoop: false, ...over,
    });

    it('hides no-op resources unless showNoop is on', () => {
        expect(rowMatches(zone, f())).toBe(false);
        expect(rowMatches(zone, f({ showNoop: true }))).toBe(true);
        expect(rowMatches(subnet, f())).toBe(true);
    });

    it('filters by summary-card action', () => {
        const onlyDelete = f({ actionFilters: new Set<ActionKind>(['delete']) });
        expect(rowMatches(subnet, onlyDelete)).toBe(false);
        expect(rowMatches(app, onlyDelete)).toBe(true);
    });

    it('searches resource address, resource type, and plan name', () => {
        expect(rowMatches(subnet, f({ search: 'subnet.app' }))).toBe(true);
        expect(rowMatches(app, f({ search: 'azurerm_app_service' }))).toBe(true);
        expect(rowMatches(subnet, f({ search: 'HUB-VNET' }))).toBe(true);
        expect(rowMatches(app, f({ search: 'hub-vnet' }))).toBe(false);
    });
});

describe('hiding no-change plans from the dropdown', () => {
    const quietFlagged = loadedSummary('quiet', {
        resource_changes: [],
        [VIEWER_SETTINGS_KEY]: { hideNoChangePlans: true },
    }, 'q');
    const quiet = loadedSummary('quiet2', { resource_changes: [] }, 'q2');
    const busy = loadedSummary('busy', { resource_changes: [rc('a.b', 'a', ['create'])] }, 'b');
    const outputsOnly = loadedSummary('outs', {
        resource_changes: [],
        output_changes: { url: { actions: ['update'] } },
    }, 'o');
    const pending = pendingSummary('later', 'p');
    const failed = errorSummary('broken', 'boom', 'e');

    it('reads the task setting from the attached plan', () => {
        expect(quietFlagged.hideWhenNoChanges).toBe(true);
        expect(quiet.hideWhenNoChanges).toBe(false);
    });

    it('defaults the checkbox on when any loaded plan asked for it', () => {
        expect(defaultHideNoChangePlans([quiet, busy])).toBe(false);
        expect(defaultHideNoChangePlans([quiet, busy, quietFlagged])).toBe(true);
        expect(defaultHideNoChangePlans([pending])).toBe(false);
    });

    it('hides only loaded plans with no resource or output changes', () => {
        const all = [quietFlagged, quiet, busy, outputsOnly, pending, failed];
        expect([...plansHiddenFromSelector(all, true)].sort()).toEqual(['q', 'q2']);
        expect(plansHiddenFromSelector(all, false).size).toBe(0);
    });

    it('knows when there is a plan the checkbox could hide', () => {
        expect(anyPlanWithoutChanges([busy, outputsOnly, pending, failed])).toBe(false);
        expect(anyPlanWithoutChanges([busy, quiet])).toBe(true);
    });

    it('never hides the plan currently shown', () => {
        expect([...plansHiddenFromSelector([quiet, quietFlagged], true, 'q')]).toEqual(['q2']);
    });
});

describe('planShapeError', () => {
    it('accepts real plans, including ones with no changes listed', () => {
        expect(planShapeError({ resource_changes: [rc('a.b', 'a', ['create'])] })).toBeNull();
        expect(planShapeError({ format_version: '1.2' })).toBeNull();
        expect(planShapeError({ output_changes: { url: { actions: ['update'] } } })).toBeNull();
    });

    it('explains what is wrong with JSON that is not a plan', () => {
        expect(planShapeError(null)).toBe('expected a JSON object');
        expect(planShapeError([1])).toBe('expected a JSON object');
        expect(planShapeError({ resource_changes: {} })).toBe('resource_changes is not a list');
        expect(planShapeError({ resource_changes: [{ type: 'a' }] })).toBe('resource_changes[0] has no address or type');
        expect(planShapeError({ resource_changes: [{ address: 'a.b', type: 'a', change: { actions: 'create' } }] }))
            .toBe('resource_changes[0] has no change.actions list');
        expect(planShapeError({ output_changes: [] })).toBe('output_changes is not an object');
        expect(planShapeError({ output_changes: { url: {} } })).toBe('output_changes.url has no actions list');
    });
});

describe('duplicateNameSuffixes', () => {
    it('adds a short record suffix only to names that repeat', () => {
        const a = { name: 'prod', timelineId: 't1', recordId: 'abcd1234ffff' };
        const b = { name: 'prod', timelineId: 't2', recordId: 'ef567890ffff' };
        const c = { name: 'dev', timelineId: 't1', recordId: '11112222' };
        const m = duplicateNameSuffixes([a, b, c]);
        expect(m.get(planId(a))).toBe(' (abcd1234)');
        expect(m.get(planId(b))).toBe(' (ef567890)');
        expect(m.has(planId(c))).toBe(false);
    });
});

describe('uniqueTerraformVersions', () => {
    it('returns sorted unique versions from loaded plans', () => {
        const a = loadedSummary('a', { terraform_version: '1.9.8', resource_changes: [] });
        const b = loadedSummary('b', { terraform_version: '1.7.4', resource_changes: [] });
        const c = loadedSummary('c', { terraform_version: '1.9.8', resource_changes: [] });
        expect(uniqueTerraformVersions([a, b, c, pendingSummary('d')])).toEqual(['1.7.4', '1.9.8']);
    });
});
