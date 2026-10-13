import { describe, it, expect } from 'vitest';

// Test the binary plan detection logic
function looksLikeBinaryPlan(buf: Buffer): boolean {
    return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

const VALID_NAME = /^[A-Za-z0-9_-]+$/;

describe('looksLikeBinaryPlan', () => {
    it('detects binary plan with ZIP magic bytes', () => {
        const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
        expect(looksLikeBinaryPlan(buf)).toBe(true);
    });

    it('rejects JSON plan', () => {
        const buf = Buffer.from('{"format_version":"1.2"}');
        expect(looksLikeBinaryPlan(buf)).toBe(false);
    });

    it('rejects empty buffer', () => {
        const buf = Buffer.from([]);
        expect(looksLikeBinaryPlan(buf)).toBe(false);
    });

    it('rejects buffer shorter than 4 bytes', () => {
        const buf = Buffer.from([0x50, 0x4b]);
        expect(looksLikeBinaryPlan(buf)).toBe(false);
    });

    it('rejects buffer with wrong magic bytes', () => {
        const buf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
        expect(looksLikeBinaryPlan(buf)).toBe(false);
    });
});

describe('attachment name validation', () => {
    it('accepts valid names', () => {
        expect(VALID_NAME.test('terraform-plan')).toBe(true);
        expect(VALID_NAME.test('dev')).toBe(true);
        expect(VALID_NAME.test('prod_plan')).toBe(true);
        expect(VALID_NAME.test('plan-123')).toBe(true);
    });

    it('rejects invalid names', () => {
        expect(VALID_NAME.test('plan.json')).toBe(false);
        expect(VALID_NAME.test('plan/dev')).toBe(false);
        expect(VALID_NAME.test('plan name')).toBe(false);
        expect(VALID_NAME.test('../plan')).toBe(false);
        expect(VALID_NAME.test('plan@dev')).toBe(false);
    });

    it('rejects empty name', () => {
        expect(VALID_NAME.test('')).toBe(false);
    });
});

describe('CLI tool resolution', () => {
    const KNOWN_CLIS = ['terraform', 'tofu'];

    function validateCliTool(cliTool: string): boolean {
        if (cliTool === 'auto') return true;
        return KNOWN_CLIS.includes(cliTool);
    }

    it('accepts auto', () => {
        expect(validateCliTool('auto')).toBe(true);
    });

    it('accepts terraform', () => {
        expect(validateCliTool('terraform')).toBe(true);
    });

    it('accepts tofu', () => {
        expect(validateCliTool('tofu')).toBe(true);
    });

    it('rejects invalid tool name', () => {
        expect(validateCliTool('terragrunt')).toBe(false);
        expect(validateCliTool('../terraform')).toBe(false);
        expect(validateCliTool('/usr/bin/terraform')).toBe(false);
    });
});
