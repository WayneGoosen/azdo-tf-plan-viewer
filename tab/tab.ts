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

const ATTACHMENT_TYPE = 'terraform-plan-viewer.plan';

// ----------------------------- Type definitions -----------------------------

interface TerraformPlan {
    format_version?: string;
    terraform_version?: string;
    resource_changes?: ResourceChange[];
    output_changes?: Record<string, OutputChange>;
    resource_drift?: ResourceChange[];
}

interface ResourceChange {
    address: string;
    module_address?: string;
    mode?: string;
    type: string;
    name: string;
    provider_name?: string;
    change: Change;
}

interface Change {
    actions: string[];
    before: unknown;
    after: unknown;
    after_unknown?: unknown;
    before_sensitive?: unknown;
    after_sensitive?: unknown;
    replace_paths?: unknown[][];
}

interface OutputChange {
    actions: string[];
    before: unknown;
    after: unknown;
    after_unknown?: boolean;
    before_sensitive?: boolean;
    after_sensitive?: boolean;
}

type ActionKind = 'create' | 'update' | 'delete' | 'recreate' | 'read' | 'noop';

interface ModuleNode {
    label: string;
    resources: ResourceChange[];
    children: Map<string, ModuleNode>;
    counts: Record<ActionKind, number>;
}

interface AttrDiff {
    key: string;
    kind: '+' | '-' | '~';
    before?: string;
    after?: string;
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

function classifyAction(actions: string[]): ActionKind {
    const has = (a: string) => actions.includes(a);
    if (has('create') && has('delete')) return 'recreate';
    if (has('create')) return 'create';
    if (has('delete')) return 'delete';
    if (has('update')) return 'update';
    if (has('read')) return 'read';
    return 'noop';
}

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

function emptyCounts(): Record<ActionKind, number> {
    return { create: 0, update: 0, delete: 0, recreate: 0, read: 0, noop: 0 };
}

// ------------------------------- Module tree --------------------------------

function splitModuleAddress(addr: string | undefined): string[] {
    if (!addr) return [];
    return addr.split(/\.(?=module\.)/);
}

function buildTree(resources: ResourceChange[]): ModuleNode {
    const root: ModuleNode = {
        label: '',
        resources: [],
        children: new Map(),
        counts: emptyCounts(),
    };
    for (const r of resources) {
        let node = root;
        for (const part of splitModuleAddress(r.module_address)) {
            let child = node.children.get(part);
            if (!child) {
                child = { label: part, resources: [], children: new Map(), counts: emptyCounts() };
                node.children.set(part, child);
            }
            node = child;
        }
        node.resources.push(r);
    }
    rollUpCounts(root);
    return root;
}

function rollUpCounts(node: ModuleNode): Record<ActionKind, number> {
    const counts = emptyCounts();
    for (const r of node.resources) counts[classifyAction(r.change.actions)]++;
    for (const child of node.children.values()) {
        const c = rollUpCounts(child);
        (Object.keys(counts) as ActionKind[]).forEach(k => { counts[k] += c[k]; });
    }
    node.counts = counts;
    return counts;
}

// ---------------------------------- Diff ------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function computeDiff(change: Change): AttrDiff[] {
    const before = isPlainObject(change.before) ? change.before : {};
    const after = isPlainObject(change.after) ? change.after : {};
    const afterUnknown = isPlainObject(change.after_unknown) ? change.after_unknown : {};
    const beforeSensitive = isPlainObject(change.before_sensitive) ? change.before_sensitive : {};
    const afterSensitive = isPlainObject(change.after_sensitive) ? change.after_sensitive : {};

    const keys = new Set<string>([
        ...Object.keys(before),
        ...Object.keys(after),
        ...Object.keys(afterUnknown),
    ]);

    const diffs: AttrDiff[] = [];
    for (const key of [...keys].sort()) {
        const bExists = key in before;
        const aExists = (key in after) || afterUnknown[key] === true;
        const bSens = beforeSensitive[key] === true;
        const aSens = afterSensitive[key] === true;
        const aUnknown = afterUnknown[key] === true;

        let kind: '+' | '-' | '~';
        if (!bExists && aExists) kind = '+';
        else if (bExists && !aExists) kind = '-';
        else if (!deepEqual(before[key], after[key])) kind = '~';
        else continue;

        const beforeStr = kind === '+' ? undefined
            : (bSens ? '(sensitive)' : formatValue(before[key]));
        const afterStr = kind === '-' ? undefined
            : (aUnknown ? '(known after apply)' : (aSens ? '(sensitive)' : formatValue(after[key])));

        diffs.push({ key, kind, before: beforeStr, after: afterStr });
    }
    return diffs;
}

function formatValue(v: unknown): string {
    if (v === null) return 'null';
    if (v === undefined) return '';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v, null, 2);
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    if (ak.length !== Object.keys(bo).length) return false;
    for (const k of ak) if (!deepEqual(ao[k], bo[k])) return false;
    return true;
}

function formatReplacePath(path: unknown[]): string {
    return path.map(p => typeof p === 'number' ? `[${p}]` : String(p)).join('.');
}

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
    treeContainer: HTMLElement;
}

