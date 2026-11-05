import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ALL_PLANS_VALUE, planId } from './overviewLogic';

(window as unknown as { __TF_DEV__?: boolean }).__TF_DEV__ = true;

vi.mock('azure-devops-extension-sdk', () => ({
    init: vi.fn(),
    ready: vi.fn(),
    getService: vi.fn(),
    notifyLoadSucceeded: vi.fn(),
    notifyLoadFailed: vi.fn(),
}));

vi.mock('azure-devops-extension-api', () => ({
    CommonServiceIds: { ProjectPageService: 'ProjectPageService' },
    getClient: vi.fn(),
}));

vi.mock('azure-devops-extension-api/Build', () => ({
    BuildRestClient: class {},
    BuildServiceIds: { BuildPageDataService: 'BuildPageDataService' },
}));

function ref(name: string, extras: { timelineId?: string; recordId?: string } = {}) {
    return {
        name,
        projectId: 'p',
        buildId: 1,
        timelineId: extras.timelineId ?? 't',
        recordId: extras.recordId ?? 'r',
    };
}

function planWith(actions: string[][], extras: { terraform_version?: string } = {}) {
    return {
        terraform_version: extras.terraform_version ?? '1.7.4',
        format_version: '1.2',
        resource_changes: actions.map((a, i) => ({
            address: `test_resource.${i}`,
            type: 'azurerm_resource_group',
            name: String(i),
            change: { actions: a, before: null, after: {} },
        })),
    };
}

const noChange = planWith([['no-op']]);
const changed = planWith([['create'], ['update']]);

