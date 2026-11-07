import * as tl from 'azure-pipelines-task-lib/task';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { looksLikeBinaryPlan, parseOptInBoolean, validateAttachmentName, validateCliTool, KNOWN_CLIS } from './validation';
import { preparePlanForUpload, shouldRedactSensitive } from './redact';
import { withViewerSettings } from './viewerSettings';

const ATTACHMENT_TYPE = 'terraform-plan-viewer.plan';

// Resolves the CLI used to convert binary plans. Only the terraform/tofu found
// on the agent's PATH is ever run -- cliTool is never treated as a path, so a
// value from a less trusted source (e.g. a queue-time variable) can't point the
// task at an arbitrary file. 'auto' prefers terraform and falls back to tofu.
function resolveCli(cliTool: string): string {
    if (!validateCliTool(cliTool)) {
        throw new Error(`Invalid cliTool "${cliTool}". Use 'auto', 'terraform' or 'tofu'.`);
    }
    for (const name of cliTool === 'auto' ? KNOWN_CLIS : [cliTool]) {
        const found = tl.which(name, false);
        if (found) {
            return found;
        }
    }
    return '';
}

function convertBinaryPlanToJson(planPath: string, cliTool: string): string {
    const cli = resolveCli(cliTool);
    if (!cli) {
        const looked = cliTool === 'auto' ? `'terraform' or 'tofu'` : `'${cliTool}'`;
        throw new Error(
            `Plan at "${planPath}" is a binary plan, but ${looked} could not be found on PATH, ` +
            `so it can't be converted. Make the CLI that produced the plan available to the ` +
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
        const redactSensitive = shouldRedactSensitive(tl.getInput('redactSensitive', false));
        const hideNoChangePlans = parseOptInBoolean(tl.getInput('hideNoChangePlans', false));

        if (!planPath) {
            tl.setResult(tl.TaskResult.Failed, 'planPath is required (path to a Terraform plan file, binary or JSON).');
            return;
        }
        if (!fs.existsSync(planPath)) {
            tl.setResult(tl.TaskResult.Failed, `Plan file not found: ${planPath}`);
            return;
        }
        if (!validateAttachmentName(attachmentName)) {
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

        // Display options for the tab ride along in the attachment. Only added
        // when set, so a default run attaches exactly what it did before.
        const settle = (plan: unknown) => hideNoChangePlans
            ? withViewerSettings(plan, { hideNoChangePlans })
            : plan;

        let uploadJson: string;
        if (redactSensitive) {
            const prepared = settle(preparePlanForUpload(parsed, true));
            uploadJson = JSON.stringify(prepared);
            const beforeKiB = json.length / 1024;
            const afterKiB = uploadJson.length / 1024;
            const savedPct = json.length > 0 ? (1 - uploadJson.length / json.length) * 100 : 0;
            console.log('Redacting Terraform-marked sensitive values and dropping unused plan fields.');
            console.log(`Plan size: ${beforeKiB.toFixed(1)} KiB → ${afterKiB.toFixed(1)} KiB (${savedPct.toFixed(0)}% smaller)`);
        } else {
            uploadJson = hideNoChangePlans ? JSON.stringify(settle(parsed)) : json;
            console.log('redactSensitive=false: attaching the full unredacted plan JSON.');
            console.log(`Plan size: ${(json.length / 1024).toFixed(1)} KiB`);
        }

        const stagingDir = path.join(tl.getVariable('Agent.TempDirectory') || '.', 'terraform-plan-viewer');
        fs.mkdirSync(stagingDir, { recursive: true });
        const stagedPath = path.join(stagingDir, `${attachmentName}.json`);
        fs.writeFileSync(stagedPath, uploadJson, 'utf8');

        // Attachment type is a contract between this task and the tab — keep both in sync.
        tl.addAttachment(ATTACHMENT_TYPE, attachmentName, stagedPath);
        if (hideNoChangePlans) {
            console.log('hideNoChangePlans=true: the tab hides this plan from its dropdown when it has no changes.');
        }

        tl.setResult(tl.TaskResult.Succeeded, `Attached Terraform plan (${resourceCount} resource changes)`);
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err?.message ?? String(err));
    }
}

// run() reports its own failures via setResult; this catches anything that escapes.
run().catch((err) => tl.setResult(tl.TaskResult.Failed, err?.message ?? String(err)));
