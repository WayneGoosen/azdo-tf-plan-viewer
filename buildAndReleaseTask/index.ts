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

const KNOWN_CLIS = ['terraform', 'tofu'];

// Only terraform/tofu binaries are ever executed, so a cliTool value from an
// untrusted source (e.g. a queue-time variable) can't run an arbitrary program.
function isKnownCliBinary(p: string): boolean {
    const name = path.basename(p).toLowerCase().replace(/\.exe$/, '');
    return KNOWN_CLIS.includes(name);
}

// Resolves the CLI used to convert binary plans. 'auto' prefers terraform and
// falls back to tofu; 'terraform'/'tofu' look up that name on PATH; anything
// else must be a path to a terraform or tofu binary.
function resolveCli(cliTool: string): string {
    if (cliTool === 'auto') {
        for (const name of KNOWN_CLIS) {
            const found = tl.which(name, false);
            if (found) {
                return found;
            }
        }
        return '';
    }
    if (KNOWN_CLIS.includes(cliTool)) {
        return tl.which(cliTool, false);
    }
    if (!isKnownCliBinary(cliTool)) {
        throw new Error(
            `Invalid cliTool "${cliTool}". Use 'auto', 'terraform', 'tofu', or a path ` +
            `to a terraform or tofu binary (e.g. /opt/tofu/bin/tofu).`
        );
    }
    return fs.existsSync(cliTool) && fs.statSync(cliTool).isFile() ? cliTool : '';
}

function convertBinaryPlanToJson(planPath: string, cliTool: string): string {
    const cli = resolveCli(cliTool);
    if (!cli) {
        const looked = cliTool === 'auto' ? `'terraform' or 'tofu' could not be found on PATH`
            : KNOWN_CLIS.includes(cliTool) ? `'${cliTool}' could not be found on PATH`
            : `'${cliTool}' does not exist`;
        throw new Error(
            `Plan at "${planPath}" is a binary plan, but ${looked}, so it can't be converted. Make the CLI that produced the plan available to the ` +
            `agent (e.g. a TerraformInstaller step for Terraform, or install OpenTofu on the ` +
            `agent), set the 'cliTool' input, or convert the plan yourself with ` +
            `'terraform show -json' / 'tofu show -json' and pass the resulting JSON file.`
        );
    }
    const cliName = path.basename(cli);
    console.log(`Converting binary plan via '${cliName} show -json' (${cli})...`);

    // execFileSync passes args as an argv array (no shell), so no injection risk.
    // CWD is the plan's directory so the CLI finds .terraform/ for providers/modules.
    try {
        return execFileSync(cli, ['show', '-json', planPath], {
            cwd: path.dirname(planPath),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 256 * 1024 * 1024,
        });
    } catch (e: any) {
        const stderr: string = (e?.stderr ?? '').toString().trim() || e?.message || String(e);
        throw new Error(`'${cliName} show -json' failed: ${stderr}`);
    }
}

async function run() {
    try {
        const planPath = tl.getInput('planPath', true);
        const attachmentName = tl.getInput('attachmentName', false) || 'terraform-plan';
        const cliTool = (tl.getInput('cliTool', false) || 'auto').trim();

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
            console.log('Detected binary plan.');
            json = convertBinaryPlanToJson(planPath, cliTool);
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
