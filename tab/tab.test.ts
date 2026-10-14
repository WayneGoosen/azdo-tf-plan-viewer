import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    type Change,
    type ResourceChange,
    classifyAction,
    computeDiff,
    buildTree,
} from './planLogic';

interface TerraformPlan {
    format_version?: string;
    terraform_version?: string;
    resource_changes?: ResourceChange[];
    output_changes?: Record<string, unknown>;
    resource_drift?: ResourceChange[];
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
    it('shows sensitive value as (sensitive) rather than dropping it', () => {
        // Regression test for https://github.com/WayneGoosen/azdo-tf-plan-viewer/issues/6
        // A resource with after_sensitive set should show the attribute as "(sensitive)"
        // rather than dropping it from the diff entirely. This bug was fixed in production.
        
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
