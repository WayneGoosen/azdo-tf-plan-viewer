// =============================================================================
// Terraform Plan Viewer — tab renderer
//
// Renders the Terraform plan attached by the TerraformPlanViewer task as a
// structured, searchable view. Uses the modern Azure DevOps Extension SDK
// (`azure-devops-extension-sdk` + `azure-devops-extension-api`) bundled by
// esbuild. All plan content is rendered via DOM APIs (textContent / createElement)
// so plan content is never interpolated as HTML.
// =============================================================================

import * as SDK from 'azure-devops-extension-sdk';
import {
    CommonServiceIds,
    IProjectPageService,
    getClient,
} from 'azure-devops-extension-api';
import {
    BuildRestClient,
    BuildServiceIds,
    IBuildPageDataService,
} from 'azure-devops-extension-api/Build';
import {
    type ActionKind,
    type AttrDiff,
    type ModuleNode,
    type ResourceChange,
    type ResourceDiff,
    addCounts,
    buildTree,
    classifyAction,
    computeDiff,
    emptyCounts,
    formatReplacePath,
    formatValue,
} from './planLogic';
import {
    ALL_PLANS_VALUE,
    type OverviewFilter,
    type PlanSummary,
    defaultSelectorValue,
    dominantAction,
    errorSummary,
    groupPlanNames,
    hiddenNoChangeCount,
    loadedSummary,
    pendingSummary,
    uniqueTerraformVersions,
    visibleGroups,
} from './overviewLogic';

const ATTACHMENT_TYPE = 'terraform-plan-viewer.plan';

/** Parallel attachment downloads when filling the All-plans overview. */
const OVERVIEW_FETCH_CONCURRENCY = 6;

// ----------------------------- Type definitions -----------------------------

interface TerraformPlan {
    format_version?: string;
    terraform_version?: string;
    resource_changes?: ResourceChange[];
    output_changes?: Record<string, OutputChange>;
    resource_drift?: ResourceChange[];
}

interface OutputChange {
    actions: string[];
    before: unknown;
    after: unknown;
    after_unknown?: boolean;
    before_sensitive?: boolean;
    after_sensitive?: boolean;
}

// Loose attachment shape — _links is typed `any` upstream, so we narrow here.
interface AttachmentLite {
    name: string;
    _links?: { self?: { href?: string } };
}

// A plan attachment we can fetch on demand. Captured at bootstrap so the
// selector can switch plans without re-listing or re-parsing URLs.
interface PlanRef {
    name: string;
    projectId: string;
    buildId: number;
    timelineId: string;
    recordId: string;
}

// ------------------------------ Classification ------------------------------

const ACTION_LABEL: Record<ActionKind, string> = {
    create: 'Create',
    update: 'Update',
    delete: 'Delete',
    recreate: 'Recreate',
    read: 'Read',
    noop: 'No change',
};

const ACTION_GLYPH: Record<ActionKind, string> = {
    create: '+',
    update: '~',
    delete: '−',
    recreate: '±',
    read: '?',
    noop: '·',
};

// ------------------------------- DOM helpers --------------------------------

type Child = HTMLElement | string | null | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: { class?: string; text?: string; attrs?: Record<string, string> } = {},
    children: Child[] = []
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (options.class) node.className = options.class;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.attrs) {
        for (const [k, v] of Object.entries(options.attrs)) node.setAttribute(k, v);
    }
    for (const child of children) {
        if (child === null || child === undefined) continue;
        if (typeof child === 'string') node.appendChild(document.createTextNode(child));
        else node.appendChild(child);
    }
    return node;
}

function clear(node: HTMLElement) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

// --------------------------------- State ------------------------------------

interface RenderState {
    plan: TerraformPlan;
    tree: ModuleNode;
    activeFilters: Set<ActionKind>;
    searchTerm: string;
    showNoop: boolean;
    treeContainer: HTMLElement;
}

function matchesFilter(state: RenderState, r: ResourceChange): boolean {
    const kind = classifyAction(r.change.actions);
    // No-op resources are hidden by default: `terraform show -json` emits one
    // for every resource in state, so showing them buries the actual changes.
    // The "show unchanged" toggle flips state.showNoop to reveal them.
    if (kind === 'noop' && !state.showNoop) return false;
    const filterOk = state.activeFilters.size === 0 || state.activeFilters.has(kind);
    if (!filterOk) return false;
    if (!state.searchTerm) return true;
    const q = state.searchTerm.toLowerCase();
    return r.address.toLowerCase().includes(q) || r.type.toLowerCase().includes(q);
}

// ------------------------------- Rendering ----------------------------------

