# Azure DevOps Terraform Plan Viewer

An extension for Azure DevOps which shows a beautiful UI of Terraform plan output within a pipeline run.

## Features

- 📊 **Visual Dashboard**: See at a glance what will be created, updated, deleted, or recreated
- 🎨 **Color-Coded Display**: Easy-to-understand color coding for different actions
- 📑 **Custom Tab**: Dedicated "Terraform Plan" tab in your pipeline runs
- 🔍 **Detailed View**: View all resource changes in an organized, readable format

## Installation

1. Install the extension from the Azure DevOps Marketplace (or build and install manually)
2. Add the Terraform Plan Viewer task to your pipeline after running `terraform plan`

## Usage

### Step 1: Generate Terraform Plan JSON

First, generate a Terraform plan and export it as JSON:

```yaml
- task: Bash@3
  displayName: 'Terraform Plan'
  inputs:
    targetType: 'inline'
    script: |
      terraform init
      terraform plan -out=tfplan
      terraform show -json tfplan > tfplan.json
```

### Step 2: Add the Terraform Plan Viewer Task

Add the Terraform Plan Viewer task to process and display the plan:

```yaml
- task: TerraformPlanViewer@1
  displayName: 'Generate Terraform Plan Report'
  inputs:
    planJsonPath: '$(System.DefaultWorkingDirectory)/tfplan.json'
    attachmentName: 'terraform-plan'
```

### Step 3: View the Report

After the pipeline runs, navigate to the pipeline run details and click on the **"Terraform Plan"** tab to see the visual report.

## Example Pipeline

```yaml
trigger:
  - main

pool:
  vmImage: 'ubuntu-latest'

steps:
- task: TerraformInstaller@0
  inputs:
    terraformVersion: 'latest'

- task: Bash@3
  displayName: 'Terraform Init and Plan'
  inputs:
    targetType: 'inline'
    script: |
      cd terraform
      terraform init
      terraform plan -out=tfplan
      terraform show -json tfplan > tfplan.json

- task: TerraformPlanViewer@1
  displayName: 'Generate Terraform Plan Report'
  inputs:
    planJsonPath: '$(System.DefaultWorkingDirectory)/terraform/tfplan.json'
```

## Task Inputs

| Input | Required | Description | Default |
|-------|----------|-------------|---------|
| `planJsonPath` | Yes | Path to the Terraform plan JSON file (generated with `terraform show -json planfile`) | - |
| `attachmentName` | No | Name for the plan report attachment | `terraform-plan` |

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

## Publishing

To publish the extension to the Azure DevOps Marketplace:

1. Create a publisher account at https://marketplace.visualstudio.com/manage
2. Update the `publisher` field in `vss-extension.json`
3. Package the extension: `npm run package`
4. Upload the `.vsix` file to the marketplace
5. Mark as public and submit for review (Microsoft reviews public extensions)

**Note**: See [TESTING.md](TESTING.md) for detailed publishing instructions.

## License

MIT
