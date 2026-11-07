import { test, expect, type Page, type Route } from '@playwright/test';

// Browser tests for the All plans overview, driven through the dev harness
// (dev-fixtures/dev.js). The harness tags each fixture download with
// `?plan=<name>&record=<id>`, which lets a test hold one plan's download
// open and release it at a chosen moment.

const DEFAULT_PLANS = [
    'prod-apps-aks-cluster-weu',
    'prod-apps-sql-primary',
    'prod-platform-dns-private-zones',
    'prod-platform-network-hub-vnet',
    'shared-monitoring',
    'staging',
];

interface Downloads {
    /** Plan names in the order their downloads started. */
    started: string[];
    /** Let a held download finish. */
    release(plan: string): Promise<void>;
}

/** Hold the downloads for `held` plans until released; others pass straight through. */
async function controlDownloads(page: Page, held: string[] | 'all'): Promise<Downloads> {
    const started: string[] = [];
    const waiting = new Map<string, Route>();
    const releasedEarly = new Set<string>();

    await page.route(/\.json\?/, async route => {
        const plan = new URL(route.request().url()).searchParams.get('plan') ?? '';
        started.push(plan);
        const hold = held === 'all' || held.includes(plan);
        if (!hold || releasedEarly.has(plan)) {
            await route.continue();
            return;
        }
        waiting.set(plan, route);
    });

    return {
        started,
        async release(plan: string) {
            const route = waiting.get(plan);
            if (!route) {
                releasedEarly.add(plan);
                return;
            }
            waiting.delete(plan);
            await route.continue();
        },
    };
}

/** The resource rows in the combined list that came from `plan`. */
const rowsFrom = (page: Page, plan: string) =>
    page.locator('.overview-list details.resource').filter({ has: page.locator(`.plan-tag:text-is("${plan}")`) });

const settled = (page: Page) => expect(page.locator('.header-meta')).not.toContainText('Loading');