export function renderPlan(plan: TerraformPlan, root: HTMLElement) {
    clear(root);

    const tree = buildTree(plan.resource_changes ?? []);
    const treeContainer = el('div', { class: 'tree' });

    const state: RenderState = {
        plan,
        tree,
        activeFilters: new Set(),
        searchTerm: '',
        showNoop: false,
        treeContainer,
    };

    root.appendChild(renderHeader(plan));
    root.appendChild(renderSummary(state));
    root.appendChild(renderControls(state));
    root.appendChild(treeContainer);
    rerenderTree(state);

    if (plan.output_changes && Object.keys(plan.output_changes).length) {
        root.appendChild(renderOutputs(plan.output_changes));
    }
}

function renderHeader(plan: TerraformPlan): HTMLElement {
    const total = plan.resource_changes?.length ?? 0;
    return el('header', { class: 'header' }, [
        el('h1', { text: 'Terraform Plan' }),
        el('div', { class: 'header-meta' }, [
            plan.terraform_version ? el('span', { class: 'meta-pill', text: `Terraform ${plan.terraform_version}` }) : null,
            plan.format_version ? el('span', { class: 'meta-pill', text: `Format ${plan.format_version}` }) : null,
            el('span', { class: 'meta-pill', text: `${total} resource ${total === 1 ? 'change' : 'changes'}` }),
        ]),
    ]);
}

function renderActionCards(
    counts: Record<ActionKind, number>,
    activeFilters: ReadonlySet<ActionKind>,
    onToggle: (kind: ActionKind) => void,
): HTMLElement {
    const card = (kind: ActionKind, label: string) => {
        const isActive = activeFilters.has(kind);
        const c = el('button', {
            class: `summary-card summary-${kind}` + (isActive ? ' is-active' : ''),
            attrs: { type: 'button', 'aria-pressed': isActive ? 'true' : 'false' },
        }, [
            el('span', { class: 'summary-count', text: String(counts[kind]) }),
            el('span', { class: 'summary-label', text: label }),
        ]);
        c.addEventListener('click', () => onToggle(kind));
        return c;
    };

    return el('section', { class: 'summary' }, [
        card('create', 'Create'),
        card('update', 'Update'),
        card('recreate', 'Recreate'),
        card('delete', 'Delete'),
    ]);
}

function renderSummary(state: RenderState): HTMLElement {
    return renderActionCards(state.tree.counts, state.activeFilters, kind => toggleFilter(state, kind));
}

function toggleFilter(state: RenderState, kind: ActionKind) {
    if (state.activeFilters.has(kind)) state.activeFilters.delete(kind);
    else state.activeFilters.add(kind);
    rerenderSummary(state);
    rerenderTree(state);
}

function rerenderSummary(state: RenderState) {
    const old = document.querySelector('.summary');
    if (!old || !old.parentElement) return;
    const next = renderSummary(state);
    old.parentElement.replaceChild(next, old);
}

function renderControls(state: RenderState): HTMLElement {
    const search = el('input', {
        class: 'search',
        attrs: { type: 'search', placeholder: 'Filter by address or type…', 'aria-label': 'Filter resources' },
    }) as HTMLInputElement;

    let debounce: number | undefined;
    search.addEventListener('input', () => {
        if (debounce !== undefined) window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
            state.searchTerm = search.value.trim();
            rerenderTree(state);
        }, 80);
    });

    const expandAll = el('button', { class: 'control-btn', text: 'Expand all', attrs: { type: 'button' } });
    expandAll.addEventListener('click', () => {
        state.treeContainer.querySelectorAll<HTMLDetailsElement>('details').forEach(d => { d.open = true; });
    });

    const collapseAll = el('button', { class: 'control-btn', text: 'Collapse all', attrs: { type: 'button' } });
    collapseAll.addEventListener('click', () => {
        state.treeContainer.querySelectorAll<HTMLDetailsElement>('details').forEach(d => { d.open = false; });
    });

    const buttons = [expandAll, collapseAll];

    // Only offer the unchanged-resources toggle when the plan actually carries
    // no-op entries, so the control stays absent on plans that have none.
    const noopCount = state.tree.counts.noop;
    if (noopCount > 0) {
        const noun = noopCount === 1 ? 'unchanged resource' : 'unchanged resources';
        const noopToggle = el('button', {
            class: 'control-btn',
            attrs: { type: 'button', 'aria-pressed': state.showNoop ? 'true' : 'false' },
        }) as HTMLButtonElement;
        const syncLabel = () => {
            noopToggle.textContent = `${state.showNoop ? 'Hide' : 'Show'} ${noopCount} ${noun}`;
            noopToggle.setAttribute('aria-pressed', state.showNoop ? 'true' : 'false');
            noopToggle.classList.toggle('is-active', state.showNoop);
        };
        noopToggle.addEventListener('click', () => {
            state.showNoop = !state.showNoop;
            syncLabel();
            rerenderTree(state);
        });
        syncLabel();
        buttons.push(noopToggle);
    }

    return el('section', { class: 'controls' }, [
        search,
        el('div', { class: 'control-buttons' }, buttons),
    ]);
}

