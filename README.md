# Azure DevOps Terraform Plan Viewer

An extension for Azure DevOps which shows a beautiful UI of Terraform plan output within a pipeline run.

## Features

- 📊 **Visual Dashboard**: See at a glance what will be created, updated, deleted, or recreated
- 🎨 **Color-Coded Display**: Easy-to-understand color coding for different actions
- 📑 **Custom Tab**: Dedicated "Plan Review" tab in your pipeline runs
- 🔍 **Detailed View**: View all resource changes in an organized, readable format

## Installation

1. Install the extension from the Azure DevOps Marketplace (or build and install manually)
2. Add the Terraform Plan Viewer task to your pipeline after running `terraform plan`

## Usage

### Step 1: Generate a Terraform plan

```yaml
- task: TerraformInstaller@0
  inputs:
    terraformVersion: 'latest'

- task: Bash@3
  displayName: 'Terraform Plan'
  inputs:
    targetType: 'inline'
    script: |
      terraform init
      terraform plan -out=tfplan
```

### Step 2: Add the Terraform Plan Viewer Task

```yaml
- task: TerraformPlanViewer@1
  displayName: 'Publish Terraform Plan'
  inputs:
    planPath: '$(System.DefaultWorkingDirectory)/tfplan'
```

The binary plan is converted on the agent via `terraform show -json`. If you'd rather convert it yourself, pass a JSON file (`terraform show -json tfplan > tfplan.json`) — both forms work.

### Step 3: View the Report

After the pipeline runs, open the pipeline run and click the **"Plan Review"** tab.

## Multi-stage pipelines

Run the task once per stage with distinct `attachmentName` values. The tab shows a dropdown to switch between plans without reloading.

```yaml
- task: TerraformPlanViewer@1
  displayName: 'Publish dev plan'
  inputs:
    planPath: '$(System.DefaultWorkingDirectory)/dev/tfplan'
    attachmentName: 'dev'

- task: TerraformPlanViewer@1
  displayName: 'Publish prod plan'
  inputs:
    planPath: '$(System.DefaultWorkingDirectory)/prod/tfplan'
    attachmentName: 'prod'
```

The selector is hidden when only one plan is attached.

## Task Inputs

| Input | Required | Description | Default |
|-------|----------|-------------|---------|
| `planPath` | Yes | Path to a Terraform plan — binary (`terraform plan -out=...`) or JSON (`terraform show -json`). Binary plans are converted on the agent via the `terraform` CLI. | - |
| `attachmentName` | No | Identifier for the attachment; used as the label in the tab's plan selector. | `terraform-plan` |

## Building from Source

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   npm run build
   ```
4. Package the extension:
   ```bash
   npm run package
   ```
5. The `.vsix` file will be created in the `dist` directory

## Testing the Extension

Before publishing, you can test the extension in your own Azure DevOps organization:

1. Build and package the extension (see above)
2. Upload the `.vsix` file as a **private** extension to the marketplace
3. Share it with your organization
4. Install it in your organization
5. Create a test pipeline to verify functionality

**📖 For detailed testing instructions, see [TESTING.md](TESTING.md)**

The testing guide covers:
- Creating a publisher account
- Uploading as a private extension
- Installing in your organization
- Creating test pipelines with sample data
- Verifying the extension works correctly
- Troubleshooting common issues

## Releasing & Publishing

The full release pipeline (CI workflows, GitVersion, marketplace publish) is documented in **[.github/RELEASING.md](.github/RELEASING.md)**:

- One-time setup: creating the Azure DevOps `ADO_PUBLISHER_PAT`, adding it as a GitHub secret, anchoring GitVersion's commit count.
- Day-to-day flow: how PR / main / publish-to-marketplace workflows fit together.
- Overriding the version bump via `+semver:` commit footers.
- Troubleshooting publish failures.

For first-time manual marketplace upload (before automated publishing is wired), see [TESTING.md](TESTING.md).

## License

MIT
