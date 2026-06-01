# Usage

## Quick start

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

- task: TerraformPlanViewer@1
  displayName: 'Publish Terraform Plan'
  inputs:
    planPath: '$(System.DefaultWorkingDirectory)/tfplan'
```

After the pipeline runs, open the build and click the **Plan Review** tab.

The task accepts either form of plan:

- The **binary plan** from `terraform plan -out=tfplan` — the task converts it
  via `terraform show -json` automatically.
- The **JSON form** from `terraform show -json tfplan > tfplan.json` — useful if
  `terraform` isn't on the publishing agent.

!!! tip "Pinning a version"
    `TerraformPlanViewer@1` tracks the latest 1.x automatically. If your
    security policy requires a complete version number, see
    [Version pinning](version-pinning.md).

## Multi-stage example

Call the task once per stage with distinct `attachmentName` values:

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

Each `attachmentName` becomes a label in the dropdown. Sorted alphabetically,
the first is selected by default.

## How it works

The task uploads the plan JSON as a build attachment under the type
`terraform-plan-viewer.plan`. The tab fetches the attachment via Azure DevOps's
Build REST API, parses it client-side, and renders the diff entirely in the
browser. No server, no database, no third-party endpoint — plan data sits in
your Azure DevOps organization the same way build logs do. See
[Privacy & security](security.md) for the full picture.