function rerenderTree(state: RenderState) {
    clear(state.treeContainer);

    if (!state.plan.resource_changes || state.plan.resource_changes.length === 0) {
        state.treeContainer.appendChild(el('div', {
            class: 'empty',
            text: 'No resource changes in this plan. Infrastructure matches the configuration.',
        }));
        return;
    }

    const visible = renderModuleNode(state.tree, state, /* depth */ 0, /* isRoot */ true);
    if (!visible) {
        state.treeContainer.appendChild(el('div', {
            class: 'empty',
            text: 'No resources match the current filter.',
        }));
        return;
    }
    state.treeContainer.appendChild(visible);
}

function renderModuleNode(node: ModuleNode, state: RenderState, depth: number, isRoot: boolean): HTMLElement | null {
    const visibleResources = node.resources.filter(r => matchesFilter(state, r));
    const renderedChildren: HTMLElement[] = [];
    for (const child of node.children.values()) {
        const rendered = renderModuleNode(child, state, depth + 1, false);
        if (rendered) renderedChildren.push(rendered);
    }
    if (visibleResources.length === 0 && renderedChildren.length === 0) return null;

    if (isRoot) {
        const container = el('div', { class: 'module-root' });
        for (const r of visibleResources) container.appendChild(renderResource(r));
        for (const c of renderedChildren) container.appendChild(c);
        return container;
    }

    const summary = el('summary', { class: 'module-summary' }, [
        el('span', { class: 'module-label', text: node.label }),
        renderCountPills(node.counts),
    ]);

    const shouldOpen = state.searchTerm.length > 0 || depth === 1;
    const details = el('details', { class: 'module-node' });
    if (shouldOpen) details.open = true;
    details.appendChild(summary);

    const body = el('div', { class: 'module-body' });
    for (const r of visibleResources) body.appendChild(renderResource(r));
    for (const c of renderedChildren) body.appendChild(c);
    details.appendChild(body);

    return details;
}

function renderCountPills(counts: Record<ActionKind, number>): HTMLElement {
    const pills = el('span', { class: 'count-pills' });
    const order: ActionKind[] = ['create', 'update', 'recreate', 'delete'];
    for (const k of order) {
        if (counts[k] === 0) continue;
        pills.appendChild(el('span', {
            class: `count-pill count-${k}`,
            text: `${ACTION_GLYPH[k]}${counts[k]}`,
            attrs: { title: ACTION_LABEL[k] },
        }));
    }
    return pills;
}

function renderResource(r: ResourceChange): HTMLElement {
    const kind = classifyAction(r.change.actions);
    const summary = el('summary', { class: 'resource-summary' }, [
        el('span', { class: `action-badge action-${kind}`, text: ACTION_LABEL[kind] }),
        el('code', { class: 'resource-address', text: r.address }),
        el('span', { class: 'resource-type', text: r.type }),
    ]);

    const body = el('div', { class: 'resource-body' });

    const replacePaths = r.change.replace_paths ?? [];
    if (kind === 'recreate' && replacePaths.length) {
        body.appendChild(renderReplaceReasons(replacePaths));
    }

    const diff = computeDiff(r.change);
    if (diff.changed.length || diff.unchanged.length) {
        body.appendChild(renderDiff(diff, kind));
    } else if (kind !== 'noop') {
        body.appendChild(el('div', { class: 'no-diff', text: 'No attribute-level changes reported.' }));
    }

    const details = el('details', { class: `resource resource-${kind}` });
    details.appendChild(summary);
    details.appendChild(body);
    return details;
}

function renderReplaceReasons(paths: unknown[][]): HTMLElement {
    const list = el('ul', { class: 'replace-reasons' });
    for (const p of paths) {
        list.appendChild(el('li', { text: formatReplacePath(p) }));
    }
    return el('div', { class: 'replace-section' }, [
        el('div', { class: 'replace-title', text: 'Replacement triggered by:' }),
        list,
    ]);
}

