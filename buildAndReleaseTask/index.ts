import * as tl from 'azure-pipelines-task-lib/task';
import * as fs from 'fs';
import * as path from 'path';

interface TerraformChange {
    address: string;
    mode: string;
    type: string;
    name: string;
    actions: string[];
    before?: any;
    after?: any;
    after_unknown?: any;
}

interface TerraformPlan {
    format_version?: string;
    terraform_version?: string;
    resource_changes?: TerraformChange[];
}

function generateHtmlReport(plan: TerraformPlan): string {
    const resourceChanges = plan.resource_changes || [];
    
    const create = resourceChanges.filter(r => r.actions.includes('create'));
    const update = resourceChanges.filter(r => r.actions.includes('update'));
    const deleteChanges = resourceChanges.filter(r => r.actions.includes('delete') && !r.actions.includes('create'));
    const recreate = resourceChanges.filter(r => r.actions.includes('delete') && r.actions.includes('create'));
    const noChange = resourceChanges.filter(r => r.actions.includes('no-op'));

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Terraform Plan</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background-color: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            margin-top: 0;
            border-bottom: 3px solid #5c4ee5;
            padding-bottom: 15px;
        }
        .summary {
            display: flex;
            flex-wrap: wrap;
            gap: 15px;
            margin: 30px 0;
        }
        .summary-card {
            flex: 1;
            min-width: 150px;
            padding: 20px;
            border-radius: 6px;
            color: white;
            text-align: center;
        }
        .summary-card.create {
            background: linear-gradient(135deg, #4caf50, #2e7d32);
        }
        .summary-card.update {
            background: linear-gradient(135deg, #ff9800, #f57c00);
        }
        .summary-card.delete {
            background: linear-gradient(135deg, #f44336, #c62828);
        }
        .summary-card.recreate {
            background: linear-gradient(135deg, #9c27b0, #6a1b9a);
        }
        .summary-card .count {
            font-size: 48px;
            font-weight: bold;
            margin: 10px 0;
        }
        .summary-card .label {
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .section {
            margin: 30px 0;
        }
        .section-title {
            font-size: 24px;
            color: #333;
            margin: 20px 0 15px 0;
            padding: 10px 0;
            border-bottom: 2px solid #e0e0e0;
        }
        .resource-item {
            margin: 10px 0;
            padding: 15px;
            border-left: 4px solid;
            background-color: #fafafa;
            border-radius: 4px;
        }
        .resource-item.create {
            border-left-color: #4caf50;
            background-color: #f1f8f4;
        }
        .resource-item.update {
            border-left-color: #ff9800;
            background-color: #fff8f1;
        }
        .resource-item.delete {
            border-left-color: #f44336;
            background-color: #fef1f1;
        }
        .resource-item.recreate {
            border-left-color: #9c27b0;
            background-color: #f8f1f9;
        }
        .resource-address {
            font-family: 'Courier New', monospace;
            font-size: 16px;
            font-weight: bold;
            color: #333;
        }
        .resource-type {
            font-size: 12px;
            color: #666;
            margin-top: 5px;
        }
        .action-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 12px;
            font-weight: bold;
            margin-left: 10px;
        }
        .action-badge.create {
            background-color: #4caf50;
            color: white;
        }
        .action-badge.update {
            background-color: #ff9800;
            color: white;
        }
        .action-badge.delete {
            background-color: #f44336;
            color: white;
        }
        .action-badge.recreate {
            background-color: #9c27b0;
            color: white;
        }
        .metadata {
            background-color: #f0f0f0;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 30px;
        }
        .metadata-item {
            display: inline-block;
            margin-right: 30px;
            color: #666;
        }
        .metadata-label {
            font-weight: bold;
            color: #333;
        }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: #999;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🏗️ Terraform Plan Report</h1>
        
        <div class="metadata">
            ${plan.terraform_version ? `<div class="metadata-item"><span class="metadata-label">Terraform Version:</span> ${plan.terraform_version}</div>` : ''}
            ${plan.format_version ? `<div class="metadata-item"><span class="metadata-label">Format Version:</span> ${plan.format_version}</div>` : ''}
        </div>

        <div class="summary">
            <div class="summary-card create">
                <div class="label">To Create</div>
                <div class="count">${create.length}</div>
            </div>
            <div class="summary-card update">
                <div class="label">To Update</div>
                <div class="count">${update.length}</div>
            </div>
            <div class="summary-card delete">
                <div class="label">To Delete</div>
                <div class="count">${deleteChanges.length}</div>
            </div>
            <div class="summary-card recreate">
                <div class="label">To Recreate</div>
                <div class="count">${recreate.length}</div>
            </div>
        </div>

        ${create.length > 0 ? `
        <div class="section">
            <div class="section-title">✨ Resources to Create (${create.length})</div>
            ${create.map(r => `
                <div class="resource-item create">
                    <div class="resource-address">${r.address}<span class="action-badge create">CREATE</span></div>
                    <div class="resource-type">Type: ${r.type}</div>
                </div>
            `).join('')}
        </div>
        ` : ''}

        ${update.length > 0 ? `
        <div class="section">
            <div class="section-title">🔄 Resources to Update (${update.length})</div>
            ${update.map(r => `
                <div class="resource-item update">
                    <div class="resource-address">${r.address}<span class="action-badge update">UPDATE</span></div>
                    <div class="resource-type">Type: ${r.type}</div>
                </div>
            `).join('')}
        </div>
        ` : ''}

        ${recreate.length > 0 ? `
        <div class="section">
            <div class="section-title">🔁 Resources to Recreate (${recreate.length})</div>
            ${recreate.map(r => `
                <div class="resource-item recreate">
                    <div class="resource-address">${r.address}<span class="action-badge recreate">RECREATE</span></div>
                    <div class="resource-type">Type: ${r.type}</div>
                </div>
            `).join('')}
        </div>
        ` : ''}

        ${deleteChanges.length > 0 ? `
        <div class="section">
            <div class="section-title">🗑️ Resources to Delete (${deleteChanges.length})</div>
            ${deleteChanges.map(r => `
                <div class="resource-item delete">
                    <div class="resource-address">${r.address}<span class="action-badge delete">DELETE</span></div>
                    <div class="resource-type">Type: ${r.type}</div>
                </div>
            `).join('')}
        </div>
        ` : ''}

        ${resourceChanges.length === 0 ? `
        <div class="empty-state">
            <h2>No changes detected</h2>
            <p>Your infrastructure matches the configuration.</p>
        </div>
        ` : ''}
    </div>
</body>
</html>
    `;
    
    return html;
}

async function run() {
    try {
        // Get inputs
        const planJsonPath: string | undefined = tl.getInput('planJsonPath', true);
        const attachmentName: string = tl.getInput('attachmentName', false) || 'terraform-plan';

        if (!planJsonPath) {
            tl.setResult(tl.TaskResult.Failed, 'Plan JSON path is required');
            return;
        }

        // Check if file exists
        if (!fs.existsSync(planJsonPath)) {
            tl.setResult(tl.TaskResult.Failed, `Plan file not found: ${planJsonPath}`);
            return;
        }

        console.log(`Reading Terraform plan from: ${planJsonPath}`);

        // Read and parse the plan JSON
        const planContent = fs.readFileSync(planJsonPath, 'utf8');
        const plan: TerraformPlan = JSON.parse(planContent);

        console.log(`Terraform version: ${plan.terraform_version || 'unknown'}`);
        console.log(`Resource changes: ${plan.resource_changes?.length || 0}`);

        // Generate HTML report
        const htmlReport = generateHtmlReport(plan);

        // Save the HTML report to a file
        const reportDir = path.join(tl.getVariable('Agent.TempDirectory') || '.', 'terraform-reports');
        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
        }

        const reportPath = path.join(reportDir, `${attachmentName}.html`);
        fs.writeFileSync(reportPath, htmlReport, 'utf8');

        console.log(`Report generated: ${reportPath}`);

        // Upload the report as a build attachment
        // This attachment will be displayed in the custom "Terraform Plan" tab
        console.log(`##vso[task.addattachment type=Distributedtask.Core.Summary;name=${attachmentName};]${reportPath}`);

        tl.setResult(tl.TaskResult.Succeeded, 'Terraform plan report generated successfully');
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message);
    }
}

run();
