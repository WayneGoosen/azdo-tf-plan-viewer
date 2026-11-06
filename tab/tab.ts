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
    toggleInSet,
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
    type ResourceRow,
    type ViewerSettings,
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
    plansHiddenFromSelector,
    rowMatches,
    uniqueTerraformVersions,
} from './overviewLogic';

const ATTACHMENT_TYPE = 'terraform-plan-viewer.plan';

/**
 * Parallel attachment downloads when filling the All-plans overview. Kept
 * modest so a plan the user opens doesn't compete with too many in-flight
 * background downloads (the ADO attachment call can't be cancelled).
 */
const OVERVIEW_FETCH_CONCURRENCY = 4;

// ----------------------------- Type definitions -----------------------------

interface TerraformPlan {
    format_version?: string;
    terraform_version?: string;
    resource_changes?: ResourceChange[];
    output_changes?: Record<string, OutputChange>;
    resource_drift?: ResourceChange[];
    [VIEWER_SETTINGS_KEY]?: ViewerSettings;
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
            attrs: {
                type: 'button',
                'aria-pressed': isActive ? 'true' : 'false',
                'data-focus-key': `card:${kind}`,
            },
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
    toggleInSet(state.activeFilters, kind);
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

/**
 * Address text with line-break opportunities after each dot, so long module
 * paths wrap between segments on narrow screens instead of mid-word.
 * <wbr> adds no text, so copying the address still yields the plain string.
 */
function breakableAddress(address: string): Child[] {
    const out: Child[] = [];
    address.split('.').forEach((part, i, parts) => {
        out.push(i < parts.length - 1 ? `${part}.` : part);
        if (i < parts.length - 1) out.push(document.createElement('wbr'));
    });
    return out;
}

function renderResource(r: ResourceChange): HTMLElement {
    const kind = classifyAction(r.change.actions);
    const summary = el('summary', { class: 'resource-summary' }, [
        el('span', { class: `action-badge action-${kind}`, text: ACTION_LABEL[kind] }),
        el('code', { class: 'resource-address' }, breakableAddress(r.address)),
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
    // Ordering is applied once, in renderPlans.
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
    searchTerm: string;
    activeFilters: Set<ActionKind>;
    showNoop: boolean;
    /** Insertion order is the sorted plan order, and re-setting a key keeps its slot. */
    summaries: Map<string, PlanSummary>;
    /** Disambiguating suffix per plan id for attachments sharing a name. */
    nameSuffixes: Map<string, string>;
    /** Row keys the user has expanded; survives re-renders as plans finish loading. */
    openKeys: Set<string>;
    mounted: {
        metaHost: HTMLElement;
        summaryHost: HTMLElement;
        buttonsHost: HTMLElement;
        listHost: HTMLElement;
        outputsHost: HTMLElement;
        noticeHost: HTMLElement;
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
    for (const ref of refs) {
        const id = planId(ref);
        summaries.set(id, pendingSummary(ref.name, id));
    }

    const overview: OverviewSession = {
        searchTerm: '',
        activeFilters: new Set(),
        showNoop: false,
        summaries,
        nameSuffixes: duplicateNameSuffixes(refs),
        openKeys: new Set(),
        mounted: null,
    };

    let select: HTMLSelectElement | null = null;
    let selectorOptions = new Map<string, HTMLOptionElement>();
    let hideToggle: HTMLInputElement | null = null;
    let hideToggleLabel: HTMLElement | null = null;
    let hiddenCountLabel: HTMLElement | null = null;
    // "Hide plans without changes": follows the task's hideNoChangePlans input
    // until the viewer flips the checkbox, then the viewer's choice sticks.
    let hideTouched = false;
    let hideChoice = false;
    const hideNoChangePlans = () => hideTouched ? hideChoice : defaultHideNoChangePlans(summaries.values());

    /** Show/hide dropdown options as plans load or the checkbox changes. */
    const syncSelector = () => {
        if (!select) return;
        const hide = hideNoChangePlans();
        const keep = current.kind === 'plan' ? planId(current.ref) : undefined;
        const hidden = plansHiddenFromSelector(summaries.values(), hide, keep);
        // A <select> sizes itself to its longest option, so hiding plans would
        // make it shrink and grow. Lock the width it has with every plan listed.
        if (!select.style.width && select.isConnected && select.options.length === refs.length + 1) {
            const width = select.getBoundingClientRect().width;
            if (width > 0) select.style.width = `${Math.ceil(width)}px`;
        }
        const value = select.value;
        // Re-append visible options in plan order; detach hidden ones.
        for (const ref of refs) {
            const opt = selectorOptions.get(planId(ref))!;
            if (hidden.has(planId(ref))) opt.remove();
            else select.appendChild(opt);
        }
        select.value = value;
        if (hideToggle) hideToggle.checked = hide;
        // Only offer the checkbox once there's a plan it could hide. It appears
        // as plans load and then stays, so it never flickers in and out.
        if (hideToggleLabel?.hidden && anyPlanWithoutChanges(summaries.values())) {
            hideToggleLabel.hidden = false;
        }
        if (hiddenCountLabel) {
            hiddenCountLabel.textContent = hidden.size ? `(${hidden.size} hidden)` : '';
        }
    };
    let current: View = refs.length > 1
        ? { kind: 'all' }
        : { kind: 'plan', ref: refs[0] };
    let overviewFetchStarted = false;
    /** Settles when the plan the user opened finishes loading; null when idle. */
    let userFetch: Promise<void> | null = null;

    const fetchOne = (ref: PlanRef): Promise<TerraformPlan> => {
        const id = planId(ref);
        const cached = cache.get(id);
        if (cached) return Promise.resolve(cached);
        const existing = inflight.get(id);
        if (existing) return existing;
        const p = fetcher(ref).then(plan => {
            cache.set(id, plan);
            summaries.set(id, loadedSummary(ref.name, plan, id));
            inflight.delete(id);
            syncSelector();
            return plan;
        }, err => {
            inflight.delete(id);
            throw err;
        });
        inflight.set(id, p);
        return p;
    };

    const filterOf = (): OverviewFilter => ({
        search: overview.searchTerm,
        actionFilters: overview.activeFilters,
        showNoop: overview.showNoop,
    });

    const planLabel = (ref: PlanRef) => ref.name + (overview.nameSuffixes.get(planId(ref)) ?? '');
    const loadedRefs = () => refs.filter(r => cache.has(planId(r)));

    /** Every resource change from the plans loaded so far, in plan order. */
    const currentRows = (): ResourceRow[] => buildResourceRows(
        loadedRefs().map(r => ({
            id: planId(r),
            label: planLabel(r),
            resources: cache.get(planId(r))!.resource_changes ?? [],
        })),
    );

    const openPlan = (id: string) => {
        const ref = refs.find(r => planId(r) === id);
        if (ref) void switchTo({ kind: 'plan', ref });
    };

    // Background fetches finish at arbitrary times. Rebuilding the list while
    // the user is mid-click (between pointerdown and pointerup) would swap the
    // element under the pointer and drop the click, so defer until release.
    let pointerHeld = false;
    let patchQueued = false;
    body.addEventListener('pointerdown', () => { pointerHeld = true; });
    const releasePointer = () => {
        if (!pointerHeld) return;
        pointerHeld = false;
        if (patchQueued) {
            patchQueued = false;
            // Let the click event (fired after pointerup) land first.
            window.setTimeout(() => patchOverview(), 0);
        }
    };
    document.addEventListener('pointerup', releasePointer, true);
    document.addEventListener('pointercancel', releasePointer, true);

    const patchOverview = () => {
        if (current.kind !== 'all' || !overview.mounted) return;
        if (pointerHeld) {
            patchQueued = true;
            return;
        }
        const { metaHost, summaryHost, buttonsHost, listHost, outputsHost, noticeHost } = overview.mounted;
        const active = document.activeElement as HTMLElement | null;
        const focusKey = active && body.contains(active) ? active.dataset.focusKey : undefined;
        // Plans finish loading in any order, so rows can appear above what the
        // user is looking at. Remember the first visible row and keep it put.
        const anchor = visibleRowAnchor(listHost);

        const rows = currentRows();
        const all = [...summaries.values()];
        clear(metaHost);
        fillOverviewMeta(metaHost, refs.length, all, rows);
        clear(summaryHost);
        summaryHost.appendChild(renderOverviewSummary(overview, patchOverview));
        clear(buttonsHost);
        buttonsHost.appendChild(renderOverviewButtons(overview, rows, patchOverview));
        clear(listHost);
        listHost.appendChild(renderOverviewList(overview, rows, filterOf(), openPlan));
        clear(outputsHost);
        const outputs = renderCombinedOutputs(
            loadedRefs().map(r => ({
                id: planId(r),
                label: planLabel(r),
                outputs: cache.get(planId(r))!.output_changes ?? {},
            })),
            openPlan,
        );
        if (outputs) outputsHost.appendChild(outputs);
        clear(noticeHost);
        const failed = all.filter(x => x.status === 'error');
        if (failed.length) noticeHost.appendChild(renderFailedPlans(failed, overview.nameSuffixes));

        if (anchor) restoreRowAnchor(listHost, anchor);
        if (focusKey) {
            const target = [...body.querySelectorAll<HTMLElement>('[data-focus-key]')]
                .find(n => n.dataset.focusKey === focusKey);
            if (target && target !== document.activeElement) target.focus({ preventScroll: true });
        }
    };

    const showOverview = () => {
        overview.mounted = null;
        clear(body);
        const metaHost = el('div', { class: 'header-meta' });
        const summaryHost = el('div');
        const buttonsHost = el('div', { class: 'control-buttons' });
        const listHost = el('div', { class: 'tree' });
        const outputsHost = el('div');
        const noticeHost = el('div');
        overview.mounted = { metaHost, summaryHost, buttonsHost, listHost, outputsHost, noticeHost };

        body.appendChild(el('header', { class: 'header' }, [
            el('h1', { text: 'All plans' }),
            metaHost,
        ]));
        body.appendChild(summaryHost);
        body.appendChild(renderOverviewControls(overview, buttonsHost, patchOverview));
        body.appendChild(noticeHost);
        body.appendChild(listHost);
        body.appendChild(outputsHost);
        patchOverview();
        void loadAllForOverview();
    };

    const loadAllForOverview = async () => {
        if (overviewFetchStarted) return;
        overviewFetchStarted = true;
        const pending = refs.filter(r => !cache.has(planId(r)));
        let cursor = 0;
        const worker = async () => {
            while (cursor < pending.length) {
                // Yield to a plan the user explicitly opened: don't start new
                // background downloads until it has finished loading.
                while (userFetch) await userFetch;
                if (cursor >= pending.length) break;
                const ref = pending[cursor++];
                try {
                    await fetchOne(ref);
                } catch (err: any) {
                    const id = planId(ref);
                    summaries.set(id, errorSummary(ref.name, err?.message ?? String(err), id));
                }
                patchOverview();
            }
        };
        const n = Math.min(OVERVIEW_FETCH_CONCURRENCY, pending.length);
        if (n > 0) await Promise.all(Array.from({ length: n }, () => worker()));
    };

    const switchTo = async (view: View) => {
        current = view;
        syncSelector(); // the plan being opened must be listed, even if hidden
        if (select) select.value = view.kind === 'all' ? ALL_PLANS_VALUE : planId(view.ref);

        if (view.kind === 'all') {
            showOverview();
            return;
        }

        overview.mounted = null;
        const ref = view.ref;
        const id = planId(ref);
        if (cache.has(id)) {
            renderPlan(cache.get(id)!, body);
            return;
        }

        if (select) select.disabled = true;
        showLoadingStage(body, `Loading plan: ${ref.name}…`, { skeleton: true });
        const request = fetchOne(ref);
        const gate: Promise<void> = request.then(() => undefined, () => undefined)
            .finally(() => { if (userFetch === gate) userFetch = null; });
        userFetch = gate;
        try {
            const plan = await request;
            if (current.kind === 'plan' && current.ref === ref) renderPlan(plan, body);
        } catch (err: any) {
            summaries.set(id, errorSummary(ref.name, err?.message ?? String(err), id));
            if (current.kind === 'plan' && current.ref === ref) {
                showStatusInto(body, 'Could not load Terraform plan',
                    err?.message ?? String(err), 'error');
            }
        } finally {
            if (select) select.disabled = false;
        }
    };

    if (refs.length > 1) {
        const selector = renderSelector(refs, defaultSelectorValue(refs), value => {
            if (value === ALL_PLANS_VALUE) {
                void switchTo({ kind: 'all' });
                return;
            }
            const next = refs.find(r => planId(r) === value);
            if (next) void switchTo({ kind: 'plan', ref: next });
        });
        select = selector.select;
        selectorOptions = selector.options;
        selectorBar.appendChild(el('label', { class: 'plan-selector', attrs: { for: 'plan-select' } }, [
            el('span', { class: 'plan-selector-label', text: 'Plan' }),
            select,
        ]));

        hideToggle = el('input', {
            attrs: { type: 'checkbox', id: 'hide-no-change-plans', 'data-focus-key': 'hide-no-change' },
        });
        hiddenCountLabel = el('span', { class: 'selector-toggle-count', attrs: { 'aria-live': 'polite' } });
        hideToggle.addEventListener('change', () => {
            hideTouched = true;
            hideChoice = hideToggle!.checked;
            syncSelector();
        });
        hideToggleLabel = el('label', { class: 'selector-toggle', attrs: { for: 'hide-no-change-plans' } }, [
            hideToggle,
            el('span', { text: 'Hide plans without changes' }),
            hiddenCountLabel,
        ]);
        hideToggleLabel.hidden = true;
        selectorBar.appendChild(hideToggleLabel);
        syncSelector();
    }

    await switchTo(current);
}

function renderSelector(
    refs: PlanRef[],
    currentValue: string,
    onChange: (value: string) => void,
): { select: HTMLSelectElement; options: Map<string, HTMLOptionElement> } {
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

    const suffixes = duplicateNameSuffixes(refs);
    const options = new Map<string, HTMLOptionElement>();
    for (const ref of refs) {
        const id = planId(ref);
        const text = ref.name + (suffixes.get(id) ?? '');
        const opt = el('option', { text, attrs: { value: id } });
        if (id === currentValue) opt.selected = true;
        select.appendChild(opt);
        options.set(id, opt);
    }

    select.addEventListener('change', () => onChange(select.value));
    return { select, options };
}

function fillOverviewMeta(host: HTMLElement, total: number, summaries: PlanSummary[], rows: ResourceRow[]) {
    const loaded = summaries.filter(s => s.status === 'loaded');
    const withChanges = loaded.filter(s => s.hasChanges).length;
    const noChanges = loaded.filter(s => s.hasChanges === false).length;
    const pending = summaries.filter(s => s.status === 'pending').length;
    const failed = summaries.filter(s => s.status === 'error').length;
    const changes = rows.filter(r => r.kind !== 'noop' && r.kind !== 'read').length;

    const pill = (text: string, extra = '') =>
        host.appendChild(el('span', { class: `meta-pill${extra}`, text }));

    pill(`${total} ${total === 1 ? 'plan' : 'plans'}`);
    pill(`${withChanges} with changes`);
    pill(`${noChanges} no changes`);
    pill(`${changes} resource ${changes === 1 ? 'change' : 'changes'}`);
    const versions = uniqueTerraformVersions(summaries);
    if (versions.length === 1) pill(`Terraform ${versions[0]}`);
    else if (versions.length > 1) pill('Mixed Terraform versions');
    if (pending > 0) pill(`Loading ${loaded.length + failed}/${total}…`);
    if (failed > 0) pill(`${failed} failed to load`, ' meta-pill-error');
}

function renderOverviewSummary(session: OverviewSession, onChange: () => void): HTMLElement {
    let counts = emptyCounts();
    for (const s of session.summaries.values()) counts = addCounts(counts, s.counts);
    return renderActionCards(counts, session.activeFilters, kind => {
        toggleInSet(session.activeFilters, kind);
        onChange();
    });
}

/** Search box (persistent, so typing is never interrupted) plus a host for the buttons. */
function renderOverviewControls(session: OverviewSession, buttonsHost: HTMLElement, onChange: () => void): HTMLElement {
    const search = el('input', {
        class: 'search',
        attrs: {
            type: 'search',
            placeholder: 'Filter by address, type or plan…',
            'aria-label': 'Filter resources',
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

    return el('section', { class: 'controls' }, [search, buttonsHost]);
}

/** Expand / collapse and the unchanged-resources toggle. Re-rendered as plans load. */
function renderOverviewButtons(session: OverviewSession, rows: ResourceRow[], onChange: () => void): DocumentFragment {
    const frag = document.createDocumentFragment();
    const setAllOpen = (open: boolean) => {
        const filter: OverviewFilter = {
            search: session.searchTerm,
            actionFilters: session.activeFilters,
            showNoop: session.showNoop,
        };
        for (const r of rows) {
            if (!rowMatches(r, filter)) continue;
            if (open) session.openKeys.add(r.key);
            else session.openKeys.delete(r.key);
        }
        onChange();
    };

    const expandAll = el('button', {
        class: 'control-btn', text: 'Expand all',
        attrs: { type: 'button', 'data-focus-key': 'btn:expand' },
    });
    expandAll.addEventListener('click', () => setAllOpen(true));
    const collapseAll = el('button', {
        class: 'control-btn', text: 'Collapse all',
        attrs: { type: 'button', 'data-focus-key': 'btn:collapse' },
    });
    collapseAll.addEventListener('click', () => setAllOpen(false));
    frag.appendChild(expandAll);
    frag.appendChild(collapseAll);

    const noopCount = noopRowCount(rows);
    if (noopCount > 0) {
        const noun = noopCount === 1 ? 'unchanged resource' : 'unchanged resources';
        const noopToggle = el('button', {
            class: 'control-btn' + (session.showNoop ? ' is-active' : ''),
            text: `${session.showNoop ? 'Hide' : 'Show'} ${noopCount} ${noun}`,
            attrs: {
                type: 'button',
                'aria-pressed': session.showNoop ? 'true' : 'false',
                'data-focus-key': 'btn:noop',
            },
        });
        noopToggle.addEventListener('click', () => {
            session.showNoop = !session.showNoop;
            onChange();
        });
        frag.appendChild(noopToggle);
    }
    return frag;
}

function renderPlanTag(label: string, focusKey: string, onOpen: () => void): HTMLElement {
    const tag = el('button', {
        class: 'plan-tag',
        text: label,
        attrs: {
            type: 'button',
            title: `Open plan ${label}`,
            'aria-label': `Open plan ${label}`,
            'data-focus-key': focusKey,
        },
    });
    tag.addEventListener('click', e => {
        // The tag sits inside a <summary>; don't also toggle the row.
        e.preventDefault();
        e.stopPropagation();
        onOpen();
    });
    return tag;
}

function renderOverviewList(
    session: OverviewSession,
    rows: ResourceRow[],
    filter: OverviewFilter,
    onOpenPlan: (id: string) => void,
): HTMLElement {
    const visible = rows.filter(r => rowMatches(r, filter));
    const list = el('div', { class: 'module-root overview-list' });

    if (visible.length === 0) {
        const pending = [...session.summaries.values()].some(s => s.status === 'pending');
        const anyChanges = rows.some(r => r.kind !== 'noop');
        let text: string;
        if (pending && rows.length === 0) text = 'Loading plans…';
        else if (!anyChanges && !filter.search && filter.actionFilters.size === 0) {
            text = pending
                ? 'No resource changes in the plans loaded so far…'
                : 'No resource changes in any plan. Infrastructure matches the configuration.';
        } else text = 'No resources match the current filter.';
        list.appendChild(el('div', { class: 'empty', text }));
        return list;
    }

    for (const row of visible) {
        const details = renderResource(row.resource) as HTMLDetailsElement;
        details.dataset.rowKey = row.key;
        const summary = details.querySelector('summary')!;
        summary.dataset.focusKey = `res:${row.key}`;
        summary.appendChild(renderPlanTag(row.planLabel, `tag:${row.key}`, () => onOpenPlan(row.planId)));
        details.open = session.openKeys.has(row.key);
        details.addEventListener('toggle', () => {
            if (details.open) session.openKeys.add(row.key);
            else session.openKeys.delete(row.key);
        });
        list.appendChild(details);
    }
    return list;
}

/** Output changes across all loaded plans, tagged like resources. Null when none change. */
function renderCombinedOutputs(
    plans: Array<{ id: string; label: string; outputs: Record<string, OutputChange> }>,
    onOpenPlan: (id: string) => void,
): HTMLElement | null {
    const list = el('div', { class: 'outputs-list' });
    let n = 0;
    for (const p of plans) {
        for (const name of Object.keys(p.outputs).sort((a, b) => a.localeCompare(b))) {
            const o = p.outputs[name];
            const kind = classifyAction(o.actions);
            if (kind === 'noop') continue;
            const valueText = o.after_sensitive ? '(sensitive)'
                : o.after_unknown ? '(known after apply)'
                : formatValue(o.after);
            list.appendChild(el('div', { class: 'output-row' }, [
                el('span', { class: `action-badge action-${kind}`, text: ACTION_LABEL[kind] }),
                el('code', { class: 'output-name', text: name }),
                el('span', { class: 'output-value', text: valueText }),
                renderPlanTag(p.label, `out:${p.id}\n${name}`, () => onOpenPlan(p.id)),
            ]));
            n++;
        }
    }
    if (n === 0) return null;
    return el('section', { class: 'outputs' }, [el('h2', { text: 'Outputs' }), list]);
}

function renderFailedPlans(failed: PlanSummary[], suffixes: Map<string, string>): HTMLElement {
    return el('div', { class: 'overview-notice' }, [
        el('strong', { text: `${failed.length} ${failed.length === 1 ? 'plan' : 'plans'} could not be loaded` }),
        el('ul', {}, failed.map(f => el('li', {}, [
            el('code', { text: f.name + (suffixes.get(f.id) ?? '') }),
            el('span', { text: `: ${f.error || 'Failed to load'}` }),
        ]))),
    ]);
}

interface RowAnchor { key: string; top: number }

function visibleRowAnchor(listHost: HTMLElement): RowAnchor | null {
    for (const row of listHost.querySelectorAll<HTMLElement>('[data-row-key]')) {
        const top = row.getBoundingClientRect().top;
        if (top >= 0) return { key: row.dataset.rowKey!, top };
    }
    return null;
}

function restoreRowAnchor(listHost: HTMLElement, anchor: RowAnchor) {
    const row = [...listHost.querySelectorAll<HTMLElement>('[data-row-key]')]
        .find(r => r.dataset.rowKey === anchor.key);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - anchor.top;
    if (delta !== 0) window.scrollBy(0, delta);
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