function renderDiff(diff: ResourceDiff, kind: ActionKind): HTMLElement {
    // For pure create/delete resources, hide the empty side so the layout
    // doesn't get a column of dashes carrying no information.
    const hideBefore = kind === 'create';
    const hideAfter = kind === 'delete';
    const layoutClass = hideBefore ? ' diff-after-only'
        : hideAfter ? ' diff-before-only' : '';

    const wrap = el('div', { class: `diff${layoutClass}` });

    if (diff.changed.length) {
        wrap.appendChild(renderDiffGrid(diff.changed, /* unchanged */ false));
    }

    if (diff.unchanged.length) {
        const summary = el('summary', { class: 'diff-unchanged-summary' }, [
            el('span', { class: 'diff-unchanged-caret' }),
            el('span', {
                text: `${diff.unchanged.length} unchanged ${diff.unchanged.length === 1 ? 'attribute' : 'attributes'} hidden`,
            }),
        ]);
        const details = el('details', { class: 'diff-unchanged' });
        details.appendChild(summary);
        details.appendChild(renderDiffGrid(diff.unchanged, /* unchanged */ true));
        wrap.appendChild(details);
    }

    return wrap;
}

function renderDiffGrid(rows: AttrDiff[], unchanged: boolean): HTMLElement {
    const grid = el('div', { class: 'diff-grid' + (unchanged ? ' diff-grid-unchanged' : '') });
    for (const d of rows) {
        const rowClass = d.kind === '+' ? 'diff-add'
            : d.kind === '-' ? 'diff-del'
            : d.kind === '~' ? 'diff-mod'
            : 'diff-eq';
        const row = el('div', { class: `diff-row ${rowClass}` });
        row.appendChild(el('span', { class: 'diff-glyph', text: d.kind === '=' ? '' : d.kind }));
        row.appendChild(el('span', { class: 'diff-key', text: d.key }));
        row.appendChild(renderDiffCell(d.before, 'before', d.kind));
        row.appendChild(renderDiffCell(d.after, 'after', d.kind));
        grid.appendChild(row);
    }
    return grid;
}

function renderDiffCell(value: string | undefined, side: 'before' | 'after', kind: AttrDiff['kind']): HTMLElement {
    const cls = side === 'before' ? 'diff-before' : 'diff-after';
    // `+` rows have no before, `-` rows have no after — render an em-dash so
    // the cell still occupies its grid track and the columns stay aligned.
    if (value === undefined) {
        return el('span', { class: `${cls} diff-empty`, text: '—' });
    }
    // Suppress the redundant repeat in the unchanged section: same value
    // shows on the left, the right column shows a soft "·" placeholder.
    if (kind === '=' && side === 'after') {
        return el('span', { class: `${cls} diff-eq-after`, text: '·' });
    }
    return el('span', { class: cls, text: value });
}

function renderOutputs(outputs: Record<string, OutputChange>): HTMLElement {
    const section = el('section', { class: 'outputs' }, [
        el('h2', { text: 'Outputs' }),
    ]);
    const list = el('div', { class: 'outputs-list' });
    for (const name of Object.keys(outputs).sort((a, b) => a.localeCompare(b))) {
        const o = outputs[name];
        const kind = classifyAction(o.actions);
        const row = el('div', { class: 'output-row' }, [
            el('span', { class: `action-badge action-${kind}`, text: ACTION_LABEL[kind] }),
            el('code', { class: 'output-name', text: name }),
        ]);
        if (kind !== 'noop') {
            const valueText = o.after_sensitive ? '(sensitive)'
                : o.after_unknown ? '(known after apply)'
                : formatValue(o.after);
            row.appendChild(el('span', { class: 'output-value', text: valueText }));
        }
        list.appendChild(row);
    }
    section.appendChild(list);
    return section;
}

// ------------------------------- Networking ---------------------------------

