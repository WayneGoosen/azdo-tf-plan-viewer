// =============================================================================
// Task Input Validation — Pure validation functions
//
// Extracted validation logic shared by the task runner and tests.
// =============================================================================

export const VALID_NAME = /^[A-Za-z0-9_-]+$/;
export const KNOWN_CLIS = ['terraform', 'tofu'];

export function looksLikeBinaryPlan(buf: Buffer): boolean {
    return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

export function validateAttachmentName(name: string): boolean {
    return VALID_NAME.test(name);
}

/**
 * Opt-in boolean task inputs: only an explicit case-insensitive `true` turns
 * the feature on. Missing, blank, typos, or unresolved variables stay off.
 */
export function parseOptInBoolean(raw: string | undefined): boolean {
    return (raw ?? '').trim().toLowerCase() === 'true';
}

export function validateCliTool(cliTool: string): boolean {
    if (cliTool === 'auto') return true;
    return KNOWN_CLIS.includes(cliTool);
}
