import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    SENSITIVE_PLACEHOLDER,
    shouldRedactSensitive,
    redactValue,
    redactChange,
    slimPlan,
    preparePlanForUpload,
} from './redact';

describe('shouldRedactSensitive', () => {
    it('defaults to true when the input is missing or blank', () => {
        expect(shouldRedactSensitive(undefined)).toBe(true);
        expect(shouldRedactSensitive('')).toBe(true);
        expect(shouldRedactSensitive('   ')).toBe(true);
    });

    it('accepts true in any case', () => {
        expect(shouldRedactSensitive('true')).toBe(true);
        expect(shouldRedactSensitive('TRUE')).toBe(true);
        expect(shouldRedactSensitive(' True ')).toBe(true);
    });

    it('only disables redaction for an explicit false', () => {
        expect(shouldRedactSensitive('false')).toBe(false);
        expect(shouldRedactSensitive('FALSE')).toBe(false);
        expect(shouldRedactSensitive(' False ')).toBe(false);
    });

    it('keeps redaction on for typos and other non-false values', () => {
        expect(shouldRedactSensitive('tru')).toBe(true);
        expect(shouldRedactSensitive('0')).toBe(true);
        expect(shouldRedactSensitive('$(redactSensitive)')).toBe(true);
    });
});

describe('redactValue', () => {
    it('replaces a sensitive leaf with the placeholder', () => {
        expect(redactValue('s3cret', true)).toBe(SENSITIVE_PLACEHOLDER);
        expect(redactValue(42, true)).toBe(SENSITIVE_PLACEHOLDER);
        expect(redactValue({ nested: 's3cret' }, true)).toBe(SENSITIVE_PLACEHOLDER);
    });

    it('replaces a sensitive null with the placeholder', () => {
        expect(redactValue(null, true)).toBe(SENSITIVE_PLACEHOLDER);
    });

    it('leaves non-sensitive values alone, including null', () => {
        expect(redactValue('public', false)).toBe('public');
        expect(redactValue(null, false)).toBeNull();
        expect(redactValue(null, undefined)).toBeNull();
        expect(redactValue(0, false)).toBe(0);
        expect(redactValue(false, false)).toBe(false);
    });

    it('redacts nested object leaves and preserves the rest', () => {
        const value = {
            name: 'db',
            password: 'p@ss',
            tags: { env: 'prod', owner: 'platform' },
            nested: { key: 'visible', token: 'abc' },
        };
        const sensitive = {
            name: false,
            password: true,
            tags: { env: false, owner: false },
            nested: { key: false, token: true },
        };
        expect(redactValue(value, sensitive)).toEqual({
            name: 'db',
            password: SENSITIVE_PLACEHOLDER,
            tags: { env: 'prod', owner: 'platform' },
            nested: { key: 'visible', token: SENSITIVE_PLACEHOLDER },
        });
    });

    it('redacts nested array leaves', () => {
        const value = [
            { key: 'a', secret: 's1' },
            { key: 'b', secret: 's2' },
        ];
        const sensitive = [
            { key: false, secret: true },
            { key: false, secret: true },
        ];
        expect(redactValue(value, sensitive)).toEqual([
            { key: 'a', secret: SENSITIVE_PLACEHOLDER },
            { key: 'b', secret: SENSITIVE_PLACEHOLDER },
        ]);
    });

    it('redacts mixed array entries independently', () => {
        expect(redactValue(['a', 'secret', 'c'], [false, true, false])).toEqual([
            'a',
            SENSITIVE_PLACEHOLDER,
            'c',
        ]);
    });

    it('preserves a __proto__ map key alongside a sensitive sibling', () => {
        const value = JSON.parse('{"__proto__":"public","password":"s3cret"}');
        const sensitive = JSON.parse('{"__proto__":false,"password":true}');
        const out = redactValue(value, sensitive) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
        expect(out['__proto__']).toBe('public');
        expect(out.password).toBe(SENSITIVE_PLACEHOLDER);
        expect(JSON.stringify(out)).toContain('"__proto__":"public"');
        expect(JSON.stringify(out)).not.toContain('s3cret');
    });

    it('does not invent keys that exist only on the sensitive marker', () => {
        const value = { display_name: 'deploy-secret' };
        const sensitive = { display_name: false, client_secret: true };
        expect(redactValue(value, sensitive)).toEqual({ display_name: 'deploy-secret' });
    });

    it('leaves the value unchanged when the marker shape does not match', () => {
        expect(redactValue({ a: 1 }, [true])).toEqual({ a: 1 });
        expect(redactValue(['a'], { 0: true })).toEqual(['a']);
    });
});