async function listPlans(): Promise<PlanRef[]> {
    const projectService = await SDK.getService<IProjectPageService>(CommonServiceIds.ProjectPageService);
    const buildService = await SDK.getService<IBuildPageDataService>(BuildServiceIds.BuildPageDataService);

    const project = await projectService.getProject();
    const buildPageData = await buildService.getBuildPageData();

    if (!project) throw new Error('Project context unavailable.');
    const buildId = buildPageData?.build?.id;
    if (typeof buildId !== 'number') throw new Error('Build context unavailable.');

    const projectId = project.id;
    const client = getClient(BuildRestClient);
    const attachments = (await client.getAttachments(projectId, buildId, ATTACHMENT_TYPE)) as AttachmentLite[];

    if (!attachments?.length) {
        throw new Error('No Terraform plan was attached to this build. ' +
            'Make sure the TerraformPlanViewer task ran successfully in the pipeline.');
    }

    const refs: PlanRef[] = [];
    for (const att of attachments) {
        const href = att._links?.self?.href;
        if (!href) continue;
        // Both URL shapes (dev.azure.com and *.visualstudio.com) embed timeline +
        // record IDs as /builds/{buildId}/{timelineId}/{recordId}/attachments/...
        const m = href.match(/\/builds\/\d+\/([0-9a-fA-F-]+)\/([0-9a-fA-F-]+)\/attachments\//);
        if (!m) continue;
        refs.push({ name: att.name, projectId, buildId, timelineId: m[1], recordId: m[2] });
    }
    if (!refs.length) throw new Error('Plan attachments are missing usable download links.');

    refs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return refs;
}

async function fetchPlanContent(ref: PlanRef): Promise<TerraformPlan> {
    const client = getClient(BuildRestClient);
    const buf = await client.getAttachment(
        ref.projectId, ref.buildId, ref.timelineId, ref.recordId, ATTACHMENT_TYPE, ref.name
    );
    const text = new TextDecoder().decode(buf);
    try {
        return JSON.parse(text);
    } catch (e: any) {
        throw new Error(`Plan attachment "${ref.name}" is not valid JSON: ${e?.message ?? e}`);
    }
}

// ------------------------------- Selector + body ---------------------------

// Public type so the dev harness can inject a mock fetcher without depending
// on the live ADO SDK. The orchestrator below is identical in both modes.
export type PlanFetcher = (ref: PlanRef) => Promise<TerraformPlan>;

type View = { kind: 'all' } | { kind: 'plan'; ref: PlanRef };

interface OverviewSession {
    onlyWithChanges: boolean;
    searchTerm: string;
    activeFilters: Set<ActionKind>;
    groups: ReturnType<typeof groupPlanNames>;
    summaries: Map<string, PlanSummary>;
    mounted: {
        summaryHost: HTMLElement;
        metaHost: HTMLElement;
        listHost: HTMLElement;
        hiddenHost: HTMLElement;
    } | null;
}

export async function renderPlans(inputRefs: PlanRef[], fetcher: PlanFetcher, root: HTMLElement) {
    if (inputRefs.length === 0) {
        showStatusInto(root, 'No Terraform plan was attached to this build.', '', 'error');
        return;
    }

    const refs = [...inputRefs].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    clear(root);

    // Persistent header (selector) + swappable body. Switching a plan only
    // re-renders the body, so the dropdown never flashes or loses focus.
    const selectorBar = el('div', { class: 'plan-selector-bar' });
    const body = el('div', { class: 'plan-body' });
    root.appendChild(selectorBar);
    root.appendChild(body);

    const cache = new Map<string, TerraformPlan>();
    const inflight = new Map<string, Promise<TerraformPlan>>();
    const summaries = new Map<string, PlanSummary>();
    for (const ref of refs) summaries.set(ref.name, pendingSummary(ref.name));

    const overview: OverviewSession = {
        onlyWithChanges: true,
        searchTerm: '',
        activeFilters: new Set(),
        groups: groupPlanNames(refs.map(r => r.name)),
        summaries,
        mounted: null,
    };

    let select: HTMLSelectElement | null = null;
    let current: View = refs.length > 1
        ? { kind: 'all' }
        : { kind: 'plan', ref: refs[0] };
    let overviewFetchStarted = false;

    const fetchOne = (ref: PlanRef): Promise<TerraformPlan> => {
        const cached = cache.get(ref.name);
        if (cached) return Promise.resolve(cached);
        const existing = inflight.get(ref.name);
        if (existing) return existing;
        const p = fetcher(ref).then(plan => {
            cache.set(ref.name, plan);
            summaries.set(ref.name, loadedSummary(ref.name, plan));
            inflight.delete(ref.name);
            return plan;
        }, err => {
            inflight.delete(ref.name);
            throw err;
        });
        inflight.set(ref.name, p);
        return p;
    };

    const filterOf = (): OverviewFilter => ({
        search: overview.searchTerm,
        onlyWithChanges: overview.onlyWithChanges,
        actionFilters: overview.activeFilters,
    });

    const patchOverview = () => {
        if (current.kind !== 'all' || !overview.mounted) return;
        const { summaryHost, metaHost, listHost, hiddenHost } = overview.mounted;
        clear(metaHost);
        fillOverviewMeta(metaHost, refs.length, [...summaries.values()]);
        clear(summaryHost);
        summaryHost.appendChild(renderOverviewSummary(overview, patchOverview));
        clear(listHost);
        listHost.appendChild(renderOverviewList(overview, name => {
            const ref = refs.find(r => r.name === name);
            if (ref) void switchTo({ kind: 'plan', ref });
        }));
        clear(hiddenHost);
        const hidden = hiddenNoChangeCount([...summaries.values()], filterOf());
        if (hidden > 0 && overview.onlyWithChanges) {
            hiddenHost.appendChild(renderHiddenBanner(hidden, () => {
                overview.onlyWithChanges = false;
                const toggle = body.querySelector<HTMLInputElement>('.toggle-input');
                if (toggle) toggle.checked = false;
                patchOverview();
            }));
        }
    };

    const showOverview = () => {
        overview.mounted = null;
        clear(body);
        const metaHost = el('div', { class: 'header-meta' });
        const summaryHost = el('div');
        const listHost = el('div');
        const hiddenHost = el('div');
        overview.mounted = { summaryHost, metaHost, listHost, hiddenHost };

        body.appendChild(el('header', { class: 'header' }, [
            el('h1', { text: 'All plans' }),
            metaHost,
        ]));
        body.appendChild(summaryHost);
        body.appendChild(renderOverviewControls(overview, patchOverview));
        body.appendChild(listHost);
        body.appendChild(hiddenHost);
        patchOverview();
        void loadAllForOverview();
    };

    const loadAllForOverview = async () => {
        if (overviewFetchStarted) return;
        overviewFetchStarted = true;
        const pending = refs.filter(r => !cache.has(r.name));
        let cursor = 0;
        const worker = async () => {
            while (cursor < pending.length) {
                const ref = pending[cursor++];
                try {
                    await fetchOne(ref);
                } catch (err: any) {
                    summaries.set(ref.name, errorSummary(ref.name, err?.message ?? String(err)));
                }
                patchOverview();
            }
        };
        const n = Math.min(OVERVIEW_FETCH_CONCURRENCY, pending.length);
        if (n > 0) await Promise.all(Array.from({ length: n }, () => worker()));
    };

    const switchTo = async (view: View) => {
        current = view;
        if (select) select.value = view.kind === 'all' ? ALL_PLANS_VALUE : view.ref.name;

        if (view.kind === 'all') {
            showOverview();
            return;
        }

        overview.mounted = null;
        const ref = view.ref;
        if (cache.has(ref.name)) {
            renderPlan(cache.get(ref.name)!, body);
            return;
        }

        if (select) select.disabled = true;
        showLoadingStage(body, `Loading plan: ${ref.name}…`, { skeleton: true });
        try {
            const plan = await fetchOne(ref);
            if (current.kind === 'plan' && current.ref === ref) renderPlan(plan, body);
        } catch (err: any) {
            summaries.set(ref.name, errorSummary(ref.name, err?.message ?? String(err)));
            if (current.kind === 'plan' && current.ref === ref) {
                showStatusInto(body, 'Could not load Terraform plan',
                    err?.message ?? String(err), 'error');
            }
        } finally {
            if (select) select.disabled = false;
        }
    };

    if (refs.length > 1) {
        select = renderSelector(refs, defaultSelectorValue(refs), value => {
            if (value === ALL_PLANS_VALUE) {
                void switchTo({ kind: 'all' });
                return;
            }
            const next = refs.find(r => r.name === value);
            if (next) void switchTo({ kind: 'plan', ref: next });
        });
        selectorBar.appendChild(el('label', { class: 'plan-selector', attrs: { for: 'plan-select' } }, [
            el('span', { class: 'plan-selector-label', text: 'Plan' }),
            select,
        ]));
    }

    await switchTo(current);
}

function renderSelector(refs: PlanRef[], currentValue: string, onChange: (value: string) => void): HTMLSelectElement {
    const select = el('select', {
        class: 'plan-selector-input',
        attrs: { id: 'plan-select', 'aria-label': 'Select Terraform plan' },
    });

    const all = el('option', {
        text: `All plans (${refs.length})`,
        attrs: { value: ALL_PLANS_VALUE },
    });
    if (currentValue === ALL_PLANS_VALUE) all.selected = true;
    select.appendChild(all);

    for (const ref of refs) {
        const opt = el('option', { text: ref.name, attrs: { value: ref.name } });
        if (ref.name === currentValue) opt.selected = true;
        select.appendChild(opt);
    }

    select.addEventListener('change', () => onChange(select.value));
    return select;
}

function fillOverviewMeta(host: HTMLElement, total: number, summaries: PlanSummary[]) {
    const loaded = summaries.filter(s => s.status === 'loaded');
    const withChanges = loaded.filter(s => s.hasChanges).length;
    const noChanges = loaded.filter(s => s.hasChanges === false).length;
    const pending = summaries.filter(s => s.status === 'pending').length;
    const failed = summaries.filter(s => s.status === 'error').length;

    host.appendChild(el('span', {
        class: 'meta-pill',
        text: `${total} ${total === 1 ? 'plan' : 'plans'}`,
    }));
    host.appendChild(el('span', {
        class: 'meta-pill',
        text: `${withChanges} with changes`,
    }));
    host.appendChild(el('span', {
        class: 'meta-pill',
        text: `${noChanges} no changes`,
    }));
    const versions = uniqueTerraformVersions(summaries);
    if (versions.length === 1) {
        host.appendChild(el('span', { class: 'meta-pill', text: `Terraform ${versions[0]}` }));
    } else if (versions.length > 1) {
        host.appendChild(el('span', { class: 'meta-pill', text: 'Mixed Terraform versions' }));
    }
    if (pending > 0) {
        host.appendChild(el('span', {
            class: 'meta-pill',
            text: `Loading ${loaded.length + failed}/${total}…`,
        }));
    }
    if (failed > 0) {
        host.appendChild(el('span', {
            class: 'meta-pill meta-pill-error',
            text: `${failed} failed to load`,
        }));
    }
}

function renderOverviewSummary(session: OverviewSession, onChange: () => void): HTMLElement {
    let counts = emptyCounts();
    for (const s of session.summaries.values()) counts = addCounts(counts, s.counts);
    return renderActionCards(counts, session.activeFilters, kind => {
        if (session.activeFilters.has(kind)) session.activeFilters.delete(kind);
        else session.activeFilters.add(kind);
        onChange();
    });
}

function renderOverviewControls(session: OverviewSession, onChange: () => void): HTMLElement {
    const search = el('input', {
        class: 'search',
        attrs: {
            type: 'search',
            placeholder: 'Filter plans, resource addresses or types…',
            'aria-label': 'Filter plans',
            value: session.searchTerm,
        },
    }) as HTMLInputElement;

    let debounce: number | undefined;
    search.addEventListener('input', () => {
        if (debounce !== undefined) window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
            session.searchTerm = search.value.trim();
            onChange();
        }, 80);
    });

    const toggle = el('label', { class: 'toggle' }, [
        el('input', {
            class: 'toggle-input',
            attrs: {
                type: 'checkbox',
                'aria-label': 'Only plans with changes',
                ...(session.onlyWithChanges ? { checked: '' } : {}),
            },
        }),
        el('span', { class: 'toggle-track', attrs: { 'aria-hidden': 'true' } }),
        el('span', { text: 'Only plans with changes' }),
    ]);
    const checkbox = toggle.querySelector('.toggle-input') as HTMLInputElement;
    checkbox.addEventListener('change', () => {
        session.onlyWithChanges = checkbox.checked;
        onChange();
    });

    const expandAll = el('button', { class: 'control-btn', text: 'Expand all', attrs: { type: 'button' } });
    expandAll.addEventListener('click', () => {
        session.mounted?.listHost.querySelectorAll<HTMLDetailsElement>('details').forEach(d => { d.open = true; });
    });
    const collapseAll = el('button', { class: 'control-btn', text: 'Collapse all', attrs: { type: 'button' } });
    collapseAll.addEventListener('click', () => {
        session.mounted?.listHost.querySelectorAll<HTMLDetailsElement>('details').forEach(d => { d.open = false; });
    });

    return el('section', { class: 'controls' }, [
        search,
        toggle,
        el('div', { class: 'control-buttons' }, [expandAll, collapseAll]),
    ]);
}

