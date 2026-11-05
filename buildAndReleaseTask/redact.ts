// =============================================================================
// Plan attachment redaction — Pure helpers
//
// The Plan Review tab only reads format_version, terraform_version,
// resource_changes, and output_changes. Terraform JSON plans also carry
// prior_state / configuration / variables / planned_values, and they embed
// the real values of attributes marked sensitive. Anyone with build read
// access can download the attachment, so by default we drop unused fields
// and replace every Terraform-marked sensitive leaf with the same
// "(sensitive)" placeholder the tab already displays.
// =============================================================================

export const SENSITIVE_PLACEHOLDER = '(sensitive)';

const VIEWER_PLAN_KEYS = ['format_version', 'terraform_version', 'resource_changes', 'output_changes'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Boolean task inputs arrive as "true"/"false". Missing, blank, typos, or
 * unresolved variables stay ON so a forgotten or malformed input never
 * stores raw secrets. Only an explicit case-insensitive `false` opts out.
 */
export function shouldRedactSensitive(raw: string | undefined): boolean {
    if (raw === undefined || raw.trim() === '') {
        return true;
    }
    return raw.trim().toUpperCase() !== 'FALSE';
}

/**
 * Walk `value` in parallel with Terraform's `*_sensitive` marker tree.
 * A `true` marker redacts that entire subtree; objects/arrays recurse.
 */
export function redactValue(value: unknown, sensitive: unknown): unknown {
    if (sensitive === true) {
        return SENSITIVE_PLACEHOLDER;
    }
    if (Array.isArray(value) && Array.isArray(sensitive)) {
        return value.map((item, i) => redactValue(item, sensitive[i]));
    }
    if (isPlainObject(value) && isPlainObject(sensitive)) {
        // Null prototype so a Terraform map key named `__proto__` is kept as
        // an own property instead of invoking Object.prototype.__proto__.
        const out: Record<string, unknown> = Object.create(null);
        for (const key of Object.keys(value)) {
            out[key] = redactValue(value[key], sensitive[key]);
        }
        return out;
    }
    return value;
}

export function redactChange(change: unknown): unknown {
    if (!isPlainObject(change)) {
        return change;
    }
    const next: Record<string, unknown> = { ...change };
    if ('before' in next) {
        next.before = redactValue(next.before, next.before_sensitive);
    }
    if ('after' in next) {
        next.after = redactValue(next.after, next.after_sensitive);
    }
    return next;
}

export function slimPlan(plan: unknown): Record<string, unknown> {
    const src = isPlainObject(plan) ? plan : {};
    const slim: Record<string, unknown> = {};
    for (const key of VIEWER_PLAN_KEYS) {
        slim[key] = src[key];
    }
    if (!Array.isArray(slim.resource_changes)) {
        slim.resource_changes = [];
    }
    if (!isPlainObject(slim.output_changes)) {
        slim.output_changes = {};
    }
    return slim;
}

/**
 * Default path: keep only tab-needed fields and redact sensitive leaves.
 * When `redactSensitive` is false, return the original plan unchanged
 * (full JSON, including secrets and unused fields).
 */
export function preparePlanForUpload(plan: unknown, redactSensitive = true): unknown {
    if (!redactSensitive) {
        return plan;
    }
    const slim = slimPlan(plan);
    const resourceChanges = slim.resource_changes as unknown[];
    const outputChanges = slim.output_changes as Record<string, unknown>;
    return {
        ...slim,
        resource_changes: resourceChanges.map((rc) => {
            if (!isPlainObject(rc)) {
                return rc;
            }
            return { ...rc, change: redactChange(rc.change) };
        }),
        output_changes: Object.fromEntries(
            Object.entries(outputChanges).map(([name, change]) => [name, redactChange(change)]),
        ),
    };
}
