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

    /** [plan tag, resource address] for each row in the combined list. */
    const listedRows = (root: HTMLElement) =>
        [...root.querySelectorAll('.overview-list details.resource')].map(d => [
            d.querySelector('.plan-tag')?.textContent,
            d.querySelector('.resource-address')?.textContent,
        ]);

    const settled = async (root: HTMLElement) => {
        await vi.waitFor(() => {
            expect(root.querySelector('.header-meta')?.textContent ?? '').not.toMatch(/Loading/);
            expect(root.querySelector('.header-meta')).not.toBeNull();
        });
    };

    it('defaults to All plans, listing every resource change tagged with its plan', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        const fixtures: Record<string, ReturnType<typeof planWith>> = {
            'prod-apps-aks-cluster-weu': changed,
            'prod-apps-sql-primary': noChange,
            'prod-platform-network-hub-vnet': changed,
        };
        await renderPlans(Object.keys(fixtures).map(name => ref(name)), async r => fixtures[r.name], root);
        await settled(root);

        const select = root.querySelector<HTMLSelectElement>('#plan-select')!;
        expect(select.value).toBe(ALL_PLANS_VALUE);
        expect(select.options[0].textContent).toBe('All plans (3)');
        expect(root.querySelector('h1')?.textContent).toBe('All plans');

        const counts = [...root.querySelectorAll('.summary-count')].map(n => n.textContent);
        expect(counts).toEqual(['2', '2', '0', '0']);
        expect(root.querySelector('.header-meta')?.textContent).toMatch(/4 resource changes/);

        // No-op resources (the whole of sql-primary here) are hidden by default.
        expect(listedRows(root)).toEqual([
            ['prod-apps-aks-cluster-weu', 'test_resource.0'],
            ['prod-apps-aks-cluster-weu', 'test_resource.1'],
            ['prod-platform-network-hub-vnet', 'test_resource.0'],
            ['prod-platform-network-hub-vnet', 'test_resource.1'],
        ]);
        expect(root.querySelector('.plan-row')).toBeNull();
    });

    it('reveals unchanged resources with the toggle', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans([ref('changed'), ref('quiet')], async r => r.name === 'changed' ? changed : noChange, root);
        await settled(root);

        const toggle = [...root.querySelectorAll<HTMLButtonElement>('.control-btn')]
            .find(b => /unchanged resource/.test(b.textContent ?? ''))!;
        expect(toggle.textContent).toBe('Show 1 unchanged resource');
        toggle.click();
        expect(listedRows(root)).toContainEqual(['quiet', 'test_resource.0']);
        expect(root.querySelector('[data-focus-key="btn:noop"]')?.textContent).toBe('Hide 1 unchanged resource');
    });

    it('opens the plan detail view from a plan tag and returns via the selector', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans(
            [ref('prod-apps-aks-cluster-weu'), ref('prod-platform-network-hub-vnet')],
            async () => changed,
            root,
        );
        await settled(root);

        const tag = root.querySelector<HTMLButtonElement>('.overview-list .plan-tag')!;
        expect(tag.getAttribute('aria-label')).toBe('Open plan prod-apps-aks-cluster-weu');
        tag.click();
        await Promise.resolve();

        expect(root.querySelector('h1')?.textContent).toBe('Terraform Plan');
        expect(root.querySelector<HTMLSelectElement>('#plan-select')?.value)
            .toBe(planId(ref('prod-apps-aks-cluster-weu')));

        const select = root.querySelector<HTMLSelectElement>('#plan-select')!;
        select.value = ALL_PLANS_VALUE;
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();
        expect(root.querySelector('h1')?.textContent).toBe('All plans');
    });

    it('clicking a plan tag does not expand the row it sits in', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans([ref('a'), ref('b')], async () => changed, root);
        await settled(root);
        const row = root.querySelector<HTMLDetailsElement>('.overview-list details.resource')!;
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        row.querySelector('.plan-tag')!.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
    });

    it('summary cards filter the list to resources with that action', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans(
            [ref('adds'), ref('removes')],
            async r => r.name === 'adds' ? planWith([['create']]) : planWith([['delete']]),
            root,
        );
        await settled(root);

        root.querySelector<HTMLButtonElement>('.summary-delete')!.click();
        expect(listedRows(root)).toEqual([['removes', 'test_resource.0']]);
        expect(root.querySelector('.summary-delete')?.classList.contains('is-active')).toBe(true);
    });

    it('search matches the plan name as well as resource address and type', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const { renderPlans } = await import('./tab');
            const root = document.getElementById('root')!;
            await renderPlans([ref('network-hub'), ref('aks-cluster')], async () => changed, root);
            await settled(root);

            const search = root.querySelector<HTMLInputElement>('.search')!;
            search.value = 'hub';
            search.dispatchEvent(new Event('input'));
            await vi.advanceTimersByTimeAsync(100);
            expect(listedRows(root).map(r => r[0])).toEqual(['network-hub', 'network-hub']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('tags rows from same-name attachments with a record suffix, like the selector', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        const a = ref('prod', { timelineId: 'one', recordId: 'abcd1234ffff' });
        const b = ref('prod', { timelineId: 'two', recordId: 'ef567890ffff' });
        await renderPlans([a, b], async r => r.recordId === a.recordId ? planWith([['create']]) : planWith([['delete']]), root);
        await settled(root);

        expect(listedRows(root)).toEqual([
            ['prod (abcd1234)', 'test_resource.0'],
            ['prod (ef567890)', 'test_resource.0'],
        ]);
        expect([...root.querySelectorAll('.summary-count')].map(n => n.textContent)).toEqual(['1', '0', '0', '1']);
        const opts = [...root.querySelectorAll<HTMLOptionElement>('#plan-select option')].map(o => o.textContent);
        expect(opts.slice(1)).toEqual(['prod (abcd1234)', 'prod (ef567890)']);
    });

    it('lists changed outputs from every plan, tagged with their plan', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        const withOutputs = {
            ...planWith([['no-op']]),
            output_changes: {
                endpoint: { actions: ['update'], before: 'a', after: 'b' },
                unchanged: { actions: ['no-op'], before: 'x', after: 'x' },
            },
        };
        await renderPlans([ref('api'), ref('quiet')], async r => r.name === 'api' ? withOutputs : noChange, root);
        await settled(root);

        const outputs = [...root.querySelectorAll('.outputs .output-row')].map(r => [
            r.querySelector('.output-name')?.textContent,
            r.querySelector('.plan-tag')?.textContent,
        ]);
        expect(outputs).toEqual([['endpoint', 'api']]);
    });

    it('says so when no plan has resource changes', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans([ref('a'), ref('b')], async () => noChange, root);
        await settled(root);
        expect(root.querySelector('.tree > .empty')?.textContent)
            .toMatch(/No resource changes in any plan/);
    });

    it('does not give the all-clear when some plans failed to load', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans(
            [ref('quiet'), ref('broken')],
            async r => { if (r.name === 'broken') throw new Error('HTTP 500'); return noChange; },
            root,
        );
        await settled(root);
        const msg = root.querySelector('.tree > .empty')?.textContent ?? '';
        expect(msg).not.toMatch(/Infrastructure matches/);
        expect(msg).toMatch(/1 plan could not be loaded, so the result is incomplete/);
    });

    it('says so when no plan could be loaded at all', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans([ref('a'), ref('b')], async () => { throw new Error('HTTP 500'); }, root);
        await settled(root);
        expect(root.querySelector('.tree > .empty')?.textContent)
            .toBe('None of the plans could be loaded, so their changes are unknown.');
    });

    it('keeps the overview working when an attachment is JSON but not a plan', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        const bad: Record<string, unknown> = {
            'null-plan': null,
            'bad-list': { resource_changes: 'nope' },
            'no-actions': { resource_changes: [{ address: 'a.b', type: 'a', name: 'b', change: {} }] },
        };
        await renderPlans(
            [ref('good'), ...Object.keys(bad).map(n => ref(n))],
            async r => (r.name === 'good' ? changed : bad[r.name]) as ReturnType<typeof planWith>,
            root,
        );
        await settled(root);
        // The good plan still renders; the three bad ones are reported, not fatal.
        expect(listedRows(root).map(r => r[0])).toEqual(['good', 'good']);
        const notice = root.querySelector('.overview-notice')?.textContent ?? '';
        expect(notice).toMatch(/3 plans could not be loaded/);
        expect(notice).toMatch(/resource_changes is not a list/);
        expect(notice).toMatch(/expected a JSON object/);
        expect(notice).toMatch(/has no change\.actions list/);
    });

    it('shows a clear error for a malformed single plan', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans([ref('only')], async () => ({ resource_changes: 42 }) as unknown as ReturnType<typeof planWith>, root);
        expect(root.textContent).toMatch(/not a Terraform JSON plan: resource_changes is not a list/);
    });

    it('lists plans that failed to load', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans(
            [ref('good'), ref('broken')],
            async r => { if (r.name === 'broken') throw new Error('not valid JSON'); return changed; },
            root,
        );
        await settled(root);
        expect(root.querySelector('.overview-notice')?.textContent).toMatch(/1 plan could not be loaded/);
        expect(root.querySelector('.overview-notice')?.textContent).toMatch(/broken: not valid JSON/);
        expect(listedRows(root).every(r => r[0] === 'good')).toBe(true);
    });

    it('keeps an expanded row open and focused while other plans finish loading', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        let releaseSlow: (plan: ReturnType<typeof planWith>) => void = () => undefined;
        const slow = new Promise<ReturnType<typeof planWith>>(resolve => { releaseSlow = resolve; });
        const done = renderPlans([ref('alpha'), ref('beta')], async r => r.name === 'beta' ? slow : changed, root);
        await vi.waitFor(() => expect(listedRows(root).length).toBe(2));

        const row = root.querySelector<HTMLDetailsElement>('.overview-list details.resource')!;
        row.open = true;
        row.dispatchEvent(new Event('toggle'));
        row.querySelector<HTMLElement>('summary')!.focus();

        releaseSlow(changed);
        await done;
        await settled(root);

        const first = root.querySelector<HTMLDetailsElement>('.overview-list details.resource')!;
        expect(first).toBe(row); // same element reused, not rebuilt
        expect(first.open).toBe(true);
        expect(document.activeElement).toBe(first.querySelector('summary'));
        expect(listedRows(root)).toHaveLength(4);
    });

    it('builds each row once and its diff only when first opened', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        const gates: Array<() => void> = [];
        const done = renderPlans(
            ['a', 'b', 'c'].map(n => ref(n)),
            r => r.name === 'a'
                ? Promise.resolve(changed)
                : new Promise(res => gates.push(() => res(changed))),
            root,
        );
        await vi.waitFor(() => expect(listedRows(root).length).toBe(2));
        const firstRows = [...root.querySelectorAll('.overview-list details.resource')];
        // Collapsed rows carry no diff yet.
        expect(firstRows[0].querySelector('.resource-body')).toBeNull();

        gates.forEach(g => g());
        await done;
        await settled(root);
        const after = [...root.querySelectorAll('.overview-list details.resource')];
        expect(after).toHaveLength(6);
        expect(after.slice(0, 2)).toEqual(firstRows); // earlier rows untouched by later loads

        const row = after[0] as HTMLDetailsElement;
        row.open = true;
        row.dispatchEvent(new Event('toggle'));
        expect(row.querySelectorAll('.resource-body')).toHaveLength(1);
        row.open = false;
        row.dispatchEvent(new Event('toggle'));
        row.open = true;
        row.dispatchEvent(new Event('toggle'));
        expect(row.querySelectorAll('.resource-body')).toHaveLength(1); // built once
    });

    it('Expand all opens visible rows with their diffs; Collapse all closes them', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans([ref('a'), ref('b')], async () => changed, root);
        await settled(root);
        const btn = (t: string) => [...root.querySelectorAll<HTMLButtonElement>('.control-btn')].find(b => b.textContent === t)!;
        const rows = () => [...root.querySelectorAll<HTMLDetailsElement>('.overview-list details.resource')];

        btn('Expand all').click();
        expect(rows().every(r => r.open && r.querySelector('.resource-body'))).toBe(true);
        btn('Collapse all').click();
        expect(rows().some(r => r.open)).toBe(false);
    });

    it('keeps focus on a summary card after toggling it', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        await renderPlans([ref('adds'), ref('removes')],
            async r => r.name === 'adds' ? planWith([['create']]) : planWith([['delete']]), root);
        await settled(root);
        const card = root.querySelector<HTMLButtonElement>('.summary-delete')!;
        card.focus();
        card.click();
        expect(document.activeElement?.classList.contains('summary-delete')).toBe(true);
        expect(document.activeElement).not.toBe(card); // card was rebuilt, focus moved to the new one
    });

    it('defers re-rendering while the pointer is held so a click is not lost', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        let releaseSlow: (plan: ReturnType<typeof planWith>) => void = () => undefined;
        const slow = new Promise<ReturnType<typeof planWith>>(resolve => { releaseSlow = resolve; });
        const done = renderPlans([ref('alpha'), ref('beta')], async r => r.name === 'beta' ? slow : changed, root);
        await vi.waitFor(() => expect(listedRows(root).length).toBe(2));

        const tag = root.querySelector<HTMLButtonElement>('.overview-list .plan-tag')!;
        tag.dispatchEvent(new Event('pointerdown', { bubbles: true }));

        releaseSlow(changed);
        await done;
        await new Promise(r => setTimeout(r, 0));
        // Fetch landed while the pointer was down: the redraw is deferred, so the
        // meta still reads as loading and the element under the pointer survives.
        expect(root.querySelector('.header-meta')?.textContent).toMatch(/Loading 1\/2/);
        expect(tag.isConnected).toBe(true);

        document.dispatchEvent(new Event('pointerup', { bubbles: true }));
        tag.click();
        expect(root.querySelector('h1')?.textContent).toBe('Terraform Plan');
    });

    it('pauses background overview downloads while a user-opened plan loads', async () => {
        const { renderPlans } = await import('./tab');
        const root = document.getElementById('root')!;
        const names = ['a', 'b', 'c', 'd', 'e', 'f'];
        const calls: string[] = [];
        const release = new Map<string, () => void>();
        await renderPlans(
            names.map(n => ref(n, { recordId: n })),
            r => {
                calls.push(r.name);
                return new Promise(resolve => release.set(r.name, () => resolve(changed)));
            },
            root,
        );
        // Background pool fills up to its concurrency limit.
        await vi.waitFor(() => expect(calls).toEqual(['a', 'b', 'c', 'd']));

        const select = root.querySelector<HTMLSelectElement>('#plan-select')!;
        select.value = planId(ref('f', { recordId: 'f' }));
        select.dispatchEvent(new Event('change'));
        expect(calls).toEqual(['a', 'b', 'c', 'd', 'f']);

        // A background slot frees up, but it must not start 'e' yet.
        release.get('a')!();
        await new Promise(r => setTimeout(r, 0));
        expect(calls).not.toContain('e');

        release.get('f')!();
        await vi.waitFor(() => expect(calls).toContain('e'));
        expect(root.querySelector('h1')?.textContent).toBe('Terraform Plan');
    });
    describe('hide plans without changes', () => {
        const flagged = (plan: ReturnType<typeof planWith>) => ({ ...plan, terraform_plan_viewer: { hideNoChangePlans: true } });
        const optionTexts = (root: HTMLElement) =>
            [...root.querySelectorAll<HTMLOptionElement>('#plan-select option')].map(o => o.textContent);

        it('lists every plan by default', async () => {
            const { renderPlans } = await import('./tab');
            const root = document.getElementById('root')!;
            await renderPlans([ref('busy'), ref('quiet')], async r => r.name === 'busy' ? changed : noChange, root);
            await settled(root);
            expect(optionTexts(root)).toEqual(['All plans (2)', 'busy', 'quiet']);
            const box = root.querySelector<HTMLInputElement>('#hide-no-change-plans')!;
            expect(box.checked).toBe(false);
        });

        it('follows the task setting, and the checkbox overrides it', async () => {
            const { renderPlans } = await import('./tab');
            const root = document.getElementById('root')!;
            await renderPlans(
                [ref('busy'), ref('quiet')],
                async r => r.name === 'busy' ? flagged(changed) : flagged(noChange),
                root,
            );
            await settled(root);
            const box = root.querySelector<HTMLInputElement>('#hide-no-change-plans')!;
            expect(box.checked).toBe(true);
            expect(optionTexts(root)).toEqual(['All plans (2)', 'busy']);
            expect(root.querySelector('.selector-toggle-count')?.textContent).toBe('(1 hidden)');

            box.checked = false;
            box.dispatchEvent(new Event('change'));
            expect(optionTexts(root)).toEqual(['All plans (2)', 'busy', 'quiet']);
            expect(root.querySelector('.selector-toggle-count')?.textContent).toBe('');
        });

        it('lets the viewer hide no-change plans even when the task did not ask', async () => {
            const { renderPlans } = await import('./tab');
            const root = document.getElementById('root')!;
            await renderPlans([ref('busy'), ref('quiet')], async r => r.name === 'busy' ? changed : noChange, root);
            await settled(root);
            const box = root.querySelector<HTMLInputElement>('#hide-no-change-plans')!;
            box.checked = true;
            box.dispatchEvent(new Event('change'));
            expect(optionTexts(root)).toEqual(['All plans (2)', 'busy']);
        });

        it('keeps the open plan listed and selected even if it would be hidden', async () => {
            const { renderPlans } = await import('./tab');
            const root = document.getElementById('root')!;
            await renderPlans(
                [ref('busy'), ref('quiet')],
                async r => r.name === 'busy' ? flagged(changed) : flagged(noChange),
                root,
            );
            await settled(root);
            // Reveal unchanged resources and open the quiet plan from its tag.
            [...root.querySelectorAll<HTMLButtonElement>('.control-btn')]
                .find(b => /unchanged/.test(b.textContent ?? ''))!.click();
            const quietTag = [...root.querySelectorAll<HTMLButtonElement>('.plan-tag')].find(t => t.textContent === 'quiet')!;
            quietTag.click();
            await Promise.resolve();

            const select = root.querySelector<HTMLSelectElement>('#plan-select')!;
            expect(optionTexts(root)).toEqual(['All plans (2)', 'busy', 'quiet']);
            expect(select.value).toBe(planId(ref('quiet')));

            select.value = ALL_PLANS_VALUE;
            select.dispatchEvent(new Event('change'));
            await Promise.resolve();
            expect(optionTexts(root)).toEqual(['All plans (2)', 'busy']);
        });

        it('only shows the checkbox once a plan without changes has loaded', async () => {
            const { renderPlans } = await import('./tab');
            const root = document.getElementById('root')!;
            let releaseQuiet: (plan: ReturnType<typeof planWith>) => void = () => undefined;
            const quietLater = new Promise<ReturnType<typeof planWith>>(resolve => { releaseQuiet = resolve; });
            const done = renderPlans([ref('busy'), ref('quiet')], async r => r.name === 'busy' ? changed : quietLater, root);
            const label = () => root.querySelector<HTMLElement>('.selector-toggle')!;

            await vi.waitFor(() => expect(listedRows(root).length).toBe(2));
            expect(label().hidden).toBe(true);

            releaseQuiet(noChange);
            await done;
            await settled(root);
            expect(label().hidden).toBe(false);
        });

        it('never shows the checkbox when every plan has changes', async () => {
            const { renderPlans } = await import('./tab');
            const root = document.getElementById('root')!;
            await renderPlans([ref('a'), ref('b')], async () => changed, root);
            await settled(root);
            expect(root.querySelector<HTMLElement>('.selector-toggle')!.hidden).toBe(true);
        });

        it('has no checkbox for a single plan', async () => {
            const { renderPlans } = await import('./tab');
            const root = document.getElementById('root')!;
            await renderPlans([ref('only')], async () => changed, root);
            expect(root.querySelector('#hide-no-change-plans')).toBeNull();
        });
    });
});