function renderOverviewList(
    session: OverviewSession,
    onOpen: (name: string) => void,
): HTMLElement {
    const filter: OverviewFilter = {
        search: session.searchTerm,
        onlyWithChanges: session.onlyWithChanges,
        actionFilters: session.activeFilters,
    };
    const groups = visibleGroups(session.groups, session.summaries, filter);
    const list = el('div', { class: 'overview-list' });

    if (groups.length === 0) {
        const pending = [...session.summaries.values()].some(s => s.status === 'pending');
        list.appendChild(el('div', {
            class: 'empty',
            text: pending
                ? 'Loading plans…'
                : 'No plans match the current filter.',
        }));
        return list;
    }

    for (const group of groups) {
        const flatten = !group.key
            || (group.items.length === 1 && group.items[0].label === group.items[0].name);
        if (flatten) {
            for (const item of group.items) {
                const summary = session.summaries.get(item.name);
                if (summary) list.appendChild(renderPlanRow(summary, item.name, () => onOpen(item.name)));
            }
            continue;
        }

        let counts = emptyCounts();
        for (const item of group.items) {
            const s = session.summaries.get(item.name);
            if (s) counts = addCounts(counts, s.counts);
        }
        const summaryEl = el('summary', { class: 'module-summary' }, [
            el('span', { class: 'module-label', text: group.key }),
            renderCountPills(counts),
        ]);
        const details = el('details', { class: 'module-node plan-group' });
        details.open = true;
        details.appendChild(summaryEl);
        const body = el('div', { class: 'module-body' });
        for (const item of group.items) {
            const summary = session.summaries.get(item.name);
            if (summary) body.appendChild(renderPlanRow(summary, item.label, () => onOpen(item.name)));
        }
        details.appendChild(body);
        list.appendChild(details);
    }

    return list;
}

