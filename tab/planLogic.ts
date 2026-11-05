// =============================================================================
// Terraform Plan Logic — Pure functions for classification, diff, and tree
//
// Extracted pure business logic that operates on plan data structures without
// DOM dependencies. Shared by both the renderer (tab.ts) and tests.
// =============================================================================

export interface Change {
    actions: string[];
    before: unknown;
    after: unknown;
    after_unknown?: unknown;
    before_sensitive?: unknown;
    after_sensitive?: unknown;
    replace_paths?: unknown[][];
}

export interface ResourceChange {
    address: string;
    module_address?: string;
    mode?: string;
    type: string;
    name: string;
    provider_name?: string;
    change: Change;
}

export type ActionKind = 'create' | 'update' | 'delete' | 'recreate' | 'read' | 'noop';

export interface AttrDiff {
    key: string;
    kind: '+' | '-' | '~' | '=';
    before?: string;
    after?: string;
}

export interface ResourceDiff {
    changed: AttrDiff[];
    unchanged: AttrDiff[];
}

export interface ModuleNode {
    label: string;
    resources: ResourceChange[];
    children: Map<string, ModuleNode>;
    counts: Record<ActionKind, number>;
}

// ------------------------------ Classification ------------------------------

export function classifyAction(actions: string[]): ActionKind {
    const has = (a: string) => actions.includes(a);
    if (has('create') && has('delete')) return 'recreate';
    if (has('create')) return 'create';
    if (has('delete')) return 'delete';
    if (has('update')) return 'update';
    if (has('read')) return 'read';
    return 'noop';
}

export function emptyCounts(): Record<ActionKind, number> {
    return { create: 0, update: 0, delete: 0, recreate: 0, read: 0, noop: 0 };
}

// ------------------------------- Module tree --------------------------------

export function splitModuleAddress(addr: string | undefined): string[] {
    if (!addr) return [];
    return addr.split(/\.(?=module\.)/);
}

export function buildTree(resources: ResourceChange[]): ModuleNode {
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

export function formatValue(v: unknown): string {
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

function walkDiff(
    path: string,
    bRaw: unknown,
    aRaw: unknown,
    bSensRaw: unknown,
    aSensRaw: unknown,
    aUnkRaw: unknown,
    bHas: boolean,
    aHas: boolean,
    out: AttrDiff[],
): void {
    const bSens = bSensRaw === true;
    const aSens = aSensRaw === true;
    const aUnk = aUnkRaw === true;

    const canRecurse = !bSens && !aSens && !aUnk;

    const bIsObj = isPlainObject(bRaw);
    const aIsObj = isPlainObject(aRaw);
    const bIsArr = Array.isArray(bRaw);
    const aIsArr = Array.isArray(aRaw);

    if (canRecurse && (bIsObj || aIsObj) && !bIsArr && !aIsArr) {
        const bObj = (bIsObj ? bRaw : {}) as Record<string, unknown>;
        const aObj = (aIsObj ? aRaw : {}) as Record<string, unknown>;
        const bSensObj = isPlainObject(bSensRaw) ? bSensRaw : {};
        const aSensObj = isPlainObject(aSensRaw) ? aSensRaw : {};
        const aUnkObj = isPlainObject(aUnkRaw) ? aUnkRaw : {};
        const subKeys = new Set<string>([
            ...Object.keys(bObj),
            ...Object.keys(aObj),
            ...Object.keys(aUnkObj),
            ...Object.keys(bSensObj),
            ...Object.keys(aSensObj),
        ]);
        for (const k of subKeys) {
            const childPath = path ? `${path}.${k}` : k;
            walkDiff(
                childPath,
                bObj[k], aObj[k],
                bSensObj[k], aSensObj[k], aUnkObj[k],
                k in bObj, k in aObj,
                out,
            );
        }
        return;
    }

    if (canRecurse && (bIsArr || aIsArr) && !bIsObj && !aIsObj) {
        const bArr = (bIsArr ? bRaw : []) as unknown[];
        const aArr = (aIsArr ? aRaw : []) as unknown[];
        const bSensArr = Array.isArray(bSensRaw) ? bSensRaw : [];
        const aSensArr = Array.isArray(aSensRaw) ? aSensRaw : [];
        const aUnkArr = Array.isArray(aUnkRaw) ? aUnkRaw : [];
        const len = Math.max(bArr.length, aArr.length);
        for (let i = 0; i < len; i++) {
            walkDiff(
                `${path}[${i}]`,
                bArr[i], aArr[i],
                bSensArr[i], aSensArr[i], aUnkArr[i],
                i < bArr.length, i < aArr.length,
                out,
            );
        }
        return;
    }

    const bPresent = bHas || bSens;
    const aPresent = aHas || aSens || aUnk;
    if (!bPresent && !aPresent) return;

    let kind: '+' | '-' | '~' | '=';
    if (!bPresent && aPresent) kind = '+';
    else if (bPresent && !aPresent) kind = '-';
    else if (!deepEqual(bRaw, aRaw)) kind = '~';
    else kind = '=';

    const before = kind === '+' ? undefined
        : (bSens ? '(sensitive)' : formatValue(bRaw));
    const after = kind === '-' ? undefined
        : (aUnk ? '(known after apply)'
            : aSens ? '(sensitive)'
            : formatValue(aRaw));

    out.push({ key: path, kind, before, after });
}

function topKey(path: string): string {
    const dot = path.indexOf('.');
    const bracket = path.indexOf('[');
    if (dot === -1 && bracket === -1) return path;
    if (dot === -1) return path.slice(0, bracket);
    if (bracket === -1) return path.slice(0, dot);
    return path.slice(0, Math.min(dot, bracket));
}

function summarizeUnchanged(topKey: string, entries: AttrDiff[]): AttrDiff {
    if (entries.length === 1 && entries[0].key === topKey) return entries[0];
    const isArr = entries.some(e => e.key.startsWith(`${topKey}[`));
    const placeholder = isArr ? '[…]' : '{…}';
    return { key: topKey, kind: '=', before: placeholder, after: placeholder };
}

export function computeDiff(change: Change): ResourceDiff {
    const out: AttrDiff[] = [];
    walkDiff(
        '',
        change.before,
        change.after,
        change.before_sensitive,
        change.after_sensitive,
        change.after_unknown,
        change.before !== undefined,
        change.after !== undefined,
        out,
    );
    out.sort((a, b) => a.key.localeCompare(b.key));

    const groups = new Map<string, AttrDiff[]>();
    for (const e of out) {
        const top = topKey(e.key);
        let bucket = groups.get(top);
        if (!bucket) { bucket = []; groups.set(top, bucket); }
        bucket.push(e);
    }

    const changed: AttrDiff[] = [];
    const unchanged: AttrDiff[] = [];
    for (const [top, entries] of groups) {
        const anyChange = entries.some(e => e.kind !== '=');
        if (anyChange) {
            for (const e of entries) if (e.kind !== '=') changed.push(e);
        } else {
            unchanged.push(summarizeUnchanged(top, entries));
        }
    }
    return { changed, unchanged };
}

export function formatReplacePath(path: unknown[]): string {
    return path.map(p => typeof p === 'number' ? `[${p}]` : String(p)).join('.');
}
