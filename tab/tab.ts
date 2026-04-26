// =============================================================================
// Terraform Plan Viewer — tab renderer
//
// Fetches the plan JSON attached by the TerraformPlanViewer task and renders
// a structured, searchable view: summary cards, module tree, attribute diffs,
// and replace reasons. All rendering uses DOM APIs (textContent / createElement)
// so plan content is never interpolated as HTML.
// =============================================================================

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

// ------------------------------ Classification ------------------------------

function classifyAction(actions: string[]): ActionKind {
    const has = (a: string) => actions.includes(a);
    // Check recreate first so it doesn't get caught by plain create/delete.
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
    // module_address is like "module.foo.module.bar[0].module.baz".
    // Split before each ".module." boundary; resource names contain no dots,
    // so this is safe.
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

function renderPlan(plan: TerraformPlan, root: HTMLElement) {
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

    // Auto-expand modules during search so matches are visible.
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
        if (d.kind === '~') {
            row.appendChild(el('span', { class: 'diff-before', text: d.before ?? '' }));
            row.appendChild(el('span', { class: 'diff-arrow', text: '→' }));
            row.appendChild(el('span', { class: 'diff-after', text: d.after ?? '' }));
        } else if (d.kind === '+') {
            row.appendChild(el('span', { class: 'diff-after', text: d.after ?? '' }));
        } else {
            row.appendChild(el('span', { class: 'diff-before', text: d.before ?? '' }));
        }
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

async function fetchPlan(buildId: number): Promise<{ plan: TerraformPlan; attachmentName: string }> {
    const ctx = VSS.getWebContext();
    const collection = ctx.collection.uri.replace(/\/$/, '');
    const projectId = ctx.project.id;

    const session = await VSS.getAccessToken();
    const headers = { Authorization: `Bearer ${session.token}` };

    const listUrl =
        `${collection}/${projectId}/_apis/build/builds/${buildId}` +
        `/attachments/${encodeURIComponent(ATTACHMENT_TYPE)}?api-version=7.0`;

    const listResp = await fetch(listUrl, { headers });
    if (!listResp.ok) {
        throw new Error(`Listing attachments failed: ${listResp.status} ${listResp.statusText}`);
    }
    const listJson = await listResp.json();
    const attachments: Array<{ name: string; _links?: { self?: { href?: string } } }> = listJson?.value ?? [];

    if (!attachments.length) {
        throw new Error('No Terraform plan was attached to this build. ' +
            'Make sure the TerraformPlanViewer task ran successfully in the pipeline.');
    }

    const att = attachments[0];
    const fileUrl = att?._links?.self?.href;
    if (!fileUrl) throw new Error('Attachment metadata is missing a download link.');

    const fileResp = await fetch(fileUrl, { headers });
    if (!fileResp.ok) {
        throw new Error(`Downloading plan failed: ${fileResp.status} ${fileResp.statusText}`);
    }

    const text = await fileResp.text();
    let parsed: TerraformPlan;
    try {
        parsed = JSON.parse(text);
    } catch (e: any) {
        throw new Error(`Plan attachment is not valid JSON: ${e?.message ?? e}`);
    }
    return { plan: parsed, attachmentName: att.name };
}

// --------------------------------- Status -----------------------------------

function showStatus(title: string, message: string, kind: 'loading' | 'error' | 'empty' = 'loading') {
    const container = document.getElementById('container');
    if (!container) return;
    clear(container);
    container.appendChild(el('div', { class: `status status-${kind}` }, [
        el('div', { class: 'status-title', text: title }),
        el('div', { class: 'status-message', text: message }),
    ]));
}

// --------------------------------- Bootstrap --------------------------------

async function loadAndRender(buildId: number) {
    const container = document.getElementById('container');
    if (!container) return;

    showStatus('Loading Terraform plan…', `Build ${buildId}`, 'loading');

    try {
        const { plan } = await fetchPlan(buildId);
        clear(container);
        renderPlan(plan, container);
    } catch (err: any) {
        showStatus('Could not load Terraform plan',
            err?.message ?? 'An unknown error occurred.', 'error');
    }
}

VSS.init({ explicitNotifyLoaded: true, usePlatformStyles: true, applyTheme: true });

VSS.ready(() => {
    const config = VSS.getConfiguration();

    // The build-results-tab contribution provides build context via
    // onBuildChanged. webContext.build does not exist here.
    if (config && typeof config.onBuildChanged === 'function') {
        config.onBuildChanged(build => {
            if (build && typeof build.id === 'number') {
                void loadAndRender(build.id);
            }
        });
    } else if (config?.buildId) {
        void loadAndRender(config.buildId);
    } else {
        showStatus('No build context',
            'This tab is meant to render inside a build run.', 'error');
    }

    VSS.notifyLoadSucceeded();
});