function renderPlanRow(summary: PlanSummary, label: string, onOpen: () => void): HTMLElement {
    const kind = summary.status === 'loaded' ? dominantAction(summary.counts) : null;
    const kindClass = kind ? ` plan-row-${kind}` : summary.status === 'error' ? ' plan-row-error' : ' plan-row-pending';
    const row = el('button', {
        class: `plan-row${kindClass}`,
        attrs: {
            type: 'button',
            'data-plan-name': summary.name,
            'aria-label': `Open plan ${summary.name}`,
        },
    }, [
        el('code', { class: 'plan-row-name', text: label }),
    ]);

    if (summary.status === 'pending') {
        row.appendChild(el('span', { class: 'plan-row-status', text: 'Loading…' }));
    } else if (summary.status === 'error') {
        row.appendChild(el('span', {
            class: 'plan-row-status plan-row-status-error',
            text: summary.error || 'Failed to load',
        }));
    } else {
        row.appendChild(renderCountPills(summary.counts));
    }

    row.addEventListener('click', onOpen);
    return row;
}

function renderHiddenBanner(count: number, onShowAll: () => void): HTMLElement {
    const noun = count === 1 ? 'plan' : 'plans';
    const btn = el('button', {
        class: 'hidden-plans-action',
        text: 'Show all',
        attrs: { type: 'button' },
    });
    btn.addEventListener('click', onShowAll);
    return el('div', { class: 'hidden-plans' }, [
        el('span', { text: `${count} ${noun} with no changes ${count === 1 ? 'is' : 'are'} hidden` }),
        btn,
    ]);
}

