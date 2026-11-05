import { describe, it, expect } from 'vitest';
import {
    type ActionKind,
    type ResourceChange,
    emptyCounts,
} from './planLogic';
import {
    ALL_PLANS_VALUE,
    defaultSelectorValue,
    dominantAction,
    errorSummary,
    groupPlanNames,
    hiddenNoChangeCount,
    loadedSummary,
    pendingSummary,
    shouldShowOverview,
    shouldShowPlan,
    uniqueTerraformVersions,
    visibleGroups,
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
        expect(defaultSelectorValue([{ name: 'staging' }])).toBe('staging');
    });

    it('defaults to All plans when two or more plans are attached', () => {
        expect(shouldShowOverview(2)).toBe(true);
        expect(shouldShowOverview(34)).toBe(true);
        expect(defaultSelectorValue([{ name: 'a' }, { name: 'b' }])).toBe(ALL_PLANS_VALUE);
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
        expect(summary.haystack).toContain('azurerm_resource_group.main');
        expect(summary.haystack).toContain('azurerm_key_vault');
    });

    it('treats a plan with only no-op resources as having no changes', () => {
        const summary = loadedSummary('noop', {
            resource_changes: [
                rc('azurerm_resource_group.main', 'azurerm_resource_group', ['no-op']),
            ],
        });
        expect(summary.hasChanges).toBe(false);
    });

    it('treats output-only changes as having changes so they are not hidden', () => {
        const summary = loadedSummary('outputs-only', {
            resource_changes: [],
            output_changes: {
                connection_string: { actions: ['update'] },
            },
        });
        expect(summary.hasChanges).toBe(true);
        expect(summary.counts.create).toBe(0);
    });

    it('pending summaries stay visible until loaded', () => {
        const s = pendingSummary('still-loading');
        expect(s.status).toBe('pending');
        expect(s.hasChanges).toBeNull();
        expect(shouldShowPlan(s, {
            search: '',
            onlyWithChanges: true,
            actionFilters: new Set(),
        })).toBe(true);
    });
});

describe('dominantAction', () => {
    it('prefers delete, then recreate, then update, then create', () => {
        const c = emptyCounts();
        expect(dominantAction(c)).toBeNull();
        c.create = 2;
        expect(dominantAction(c)).toBe('create');
        c.update = 1;
        expect(dominantAction(c)).toBe('update');
        c.recreate = 1;
        expect(dominantAction(c)).toBe('recreate');
        c.delete = 1;
        expect(dominantAction(c)).toBe('delete');
    });
});

describe('groupPlanNames', () => {
    it('returns a flat list for a single name or unique tokens', () => {
        expect(groupPlanNames(['staging'])).toEqual([
            { key: '', items: [{ name: 'staging', label: 'staging' }] },
        ]);
        expect(groupPlanNames(['dev', 'staging', 'prod'])[0].key).toBe('');
    });

    it('groups hyphenated Terragrunt-style names by deployment unit', () => {
        const groups = groupPlanNames([
            'prod-apps-aks-cluster-weu',
            'prod-apps-sql-primary',
            'prod-platform-dns-private-zones',
            'prod-platform-network-hub-vnet',
        ]);
        expect(groups.map(g => g.key)).toEqual(['prod-apps', 'prod-platform']);
        expect(groups[0].items.map(i => i.label)).toEqual(['aks-cluster-weu', 'sql-primary']);
        expect(groups[1].items.map(i => i.label)).toEqual(['dns-private-zones', 'network-hub-vnet']);
    });

    it('groups path-style attachment names by the first segment', () => {
        const groups = groupPlanNames([
            'prod-apps/aks/cluster-weu',
            'prod-platform/dns/private-zones',
            'prod-platform/network/hub-vnet',
        ]);
        expect(groups.map(g => g.key)).toEqual(['prod-apps', 'prod-platform']);
        expect(groups[1].items.map(i => i.label)).toEqual([
            'dns/private-zones',
            'network/hub-vnet',
        ]);
    });

    it('does not invent groups when every bucket would have one item', () => {
        const groups = groupPlanNames(['staging', 'prod-no-changes']);
        expect(groups).toHaveLength(1);
        expect(groups[0].key).toBe('');
        expect(groups[0].items.map(i => i.name)).toEqual(['staging', 'prod-no-changes']);
    });

    it('wraps a shared prefix when that is the only useful split', () => {
        const groups = groupPlanNames(['app-web', 'app-api']);
        expect(groups).toEqual([{
            key: 'app',
            items: [
                { name: 'app-web', label: 'web' },
                { name: 'app-api', label: 'api' },
            ],
        }]);
    });

    it('prefers unit-level groups over a single shared first token', () => {
        const groups = groupPlanNames([
            'prod-apps-aks-cluster-weu',
            'prod-apps-sql-primary',
            'prod-platform-network-hub-vnet',
            'shared-monitoring',
        ]);
        expect(groups.map(g => g.key)).toEqual([
            'prod-apps',
            'prod-platform',
            'shared-monitoring',
        ]);
    });
});