function matchesFilter(state: RenderState, r: ResourceChange): boolean {
    const kind = classifyAction(r.change.actions);
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

function renderSummary(state: RenderState): HTMLElement {
    const counts = state.tree.counts;
    const card = (kind: ActionKind, label: string) => {
        const isActive = state.activeFilters.has(kind);
        const c = el('button', {
            class: `summary-card summary-${kind}` + (isActive ? ' is-active' : ''),
            attrs: { type: 'button', 'aria-pressed': isActive ? 'true' : 'false' },
        }, [
            el('span', { class: 'summary-count', text: String(counts[kind]) }),
            el('span', { class: 'summary-label', text: label }),
        ]);
        c.addEventListener('click', () => toggleFilter(state, kind));
        return c;
    };

    return el('section', { class: 'summary' }, [
        card('create', 'Create'),
        card('update', 'Update'),
        card('recreate', 'Recreate'),
        card('delete', 'Delete'),
    ]);
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

    return el('section', { class: 'controls' }, [
        search,
        el('div', { class: 'control-buttons' }, [expandAll, collapseAll]),
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

    const diffs = computeDiff(r.change);
    if (diffs.length) {
        body.appendChild(renderDiff(diffs));
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

function renderDiff(diffs: AttrDiff[]): HTMLElement {
    const table = el('div', { class: 'diff' });
    for (const d of diffs) {
        const rowClass = d.kind === '+' ? 'diff-add' : d.kind === '-' ? 'diff-del' : 'diff-mod';
        const row = el('div', { class: `diff-row ${rowClass}` });
        row.appendChild(el('span', { class: 'diff-glyph', text: d.kind }));
        row.appendChild(el('span', { class: 'diff-key', text: d.key }));

        // Wrap the value side in a single cell so all rows align in the same
        // column, regardless of whether they show "before → after" or just one.
        const value = el('span', { class: 'diff-value' });
        if (d.kind === '~') {
            value.appendChild(el('span', { class: 'diff-before', text: d.before ?? '' }));
            value.appendChild(el('span', { class: 'diff-arrow', text: ' → ' }));
            value.appendChild(el('span', { class: 'diff-after', text: d.after ?? '' }));
        } else if (d.kind === '+') {
            value.appendChild(el('span', { class: 'diff-after', text: d.after ?? '' }));
        } else {
            value.appendChild(el('span', { class: 'diff-before', text: d.before ?? '' }));
        }
        row.appendChild(value);
        table.appendChild(row);
    }
    return table;
}

function renderOutputs(outputs: Record<string, OutputChange>): HTMLElement {
    const section = el('section', { class: 'outputs' }, [
        el('h2', { text: 'Outputs' }),
    ]);
    const list = el('div', { class: 'outputs-list' });
    for (const name of Object.keys(outputs).sort()) {
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

export async function renderPlans(refs: PlanRef[], fetcher: PlanFetcher, root: HTMLElement) {
    if (refs.length === 0) {
        showStatusInto(root, 'No Terraform plan was attached to this build.', '', 'error');
        return;
    }

    clear(root);

    // Persistent header (selector) + swappable body. Switching a plan only
    // re-renders the body, so the dropdown never flashes or loses focus.
    const selectorBar = el('div', { class: 'plan-selector-bar' });
    const body = el('div', { class: 'plan-body' });
    root.appendChild(selectorBar);
    root.appendChild(body);

    const cache = new Map<string, TerraformPlan>();
    let select: HTMLSelectElement | null = null;
    let current: PlanRef = refs[0];

    const switchTo = async (ref: PlanRef) => {
        current = ref;
        if (cache.has(ref.name)) {
            renderPlan(cache.get(ref.name)!, body);
            return;
        }

        if (select) select.disabled = true;
        showLoadingStage(body, `Loading plan: ${ref.name}…`, { skeleton: true });
        try {
            const plan = await fetcher(ref);
            cache.set(ref.name, plan);
            // Guard against races: only render if the user is still on this ref.
            if (current === ref) renderPlan(plan, body);
        } catch (err: any) {
            if (current === ref) {
                showStatusInto(body, 'Could not load Terraform plan',
                    err?.message ?? String(err), 'error');
            }
        } finally {
            if (select) select.disabled = false;
        }
    };

    if (refs.length > 1) {
        select = renderSelector(refs, current.name, (next) => { void switchTo(next); });
        selectorBar.appendChild(el('label', { class: 'plan-selector', attrs: { for: 'plan-select' } }, [
            el('span', { class: 'plan-selector-label', text: 'Plan' }),
            select,
        ]));
    }

    await switchTo(current);
}

function renderSelector(refs: PlanRef[], currentName: string, onSelect: (ref: PlanRef) => void): HTMLSelectElement {
    const select = el('select', {
        class: 'plan-selector-input',
        attrs: { id: 'plan-select', 'aria-label': 'Select Terraform plan' },
    });

    for (const ref of refs) {
        const opt = el('option', { text: ref.name, attrs: { value: ref.name } });
        if (ref.name === currentName) opt.selected = true;
        select.appendChild(opt);
    }

    select.addEventListener('change', () => {
        const next = refs.find(r => r.name === select.value);
        if (next) onSelect(next);
    });

    return select;
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