function showStatusInto(node: HTMLElement, title: string, message: string, kind: 'loading' | 'error' | 'empty') {
    clear(node);
    node.appendChild(el('div', { class: `status status-${kind}` }, [
        el('div', { class: 'status-title', text: title }),
        message ? el('div', { class: 'status-message', text: message }) : null,
    ]));
}

// Mid-load progress UI. Caption + optional skeleton that previews the page
// structure that's about to render. The skeleton's shape mirrors the real
// header / summary / controls / tree layout so the swap to real content is
// near-zero reflow.
function showLoadingStage(node: HTMLElement, title: string, opts: { skeleton?: boolean } = {}) {
    clear(node);
    node.appendChild(el('div', { class: 'loading-stage' }, [
        el('div', { class: 'loading-stage-title', text: title }),
    ]));
    if (opts.skeleton) node.appendChild(renderSkeleton());
}

function renderSkeleton(): HTMLElement {
    const skeleton = el('div', { class: 'skeleton', attrs: { 'aria-hidden': 'true' } });
    const summary = el('div', { class: 'skeleton-summary' });
    for (let i = 0; i < 4; i++) summary.appendChild(el('div', { class: 'skeleton-card' }));
    skeleton.appendChild(summary);
    skeleton.appendChild(el('div', { class: 'skeleton-controls' }));
    const list = el('div', { class: 'skeleton-list' });
    for (let i = 0; i < 6; i++) list.appendChild(el('div', { class: 'skeleton-row' }));
    skeleton.appendChild(list);
    return skeleton;
}

// --------------------------------- Bootstrap --------------------------------

async function bootstrap() {
    const container = document.getElementById('container');
    if (!container) return;
    // Note: tab.html ships a static "Loading Terraform plan…" status that's
    // visible from iframe-load until this script runs — so there's no flash
    // before the first stage label below.

    try {
        showLoadingStage(container, 'Connecting to Azure DevOps…');
        await SDK.init({ loaded: false, applyTheme: true });
        await SDK.ready();

        showLoadingStage(container, 'Listing Terraform plans…');
        const refs = await listPlans();
        await renderPlans(refs, fetchPlanContent, container);

        SDK.notifyLoadSucceeded();
    } catch (err: any) {
        showStatusInto(container, 'Could not load Terraform plan',
            err?.message ?? 'An unknown error occurred.', 'error');
        try { SDK.notifyLoadFailed(err?.message ?? String(err)); } catch { /* SDK might not be initialized */ }
    }
}

// Skip auto-bootstrap when the local dev harness sets the flag — it calls
// renderPlan() directly with a fixture instead.
if (!(window as unknown as { __TF_DEV__?: boolean }).__TF_DEV__) {
    void bootstrap();
}
