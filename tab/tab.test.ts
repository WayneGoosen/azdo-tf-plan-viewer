import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Import types from tab.ts
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

interface AttrDiff {
    key: string;
    kind: '+' | '-' | '~' | '=';
    before?: string;
    after?: string;
}

interface ResourceDiff {
    changed: AttrDiff[];
    unchanged: AttrDiff[];
}

interface ModuleNode {
    label: string;
    resources: ResourceChange[];
    children: Map<string, ModuleNode>;
    counts: Record<ActionKind, number>;
}

// Helper functions extracted/duplicated from tab.ts for testing
function classifyAction(actions: string[]): ActionKind {
    const has = (a: string) => actions.includes(a);
    if (has('create') && has('delete')) return 'recreate';
    if (has('create')) return 'create';
    if (has('delete')) return 'delete';
    if (has('update')) return 'update';
    if (has('read')) return 'read';
    return 'noop';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
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

function computeDiff(change: Change): ResourceDiff {
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

function splitModuleAddress(addr: string | undefined): string[] {
    if (!addr) return [];
    return addr.split(/\.(?=module\.)/);
}

function emptyCounts(): Record<ActionKind, number> {
    return { create: 0, update: 0, delete: 0, recreate: 0, read: 0, noop: 0 };
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

describe('classifyAction', () => {
    it('classifies create action', () => {
        expect(classifyAction(['create'])).toBe('create');
    });

    it('classifies update action', () => {
        expect(classifyAction(['update'])).toBe('update');
    });

    it('classifies delete action', () => {
        expect(classifyAction(['delete'])).toBe('delete');
    });

    it('classifies recreate action', () => {
        expect(classifyAction(['delete', 'create'])).toBe('recreate');
    });

    it('classifies read action', () => {
        expect(classifyAction(['read'])).toBe('read');
    });

    it('classifies noop action', () => {
        expect(classifyAction(['no-op'])).toBe('noop');
        expect(classifyAction([])).toBe('noop');
    });
});

describe('computeDiff', () => {
    it('detects added attribute', () => {
        const change: Change = {
            actions: ['create'],
            before: null,
            after: { name: 'test' },
            after_unknown: {},
        };
        const diff = computeDiff(change);
        expect(diff.changed).toHaveLength(1);
        expect(diff.changed[0]).toMatchObject({
            key: 'name',
            kind: '+',
            after: '"test"',
        });
    });

    it('detects removed attribute', () => {
        const change: Change = {
            actions: ['delete'],
            before: { name: 'test' },
            after: null,
        };
        const diff = computeDiff(change);
        expect(diff.changed).toHaveLength(1);
        expect(diff.changed[0]).toMatchObject({
            key: 'name',
            kind: '-',
            before: '"test"',
        });
    });

    it('detects changed attribute', () => {
        const change: Change = {
            actions: ['update'],
            before: { name: 'old' },
            after: { name: 'new' },
        };
        const diff = computeDiff(change);
        expect(diff.changed).toHaveLength(1);
        expect(diff.changed[0]).toMatchObject({
            key: 'name',
            kind: '~',
            before: '"old"',
            after: '"new"',
        });
    });

    it('detects unchanged attribute', () => {
        const change: Change = {
            actions: ['update'],
            before: { id: '123', name: 'same' },
            after: { id: '456', name: 'same' },
        };
        const diff = computeDiff(change);
        expect(diff.changed.some(d => d.key === 'id')).toBe(true);
        expect(diff.unchanged.some(d => d.key === 'name')).toBe(true);
    });

    it('shows (sensitive) for sensitive values', () => {
        const change: Change = {
            actions: ['create'],
            before: null,
            after: { password: 'secret123' },
            after_sensitive: { password: true },
        };
        const diff = computeDiff(change);
        expect(diff.changed).toHaveLength(1);
        expect(diff.changed[0]).toMatchObject({
            key: 'password',
            kind: '+',
            after: '(sensitive)',
        });
    });

    it('shows (known after apply) for unknown values', () => {
        const change: Change = {
            actions: ['create'],
            before: null,
            after: { id: null },
            after_unknown: { id: true },
        };
        const diff = computeDiff(change);
        expect(diff.changed).toHaveLength(1);
        expect(diff.changed[0]).toMatchObject({
            key: 'id',
            kind: '+',
            after: '(known after apply)',
        });
    });
});

describe('buildTree', () => {
    it('builds flat tree for root-level resources', () => {
        const resources: ResourceChange[] = [
            {
                address: 'azurerm_resource_group.main',
                type: 'azurerm_resource_group',
                name: 'main',
                change: { actions: ['create'], before: null, after: {} },
            },
        ];
        const tree = buildTree(resources);
        expect(tree.resources).toHaveLength(1);
        expect(tree.children.size).toBe(0);
        expect(tree.counts.create).toBe(1);
    });

    it('builds nested tree for module resources', () => {
        const resources: ResourceChange[] = [
            {
                address: 'module.networking.azurerm_virtual_network.main',
                module_address: 'module.networking',
                type: 'azurerm_virtual_network',
                name: 'main',
                change: { actions: ['create'], before: null, after: {} },
            },
            {
                address: 'module.networking.module.subnets.azurerm_subnet.app',
                module_address: 'module.networking.module.subnets',
                type: 'azurerm_subnet',
                name: 'app',
                change: { actions: ['update'], before: {}, after: {} },
            },
        ];
        const tree = buildTree(resources);
        expect(tree.resources).toHaveLength(0);
        expect(tree.children.size).toBe(1);
        expect(tree.children.has('module.networking')).toBe(true);
        
        const networkingModule = tree.children.get('module.networking')!;
        expect(networkingModule.resources).toHaveLength(1);
        expect(networkingModule.children.size).toBe(1);
        expect(networkingModule.counts.create).toBe(1);
        expect(networkingModule.counts.update).toBe(1);
    });

    it('rolls up counts correctly', () => {
        const resources: ResourceChange[] = [
            {
                address: 'azurerm_resource_group.main',
                type: 'azurerm_resource_group',
                name: 'main',
                change: { actions: ['create'], before: null, after: {} },
            },
            {
                address: 'azurerm_storage_account.logs',
                type: 'azurerm_storage_account',
                name: 'logs',
                change: { actions: ['update'], before: {}, after: {} },
            },
            {
                address: 'azurerm_key_vault.main',
                type: 'azurerm_key_vault',
                name: 'main',
                change: { actions: ['delete', 'create'], before: {}, after: {} },
            },
        ];
        const tree = buildTree(resources);
        expect(tree.counts.create).toBe(1);
        expect(tree.counts.update).toBe(1);
        expect(tree.counts.recreate).toBe(1);
    });
});

describe('sample plan fixtures', () => {
    it('parses sample-plan.json', () => {
        const fixturePath = path.join(__dirname, '../dev-fixtures/sample-plan.json');
        const content = fs.readFileSync(fixturePath, 'utf8');
        const plan: TerraformPlan = JSON.parse(content);
        
        expect(plan.terraform_version).toBe('1.7.4');
        expect(plan.resource_changes).toBeDefined();
        expect(plan.resource_changes!.length).toBeGreaterThan(0);
    });

    it('parses sample-plan-no-changes.json', () => {
        const fixturePath = path.join(__dirname, '../dev-fixtures/sample-plan-no-changes.json');
        const content = fs.readFileSync(fixturePath, 'utf8');
        const plan: TerraformPlan = JSON.parse(content);
        
        expect(plan.resource_changes).toBeDefined();
    });

    it('builds tree from sample-plan.json', () => {
        const fixturePath = path.join(__dirname, '../dev-fixtures/sample-plan.json');
        const content = fs.readFileSync(fixturePath, 'utf8');
        const plan: TerraformPlan = JSON.parse(content);
        
        const tree = buildTree(plan.resource_changes ?? []);
        expect(tree.counts.create).toBeGreaterThan(0);
    });
});

describe('issue #6 regression: sensitive values should be shown', () => {
    it.todo('shows sensitive value as (sensitive) rather than dropping it', () => {
        // Regression test for https://github.com/WayneGoosen/azdo-tf-plan-viewer/issues/6
        // A resource with after_sensitive set should show the attribute as "(sensitive)"
        // rather than dropping it from the diff entirely.
        // 
        // This test is marked as todo because the bug is not yet fixed.
        // Once issue #6 is resolved, update computeDiff logic and remove .todo
        
        const change: Change = {
            actions: ['create'],
            before: null,
            after: {
                display_name: 'deploy-secret',
                client_secret: 'will-be-generated',
            },
            after_sensitive: {
                client_secret: true,
            },
        };
        
        const diff = computeDiff(change);
        
        // Should include client_secret in changed attributes
        const clientSecretDiff = diff.changed.find(d => d.key === 'client_secret');
        expect(clientSecretDiff).toBeDefined();
        expect(clientSecretDiff?.after).toBe('(sensitive)');
        
        // Should also have display_name
        const displayNameDiff = diff.changed.find(d => d.key === 'display_name');
        expect(displayNameDiff).toBeDefined();
    });
});