describe('redactChange', () => {
    it('redacts before and after using their sensitive trees', () => {
        const change = {
            actions: ['update'],
            before: { name: 'old', password: 'old-secret' },
            after: { name: 'new', password: 'new-secret' },
            before_sensitive: { name: false, password: true },
            after_sensitive: { name: false, password: true },
            after_unknown: {},
            replace_paths: [['name']],
        };
        expect(redactChange(change)).toEqual({
            actions: ['update'],
            before: { name: 'old', password: SENSITIVE_PLACEHOLDER },
            after: { name: 'new', password: SENSITIVE_PLACEHOLDER },
            before_sensitive: { name: false, password: true },
            after_sensitive: { name: false, password: true },
            after_unknown: {},
            replace_paths: [['name']],
        });
    });

    it('redacts a wholly-sensitive output value', () => {
        const change = {
            actions: ['create'],
            before: null,
            after: 'conn-string',
            after_unknown: false,
            before_sensitive: false,
            after_sensitive: true,
        };
        expect(redactChange(change)).toEqual({
            actions: ['create'],
            before: null,
            after: SENSITIVE_PLACEHOLDER,
            after_unknown: false,
            before_sensitive: false,
            after_sensitive: true,
        });
    });

    it('passes through non-objects', () => {
        expect(redactChange(null)).toBeNull();
        expect(redactChange(undefined)).toBeUndefined();
    });
});

describe('slimPlan', () => {
    it('keeps only the fields the tab reads', () => {
        const slim = slimPlan({
            format_version: '1.2',
            terraform_version: '1.7.4',
            resource_changes: [{ address: 'a.b' }],
            output_changes: { out: { actions: ['create'] } },
            prior_state: { values: { secret: 'nope' } },
            configuration: { root_module: {} },
            variables: { password: { value: 'nope' } },
            planned_values: { outputs: {} },
            resource_drift: [{ address: 'drifted' }],
        });
        expect(Object.keys(slim).sort()).toEqual([
            'format_version',
            'output_changes',
            'resource_changes',
            'terraform_version',
        ].sort());
        expect(slim).toEqual({
            format_version: '1.2',
            terraform_version: '1.7.4',
            resource_changes: [{ address: 'a.b' }],
            output_changes: { out: { actions: ['create'] } },
        });
    });

    it('defaults missing resource_changes / output_changes', () => {
        expect(slimPlan({ format_version: '1.2' })).toEqual({
            format_version: '1.2',
            terraform_version: undefined,
            resource_changes: [],
            output_changes: {},
        });
    });
});