describe('shouldShowPlan / hiddenNoChangeCount', () => {
    const changed = loadedSummary('prod-platform-network-hub-vnet', {
        resource_changes: [rc('azurerm_subnet.app', 'azurerm_subnet', ['create'])],
    });
    const quiet = loadedSummary('prod-platform-dns-private-zones', {
        resource_changes: [rc('azurerm_dns_zone.priv', 'azurerm_dns_zone', ['no-op'])],
    });
    const failed = errorSummary('prod-apps-aks-cluster-weu', 'not json');

    it('hides loaded no-change plans when the toggle is on', () => {
        const filter = { search: '', onlyWithChanges: true, actionFilters: new Set<ActionKind>() };
        expect(shouldShowPlan(changed, filter)).toBe(true);
        expect(shouldShowPlan(quiet, filter)).toBe(false);
        expect(shouldShowPlan(failed, filter)).toBe(true);
        expect(hiddenNoChangeCount([changed, quiet, failed], filter)).toBe(1);
    });

    it('shows no-change plans when the toggle is off', () => {
        const filter = { search: '', onlyWithChanges: false, actionFilters: new Set<ActionKind>() };
        expect(shouldShowPlan(quiet, filter)).toBe(true);
        expect(hiddenNoChangeCount([changed, quiet], filter)).toBe(0);
    });

    it('filters by plan name and resource address/type', () => {
        const byName = { search: 'hub-vnet', onlyWithChanges: false, actionFilters: new Set<ActionKind>() };
        expect(shouldShowPlan(changed, byName)).toBe(true);
        expect(shouldShowPlan(quiet, byName)).toBe(false);

        const byType = { search: 'azurerm_subnet', onlyWithChanges: false, actionFilters: new Set<ActionKind>() };
        expect(shouldShowPlan(changed, byType)).toBe(true);
        expect(shouldShowPlan(quiet, byType)).toBe(false);
    });

    it('filters by summary-card action', () => {
        const onlyDelete = {
            search: '',
            onlyWithChanges: false,
            actionFilters: new Set<ActionKind>(['delete']),
        };
        expect(shouldShowPlan(changed, onlyDelete)).toBe(false);
        const withDelete = loadedSummary('legacy', {
            resource_changes: [rc('azurerm_app_service.old', 'azurerm_app_service', ['delete'])],
        });
        expect(shouldShowPlan(withDelete, onlyDelete)).toBe(true);
    });
});

describe('visibleGroups', () => {
    it('drops groups whose members are all filtered out', () => {
        const names = [
            'prod-apps-aks-cluster-weu',
            'prod-apps-sql-primary',
            'prod-platform-dns-private-zones',
        ];
        const groups = groupPlanNames(names);
        const summaries = new Map([
            [names[0], loadedSummary(names[0], {
                resource_changes: [rc('azurerm_kubernetes_cluster.aks', 'azurerm_kubernetes_cluster', ['update'])],
            })],
            [names[1], loadedSummary(names[1], { resource_changes: [] })],
            [names[2], loadedSummary(names[2], { resource_changes: [] })],
        ]);
        const shown = visibleGroups(groups, summaries, {
            search: '',
            onlyWithChanges: true,
            actionFilters: new Set(),
        });
        expect(shown.map(g => g.key)).toEqual(['prod-apps']);
        expect(shown[0].items.map(i => i.name)).toEqual(['prod-apps-aks-cluster-weu']);
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
