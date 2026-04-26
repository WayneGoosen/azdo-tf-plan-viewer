import * as tl from 'azure-pipelines-task-lib/task';
import * as fs from 'fs';
import * as path from 'path';

const ATTACHMENT_TYPE = 'terraform-plan-viewer.plan';
const VALID_NAME = /^[A-Za-z0-9_-]+$/;

async function run() {
    try {
        const planJsonPath = tl.getInput('planJsonPath', true);
        const attachmentName = tl.getInput('attachmentName', false) || 'terraform-plan';

        if (!planJsonPath) {
            tl.setResult(tl.TaskResult.Failed, 'Plan JSON path is required');
            return;
        }
        if (!fs.existsSync(planJsonPath)) {
            tl.setResult(tl.TaskResult.Failed, `Plan file not found: ${planJsonPath}`);
            return;
        }
        if (!VALID_NAME.test(attachmentName)) {
            tl.setResult(tl.TaskResult.Failed,
                `Invalid attachmentName "${attachmentName}". Allowed characters: letters, digits, underscore, hyphen.`);
            return;
        }

        const raw = fs.readFileSync(planJsonPath, 'utf8');

        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch (e: any) {
            tl.setResult(tl.TaskResult.Failed, `Plan file is not valid JSON: ${e.message}`);
            return;
        }

        const resourceCount = Array.isArray(parsed?.resource_changes) ? parsed.resource_changes.length : 0;
        const sizeKb = (raw.length / 1024).toFixed(1);
        console.log(`Terraform version: ${parsed?.terraform_version ?? 'unknown'}`);
        console.log(`Resource changes: ${resourceCount}`);
        console.log(`Plan size: ${sizeKb} KiB`);

        const stagingDir = path.join(tl.getVariable('Agent.TempDirectory') || '.', 'terraform-plan-viewer');
        fs.mkdirSync(stagingDir, { recursive: true });
        const stagedPath = path.join(stagingDir, `${attachmentName}.json`);
        fs.writeFileSync(stagedPath, raw, 'utf8');

        // Attachment type is a contract between this task and the tab — keep both in sync.
        console.log(`##vso[task.addattachment type=${ATTACHMENT_TYPE};name=${attachmentName};]${stagedPath}`);

        tl.setResult(tl.TaskResult.Succeeded, `Attached Terraform plan (${resourceCount} resource changes)`);
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err?.message ?? String(err));
    }
}

run();
