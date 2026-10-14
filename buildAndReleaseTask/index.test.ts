import { describe, it, expect } from 'vitest';
import { looksLikeBinaryPlan, validateAttachmentName, validateCliTool } from './validation';

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
        expect(validateAttachmentName('terraform-plan')).toBe(true);
        expect(validateAttachmentName('dev')).toBe(true);
        expect(validateAttachmentName('prod_plan')).toBe(true);
        expect(validateAttachmentName('plan-123')).toBe(true);
    });

    it('rejects invalid names', () => {
        expect(validateAttachmentName('plan.json')).toBe(false);
        expect(validateAttachmentName('plan/dev')).toBe(false);
        expect(validateAttachmentName('plan name')).toBe(false);
        expect(validateAttachmentName('../plan')).toBe(false);
        expect(validateAttachmentName('plan@dev')).toBe(false);
    });

    it('rejects empty name', () => {
        expect(validateAttachmentName('')).toBe(false);
    });
});

describe('CLI tool resolution', () => {
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