describe('preparePlanForUpload', () => {
    const plan = {
        format_version: '1.2',
        terraform_version: '1.7.4',
        prior_state: { values: { password: 'state-secret' } },
        variables: { api_key: { value: 'var-secret' } },
        configuration: { provider_config: {} },
        resource_changes: [
            {
                address: 'azurerm_key_vault.main',
                type: 'azurerm_key_vault',
                name: 'main',
                change: {
                    actions: ['update'],
                    before: {
                        name: 'kv',
                        app_settings: { API_KEY: 'state-secret' },
                    },
                    after: {
                        name: 'kv',
                        tags: { env: 'prod' },
                        nested: [{ id: 0, token: 'nested-token-value' }],
                    },
                    before_sensitive: { app_settings: true },
                    after_sensitive: { nested: [{ id: false, token: true }] },
                    after_unknown: {},
                },
            },
        ],
        output_changes: {
            connection_string: {
                actions: ['create'],
                before: null,
                after: 'AccountKey=real',
                after_unknown: false,
                before_sensitive: false,
                after_sensitive: true,
            },
            resource_group_name: {
                actions: ['create'],
                before: null,
                after: 'rg-prod',
                after_unknown: false,
                before_sensitive: false,
                after_sensitive: false,
            },
        },
    };

    it('slims and redacts by default', () => {
        const out = preparePlanForUpload(plan) as Record<string, unknown>;
        expect(out.prior_state).toBeUndefined();
        expect(out.variables).toBeUndefined();
        expect(out.configuration).toBeUndefined();
        expect(JSON.stringify(out)).not.toContain('state-secret');
        expect(JSON.stringify(out)).not.toContain('var-secret');
        expect(JSON.stringify(out)).not.toContain('AccountKey=real');
        expect(JSON.stringify(out)).not.toContain('nested-token-value');

        const resources = out.resource_changes as any[];
        expect(resources[0].address).toBe('azurerm_key_vault.main');
        expect(resources[0].change.actions).toEqual(['update']);
        expect(resources[0].change.before).toEqual({
            name: 'kv',
            app_settings: SENSITIVE_PLACEHOLDER,
        });
        expect(resources[0].change.after).toEqual({
            name: 'kv',
            tags: { env: 'prod' },
            nested: [{ id: 0, token: SENSITIVE_PLACEHOLDER }],
        });

        const outputs = out.output_changes as Record<string, any>;
        expect(outputs.connection_string.after).toBe(SENSITIVE_PLACEHOLDER);
        expect(outputs.connection_string.after_sensitive).toBe(true);
        expect(outputs.resource_group_name.after).toBe('rg-prod');
    });

    it('returns the original plan when redactSensitive is false', () => {
        const out = preparePlanForUpload(plan, false);
        expect(out).toBe(plan);
        expect(JSON.stringify(out)).toContain('state-secret');
        expect(JSON.stringify(out)).toContain('AccountKey=real');
    });

    it('redacts the sample plan fixture without dropping tab fields', () => {
        const fixturePath = path.join(__dirname, '..', 'dev-fixtures', 'sample-plan.json');
        const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
        const out = preparePlanForUpload(fixture) as Record<string, any>;

        expect(out.format_version).toBe(fixture.format_version);
        expect(out.terraform_version).toBe(fixture.terraform_version);
        expect(out.resource_changes).toHaveLength(fixture.resource_changes.length);
        expect(Object.keys(out.output_changes)).toEqual(Object.keys(fixture.output_changes));

        const deleted = out.resource_changes.find((r: any) => r.address === 'module.legacy.azurerm_app_service.old');
        expect(deleted.change.before.app_settings).toBe(SENSITIVE_PLACEHOLDER);
        expect(JSON.stringify(out)).not.toContain('"API_KEY":"secret"');
        expect(JSON.stringify(out)).not.toContain('"API_KEY": "secret"');

        // Non-sensitive values and marker-only write-only attrs stay as the tab expects.
        const password = out.resource_changes.find((r: any) => r.address === 'azuread_application_password.deploy');
        expect(password.change.after.display_name).toBe('deploy-secret');
        expect(password.change.after.client_secret).toBeUndefined();
        expect(password.change.after_sensitive.client_secret).toBe(true);

        expect(out.output_changes.storage_connection_string.before).toBe(SENSITIVE_PLACEHOLDER);
        expect(out.output_changes.storage_connection_string.after).toBe(SENSITIVE_PLACEHOLDER);
        expect(out.output_changes.resource_group_name.after).toBe('rg-prod-eastus');
    });
});