describe('renderPlans', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="root"></div>';
    });

    it('keeps the single-plan path unchanged — no selector, Terraform Plan heading', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans(
            [ref('staging')],
            async () => changed,
            root,
        );

        expect(root.querySelector('#plan-select')).toBeNull();
        expect(root.querySelector('.plan-selector')).toBeNull();
        expect(root.querySelector('h1')?.textContent).toBe('Terraform Plan');
        expect(root.querySelector('.toggle-input')).toBeNull();
        expect(root.querySelector('.plan-row')).toBeNull();
        const counts = [...root.querySelectorAll('.summary-count')].map(n => n.textContent);
        expect(counts).toEqual(['1', '1', '0', '0']);
    });

    it('defaults to All plans with combined counts when multiple attachments exist', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        const fixtures: Record<string, ReturnType<typeof planWith>> = {
            'prod-apps-aks-cluster-weu': changed,
            'prod-apps-sql-primary': noChange,
            'prod-platform-network-hub-vnet': changed,
        };
        await renderPlans(
            Object.keys(fixtures).map(name => ref(name)),
            async r => fixtures[r.name],
            root,
        );
        await vi.waitFor(() => {
            expect(root.textContent ?? '').not.toMatch(/Loading/);
        });

        const select = root.querySelector<HTMLSelectElement>('#plan-select');
        expect(select).not.toBeNull();
        expect(select!.value).toBe(ALL_PLANS_VALUE);
        expect(select!.options[0].textContent).toBe('All plans (3)');
        expect(root.querySelector('h1')?.textContent).toBe('All plans');

        const toggle = root.querySelector<HTMLInputElement>('.toggle-input');
        expect(toggle?.checked).toBe(true);

        const counts = [...root.querySelectorAll('.summary-count')].map(n => n.textContent);
        // two changed plans each contribute +1 create and +1 update
        expect(counts).toEqual(['2', '2', '0', '0']);

        const rows = [...root.querySelectorAll('.plan-row')].map(r => r.getAttribute('data-plan-name'));
        expect(rows).toEqual([
            'prod-apps-aks-cluster-weu',
            'prod-platform-network-hub-vnet',
        ]);
        expect([...root.querySelectorAll('.module-label')].map(n => n.textContent))
            .toEqual(['prod-apps', 'prod-platform']);
        expect(root.querySelector('.hidden-plans')?.textContent).toMatch(/1 plan with no changes is hidden/);
    });

    it('opens the existing detail view from a plan row and returns via the selector', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans(
            [ref('prod-apps-aks-cluster-weu'), ref('prod-platform-network-hub-vnet')],
            async () => changed,
            root,
        );
        await vi.waitFor(() => {
            expect(root.querySelector('.plan-row')).not.toBeNull();
        });

        const row = root.querySelector<HTMLButtonElement>('.plan-row');
        expect(row).not.toBeNull();
        row!.click();
        await Promise.resolve();

        expect(root.querySelector('h1')?.textContent).toBe('Terraform Plan');
        expect(root.querySelector<HTMLSelectElement>('#plan-select')?.value)
            .toBe(planId(ref('prod-apps-aks-cluster-weu')));
        expect(root.querySelector('.resource-address')?.textContent).toBe('test_resource.0');

        const select = root.querySelector<HTMLSelectElement>('#plan-select')!;
        select.value = ALL_PLANS_VALUE;
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        expect(root.querySelector('h1')?.textContent).toBe('All plans');
    });

    it('summary cards filter the overview to plans with that action', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans(
            [ref('adds'), ref('removes')],
            async r => r.name === 'adds'
                ? planWith([['create']])
                : planWith([['delete']]),
            root,
        );
        await vi.waitFor(() => {
            expect(root.querySelectorAll('.plan-row')).toHaveLength(2);
        });

        root.querySelector<HTMLButtonElement>('.summary-delete')!.click();
        const rows = [...root.querySelectorAll('.plan-row')].map(r => r.getAttribute('data-plan-name'));
        expect(rows).toEqual(['removes']);
        expect(root.querySelector('.summary-delete')?.classList.contains('is-active')).toBe(true);
    });

    it('Show all reveals plans that have no changes', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans(
            [ref('changed'), ref('quiet')],
            async r => r.name === 'changed' ? changed : noChange,
            root,
        );
        await vi.waitFor(() => {
            expect(root.querySelector('.hidden-plans')).not.toBeNull();
        });

        expect(root.querySelectorAll('.plan-row')).toHaveLength(1);
        root.querySelector<HTMLButtonElement>('.hidden-plans-action')!.click();
        expect(root.querySelectorAll('.plan-row')).toHaveLength(2);
        expect(root.querySelector('.hidden-plans')).toBeNull();
        expect(root.querySelector<HTMLInputElement>('.toggle-input')?.checked).toBe(false);
    });

    it('counts two attachments that share a display name separately', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        const a = ref('terraform-plan', { timelineId: 'one', recordId: 'aaa' });
        const b = ref('terraform-plan', { timelineId: 'two', recordId: 'bbb' });
        await renderPlans(
            [a, b],
            async r => r.recordId === 'aaa' ? planWith([['create']]) : planWith([['delete']]),
            root,
        );
        await vi.waitFor(() => {
            expect(root.textContent ?? '').not.toMatch(/Loading/);
        });

        const counts = [...root.querySelectorAll('.summary-count')].map(n => n.textContent);
        expect(counts).toEqual(['1', '0', '0', '1']);
        const ids = [...root.querySelectorAll('.plan-row')].map(r => r.getAttribute('data-plan-id'));
        expect(ids).toEqual([planId(a), planId(b)]);
    });

    it('keeps a collapsed group collapsed while background fetches complete', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        let releaseSlow: (plan: ReturnType<typeof planWith>) => void = () => undefined;
        const slow = new Promise<ReturnType<typeof planWith>>(resolve => { releaseSlow = resolve; });
        const fetchP = renderPlans(
            [
                ref('prod-apps-aks-cluster-weu'),
                ref('prod-apps-sql-primary'),
                ref('prod-platform-network-hub-vnet'),
            ],
            async r => {
                if (r.name === 'prod-apps-sql-primary') return slow;
                return changed;
            },
            root,
        );

        await vi.waitFor(() => {
            expect(root.querySelector('.plan-group')).not.toBeNull();
        });
        const group = root.querySelector<HTMLDetailsElement>('details.plan-group')!;
        expect(group.open).toBe(true);
        group.open = false;
        group.dispatchEvent(new Event('toggle'));

        releaseSlow(changed);
        await fetchP;
        await vi.waitFor(() => {
            expect(root.textContent ?? '').not.toMatch(/Loading/);
        });

        expect(root.querySelector<HTMLDetailsElement>('details.plan-group[data-group-key="prod-apps"]')?.open)
            .toBe(false);
    });

    it('exposes counts and status on the row accessible name', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans(
            [ref('adds'), ref('quiet')],
            async r => r.name === 'adds' ? changed : noChange,
            root,
        );
        await vi.waitFor(() => {
            expect(root.querySelector('.hidden-plans')).not.toBeNull();
        });
        const row = root.querySelector<HTMLButtonElement>('.plan-row')!;
        expect(row.getAttribute('aria-label')).toMatch(/1 update/);
        expect(row.getAttribute('aria-label')).toMatch(/1 create/);
    });
});
