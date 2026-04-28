# Testing the Extension in Azure DevOps

This guide explains how to test the Terraform Plan Viewer extension in your Azure DevOps instance before publishing it to the marketplace.

## Prerequisites

1. An Azure DevOps organization (you can create a free one at https://dev.azure.com)
2. A project in your Azure DevOps organization
3. Node.js and npm installed locally
4. The extension packaged as a `.vsix` file

## Step 1: Build and Package the Extension

```bash
# Clone the repository (if not already done)
git clone https://github.com/WayneGoosen/azdo-tf-plan-viewer.git
cd azdo-tf-plan-viewer

# Install dependencies
npm install
cd buildAndReleaseTask && npm install && cd ..

# Build and package
npm run package
```

This will create a `.vsix` file in the `dist` directory (e.g., `terraform-tools.terraform-plan-viewer-1.0.0.vsix`).

## Step 2: Create a Publisher (if you don't have one)

1. Go to https://marketplace.visualstudio.com/manage
2. Sign in with your Azure DevOps account
3. Click **Create Publisher** if you don't have one
4. Fill in the required information:
   - **Publisher ID**: A unique identifier (e.g., `your-name` or `your-company`)
   - **Display name**: A friendly name for your publisher
5. Click **Create**

## Step 3: Update the Extension Manifest

Before uploading, update the `publisher` field in `vss-extension.json` to match your publisher ID:

```json
{
  "publisher": "your-publisher-id",
  "id": "terraform-plan-viewer",
  "name": "Terraform Plan Viewer",
  "version": "1.0.0",
  ...
}
```

After updating, rebuild the package:

```bash
npm run package
```

## Step 4: Upload the Extension as Private

1. Go to https://marketplace.visualstudio.com/manage/publishers/`your-publisher-id`
2. Click **+ New extension** → **Azure DevOps**
3. Upload your `.vsix` file
4. **IMPORTANT**: Make sure the extension is set to **Private** (not public)
   - In the extension details, ensure **Public** is not selected
   - This allows you to test it in your organization without making it publicly available

## Step 5: Share the Extension with Your Organization

1. After uploading, click on the extension in your publisher management page
2. Click **Share/Unshare**
3. Enter your Azure DevOps organization name
4. Click **Share**

## Step 6: Install the Extension in Your Organization

1. Go to your Azure DevOps organization (`https://dev.azure.com/your-org`)
2. Click on the **Organization settings** (gear icon in bottom left)
3. Under **General**, click **Extensions**
4. Click **Shared** tab to see extensions shared with your organization
5. Find **Terraform Plan Viewer** and click **Install**
6. Select the organization where you want to install it
7. Click **Install**

## Step 7: Create a Test Pipeline

Create a test pipeline to verify the extension works:

### Option A: Using a Test Terraform Configuration

1. Create a test repository in your Azure DevOps project
2. Add a simple Terraform configuration:

**main.tf:**
```hcl
terraform {
  required_version = ">= 1.0"
}

resource "null_resource" "test" {
  triggers = {
    timestamp = timestamp()
  }
}

resource "null_resource" "test2" {
  triggers = {
    always = timestamp()
  }
}
```

**azure-pipelines.yml:**
```yaml
trigger:
  - main

pool:
  vmImage: 'ubuntu-latest'

steps:
- task: TerraformInstaller@0
  displayName: 'Install Terraform'
  inputs:
    terraformVersion: 'latest'

- task: Bash@3
  displayName: 'Terraform Plan'
  inputs:
    targetType: 'inline'
    script: |
      terraform init
      terraform plan -out=tfplan

- task: TerraformPlanViewer@1
  displayName: 'Publish Terraform Plan'
  inputs:
    planPath: '$(System.DefaultWorkingDirectory)/tfplan'
```

### Option B: Using Mock Data

If you don't want to set up Terraform, you can test with mock data:

**azure-pipelines.yml:**
```yaml
trigger:
  - main

pool:
  vmImage: 'ubuntu-latest'

steps:
- task: Bash@3
  displayName: 'Create Mock Terraform Plan JSON'
  inputs:
    targetType: 'inline'
    script: |
      cat > tfplan.json << 'EOF'
      {
        "format_version": "1.2",
        "terraform_version": "1.6.0",
        "resource_changes": [
          {
            "address": "null_resource.test",
            "mode": "managed",
            "type": "null_resource",
            "name": "test",
            "actions": ["create"]
          },
          {
            "address": "null_resource.test2",
            "mode": "managed",
            "type": "null_resource",
            "name": "test2",
            "actions": ["update"]
          },
          {
            "address": "null_resource.old",
            "mode": "managed",
            "type": "null_resource",
            "name": "old",
            "actions": ["delete"]
          }
        ]
      }
      EOF

- task: TerraformPlanViewer@1
  displayName: 'Publish Terraform Plan'
  inputs:
    planPath: '$(System.DefaultWorkingDirectory)/tfplan.json'
```

## Step 8: Run the Pipeline and Verify

1. Create a new pipeline using the YAML above
2. Run the pipeline
3. After the pipeline completes, go to the pipeline run details
4. Look for the **"Terraform Plan"** tab at the top
5. Click on it to see the visual report

### What to Verify

✅ **Task Execution**: The "Generate Terraform Plan Report" task should complete successfully
✅ **Tab Display**: The "Terraform Plan" tab should appear in the pipeline run
✅ **Report Content**: The report should show:
   - Summary cards with counts (Create, Update, Delete, Recreate)
   - Color-coded resource lists
   - Proper formatting and styling

## Troubleshooting

### Task Not Found

If you see "Task 'TerraformPlanViewer' not found":
- Make sure the extension is installed in your organization
- Refresh the pipeline editor
- Try using the full task name with version: `TerraformPlanViewer@1`

### Tab Not Appearing

If the tab doesn't appear:
- Check that the task completed successfully
- Look for the attachment in the pipeline logs: `##vso[task.addattachment ...`
- Verify the plan JSON file was created correctly

### Report Not Loading

If the tab appears but the report doesn't load:
- Open browser developer console (F12) to see JavaScript errors
- Check if the attachment was created properly in the task logs
- Verify the plan JSON file has the correct format

## Step 9: Iterate and Update

When making changes:

1. Update the version in `vss-extension.json`:
   ```json
   {
     "version": "1.0.1",
     ...
   }
   ```

2. Rebuild and package:
   ```bash
   npm run package
   ```

3. Upload the new version:
   - Go to https://marketplace.visualstudio.com/manage
   - Find your extension
   - Click **Update**
   - Upload the new `.vsix` file

4. The extension will automatically update in your organization (may take a few minutes)

## Publishing to Marketplace (When Ready)

Once you've tested thoroughly:

1. Go to https://marketplace.visualstudio.com/manage
2. Find your extension
3. Click **Share/Unshare** → **Make Public**
4. Fill in additional marketplace details (screenshots, documentation, etc.)
5. Submit for review

**Note**: Microsoft reviews public extensions before they appear in the marketplace. This can take 1-3 business days.

## Alternative: Local Testing with tfx-cli

You can also install the extension directly using `tfx-cli`:

```bash
# Install tfx-cli globally (if not already installed)
npm install -g tfx-cli

# Login to your Azure DevOps organization
tfx login

# Install the extension directly
tfx extension install --vsix dist/terraform-tools.terraform-plan-viewer-1.0.0.vsix --service-url https://dev.azure.com/your-org
```

## Resources

- [Azure DevOps Extension Documentation](https://learn.microsoft.com/en-us/azure/devops/extend/)
- [Publishing Extensions](https://learn.microsoft.com/en-us/azure/devops/extend/publish/overview)
- [Extension Manifest Reference](https://learn.microsoft.com/en-us/azure/devops/extend/develop/manifest)
