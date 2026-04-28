import * as tl from 'azure-pipelines-task-lib/task';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ATTACHMENT_TYPE = 'terraform-plan-viewer.plan';
const VALID_NAME = /^[A-Za-z0-9_-]+$/;

// Terraform binary plan files are ZIP archives — they always start with the
// ZIP local-file-header magic bytes "PK\x03\x04". JSON plans never do.
function looksLikeBinaryPlan(buf: Buffer): boolean {
    return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function convertBinaryPlanToJson(planPath: string): string {
    const tf = tl.which('terraform', false);
    if (!tf) {
        throw new Error(
            `Plan at "${planPath}" is a binary Terraform plan and the 'terraform' CLI ` +
            `is not on PATH to convert it. Either add a TerraformInstaller (or run a ` +
            `TerraformTaskV4 step) earlier in the pipeline so terraform is available, ` +
            `or convert it yourself with 'terraform show -json' and pass the resulting JSON file.`
        );
    }

    // execFileSync passes args as an argv array (no shell), so no injection risk.
    // CWD is the plan's directory so terraform finds .terraform/ for providers/modules.
    try {
        return execFileSync(tf, ['show', '-json', planPath], {
            cwd: path.dirname(planPath),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 256 * 1024 * 1024,
        });
    } catch (e: any) {
        const stderr: string = (e?.stderr ?? '').toString().trim() || e?.message || String(e);
        throw new Error(`'terraform show -json' failed: ${stderr}`);
    }
}

async function run() {
    try {
        const planPath = tl.getInput('planPath', true);
        const attachmentName = tl.getInput('attachmentName', false) || 'terraform-plan';

        if (!planPath) {
            tl.setResult(tl.TaskResult.Failed, 'planPath is required (path to a Terraform plan file, binary or JSON).');
            return;
        }
        if (!fs.existsSync(planPath)) {
            tl.setResult(tl.TaskResult.Failed, `Plan file not found: ${planPath}`);
            return;
        }
        if (!VALID_NAME.test(attachmentName)) {
            tl.setResult(tl.TaskResult.Failed,
                `Invalid attachmentName "${attachmentName}". Allowed characters: letters, digits, underscore, hyphen.`);
            return;
        }

        const buf = fs.readFileSync(planPath);

        let json: string;
        if (looksLikeBinaryPlan(buf)) {
            console.log(`Detected binary Terraform plan; converting via 'terraform show -json'...`);
            json = convertBinaryPlanToJson(planPath);
        } else {
            json = buf.toString('utf8');
        }

        let parsed: any;
        try {
            parsed = JSON.parse(json);
        } catch (e: any) {
            tl.setResult(tl.TaskResult.Failed,
                `Plan file is neither a binary Terraform plan nor valid JSON: ${e.message}`);
            return;
        }

        const resourceCount = Array.isArray(parsed?.resource_changes) ? parsed.resource_changes.length : 0;
        console.log(`Terraform version: ${parsed?.terraform_version ?? 'unknown'}`);
        console.log(`Resource changes: ${resourceCount}`);
        console.log(`Plan size: ${(json.length / 1024).toFixed(1)} KiB`);

        const stagingDir = path.join(tl.getVariable('Agent.TempDirectory') || '.', 'terraform-plan-viewer');
        fs.mkdirSync(stagingDir, { recursive: true });
        const stagedPath = path.join(stagingDir, `${attachmentName}.json`);
        fs.writeFileSync(stagedPath, json, 'utf8');

        // Attachment type is a contract between this task and the tab — keep both in sync.
        tl.addAttachment(ATTACHMENT_TYPE, attachmentName, stagedPath);

        tl.setResult(tl.TaskResult.Succeeded, `Attached Terraform plan (${resourceCount} resource changes)`);
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err?.message ?? String(err));
    }
}

run();