test.describe('All plans overview', () => {
    test('lists every resource change tagged with its plan', async ({ page }) => {
        await page.goto('/dev.html');
        await settled(page);

        await expect(page.locator('h1')).toHaveText('All plans');
        await expect(page.locator('.header-meta')).toContainText('14 resource changes');
        await expect(rowsFrom(page, 'prod-apps-aks-cluster-weu')).toHaveCount(3);
        await expect(rowsFrom(page, 'prod-platform-network-hub-vnet')).toHaveCount(4);
        await expect(rowsFrom(page, 'staging')).toHaveCount(8);
        // Plans without changes contribute no rows while unchanged resources are hidden.
        await expect(rowsFrom(page, 'prod-apps-sql-primary')).toHaveCount(0);

        // Expanding a row shows its diff in place.
        const aks = rowsFrom(page, 'prod-apps-aks-cluster-weu').first();
        await aks.locator('.resource-summary').click();
        await expect(aks.locator('.diff')).toContainText('kubernetes_version');

        // The plan tag opens that plan's detail view.
        await aks.locator('.plan-tag').click();
        await expect(page.locator('h1')).toHaveText('Terraform Plan');
        await expect(page.locator('#plan-select option:checked')).toHaveText('prod-apps-aks-cluster-weu');
    });

    test('tags same-name attachments distinctly and lists their outputs', async ({ page }) => {
        await page.goto('/dev.html?scenario=edge');
        await settled(page);

        await expect(rowsFrom(page, 'prod (abcd1234)')).toHaveCount(8);
        await expect(rowsFrom(page, 'prod (ef567890)')).toHaveCount(8);
        const options = page.locator('#plan-select option');
        await expect(options).toHaveText(['All plans (4)', 'outputs', 'prod (abcd1234)', 'prod (ef567890)', 'quiet']);

        const outputOnly = page.locator('.outputs .output-row').filter({ has: page.locator('.plan-tag:text-is("outputs")') });
        await expect(outputOnly).toHaveCount(1);
        await expect(outputOnly.locator('.output-name')).toHaveText('app_url');
    });

    test('keeps an expanded, focused row while background downloads finish', async ({ page }) => {
        const downloads = await controlDownloads(page, ['staging']);
        await page.goto('/dev.html');

        const aks = rowsFrom(page, 'prod-apps-aks-cluster-weu').first();
        await expect(aks).toBeVisible();
        await aks.locator('.resource-summary').focus();
        await page.keyboard.press('Enter');
        await expect(aks).toHaveAttribute('open', '');

        await downloads.release('staging');
        await settled(page);
        await expect(rowsFrom(page, 'staging').first()).toBeVisible();
        const after = rowsFrom(page, 'prod-apps-aks-cluster-weu').first();
        await expect(after).toHaveAttribute('open', '');
        await expect(after.locator('.resource-summary')).toBeFocused();
    });

    test('keeps a nested "unchanged attributes" section open and focused while plans load', async ({ page }) => {
        const downloads = await controlDownloads(page, ['staging']);
        await page.goto('/dev.html');

        const aks = rowsFrom(page, 'prod-apps-aks-cluster-weu').first();
        await aks.locator('.resource-summary').click();
        const nested = aks.locator('details.diff-unchanged');
        await nested.locator('summary').click();
        await expect(nested).toHaveAttribute('open', '');
        await nested.locator('summary').focus();

        await downloads.release('staging');
        await settled(page);
        await expect(rowsFrom(page, 'staging').first()).toBeVisible();
        const nestedAfter = rowsFrom(page, 'prod-apps-aks-cluster-weu').first().locator('details.diff-unchanged');
        await expect(nestedAfter).toHaveAttribute('open', '');
        await expect(nestedAfter.locator('summary')).toBeFocused();
    });

    test('keeps the reading position when an earlier plan finishes loading', async ({ page }) => {
        await page.setViewportSize({ width: 1200, height: 500 });
        const downloads = await controlDownloads(page, ['prod-apps-aks-cluster-weu']);
        await page.goto('/dev.html');

        const target = rowsFrom(page, 'staging').nth(4);
        await expect(target).toBeVisible();
        await target.scrollIntoViewIfNeeded();
        await page.evaluate(() => window.scrollBy(0, -100));
        const before = (await target.boundingBox())!.y;

        // aks sorts first, so its rows are inserted above the reader.
        await downloads.release('prod-apps-aks-cluster-weu');
        await settled(page);
        await expect(rowsFrom(page, 'prod-apps-aks-cluster-weu')).toHaveCount(3);
        const after = (await rowsFrom(page, 'staging').nth(4).boundingBox())!.y;
        expect(Math.abs(after - before)).toBeLessThan(2);
    });

    test('keeps focus on a summary card after toggling it with the keyboard', async ({ page }) => {
        await page.goto('/dev.html');
        await settled(page);

        await page.locator('.summary-delete').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.summary-delete')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.summary-delete')).toBeFocused();
        await expect(page.locator('.overview-list .action-badge')).toHaveText(['Delete', 'Delete']);
    });

    test('does not lose a click when a download finishes mid-click', async ({ page }) => {
        const downloads = await controlDownloads(page, ['staging']);
        await page.goto('/dev.html');

        const tag = rowsFrom(page, 'prod-apps-aks-cluster-weu').first().locator('.plan-tag');
        await expect(tag).toBeVisible();
        const box = (await tag.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();

        // A background download lands between mousedown and mouseup.
        await downloads.release('staging');
        await page.waitForTimeout(150);

        await page.mouse.up();
        await expect(page.locator('h1')).toHaveText('Terraform Plan');
        await expect(page.locator('#plan-select option:checked')).toHaveText('prod-apps-aks-cluster-weu');
    });

    test('pauses background downloads while a plan the user opened is loading', async ({ page }) => {
        const downloads = await controlDownloads(page, 'all');
        await page.goto('/dev.html');

        // The background pool starts its first batch (concurrency 4).
        await expect.poll(() => downloads.started).toEqual(DEFAULT_PLANS.slice(0, 4));

        await page.locator('#plan-select').selectOption({ label: 'staging' });
        await expect.poll(() => downloads.started).toContain('staging');

        // A background slot frees up, but no new background download may start.
        await downloads.release(DEFAULT_PLANS[0]);
        await page.waitForTimeout(300);
        expect(downloads.started).not.toContain('shared-monitoring');

        await downloads.release('staging');
        await expect(page.locator('h1')).toHaveText('Terraform Plan');
        await expect.poll(() => downloads.started).toContain('shared-monitoring');
    });
    test('hides plans without changes from the dropdown when the task asks', async ({ page }) => {
        await page.goto('/dev.html?hide=1');
        await settled(page);

        const box = page.getByRole('checkbox', { name: /Hide plans without changes/ });
        await expect(box).toBeChecked();
        await expect(page.locator('.selector-toggle-count')).toHaveText('(3 hidden)');
        await expect(page.locator('#plan-select option')).toHaveText([
            'All plans (6)', 'prod-apps-aks-cluster-weu', 'prod-platform-network-hub-vnet', 'staging',
        ]);

        await box.uncheck();
        await expect(page.locator('#plan-select option')).toHaveCount(7);
        await expect(page.locator('.selector-toggle-count')).toHaveText('');
    });

    test('shows the hide checkbox only once a plan without changes has loaded', async ({ page }) => {
        const quiet = ['prod-apps-sql-primary', 'prod-platform-dns-private-zones', 'shared-monitoring'];
        const downloads = await controlDownloads(page, quiet);
        await page.goto('/dev.html');

        const box = page.getByRole('checkbox', { name: /Hide plans without changes/ });
        await expect(rowsFrom(page, 'staging').first()).toBeVisible();
        // Only plans with changes have loaded so far: nothing to hide yet.
        await expect(box).toBeHidden();

        await downloads.release(quiet[0]);
        await expect(box).toBeVisible();
        for (const q of quiet.slice(1)) await downloads.release(q);
        await settled(page);
        await expect(box).toBeVisible();
    });

    test('keeps the dropdown the same width when plans are hidden or shown', async ({ page }) => {
        await page.goto('/dev.html');
        await settled(page);
        const width = () => page.locator('#plan-select').evaluate(e => e.getBoundingClientRect().width);
        const box = page.getByRole('checkbox', { name: /Hide plans without changes/ });

        const listed = await width();
        await box.check();
        await expect(page.locator('.selector-toggle-count')).toHaveText('(3 hidden)');
        expect(await width()).toBe(listed);
        await box.uncheck();
        expect(await width()).toBe(listed);
    });

    for (const [label, query] of [['All plans', ''], ['edge cases', '?scenario=edge'], ['single plan', '?single=1']]) {
        test(`fits a narrow screen without sideways scrolling (${label})`, async ({ page }) => {
            await page.setViewportSize({ width: 360, height: 800 });
            await page.goto('/dev.html' + query);
            await expect(page.locator('.resource-summary').first()).toBeVisible();
            await expect(page.locator('.header-meta')).not.toContainText('Loading');
            await page.locator('.resource-summary').first().click();

            const widths = await page.evaluate(() => ({
                page: document.documentElement.scrollWidth,
                viewport: window.innerWidth,
            }));
            expect(widths.page).toBeLessThanOrEqual(widths.viewport);

            // Every plan tag and address stays inside its row.
            const escaped = await page.evaluate(() =>
                [...document.querySelectorAll('.resource-summary, .output-row')].flatMap(row => {
                    const box = row.getBoundingClientRect();
                    return [...row.querySelectorAll('.plan-tag, .resource-address, .resource-type, .output-value')]
                        .filter(e => e.getBoundingClientRect().right > box.right + 0.5)
                        .map(e => e.textContent);
                }));
            expect(escaped).toEqual([]);
        });
    }
});
