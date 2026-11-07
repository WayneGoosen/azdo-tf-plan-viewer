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

## OpenTofu

OpenTofu plans work the same way. With the default `cliTool: 'auto'`, the task
converts binary plans with `terraform` if it's on the agent, otherwise `tofu`.
If both are installed, set `cliTool: 'tofu'` so the plan is read by the CLI
that produced it:

```yaml
- task: Bash@3
  displayName: 'OpenTofu Plan'
  inputs:
    targetType: 'inline'
    script: |
      tofu init
      tofu plan -out=tfplan

- task: TerraformPlanViewer@1
  displayName: 'Publish OpenTofu Plan'
  inputs:
    planPath: '$(System.DefaultWorkingDirectory)/tfplan'
    cliTool: 'tofu'
```

`tofu` must be on the `PATH` of the account running the agent. Passing a JSON
plan (`tofu show -json tfplan > tfplan.json`) needs no CLI at all.

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

Each `attachmentName` becomes a label in the dropdown. With two or more plans
the tab opens on an **All plans** overview — combined Create / Update /
Recreate / Delete counts and every resource change from every plan on one page,
each tagged with the plan it came from. Search matches resource addresses,
types and plan names. Click a plan tag, or pick it in the dropdown, to open the
existing detail view. A single attachment still hides the selector.

When many plans are published and only a few change, set
[`hideNoChangePlans`](task-inputs.md#hidenochangeplans) on the task to keep
plans without changes out of the dropdown. Viewers can toggle this with the
**Hide plans without changes** checkbox beside the dropdown, which appears once
a plan without changes has loaded.

## Agent runtime

The task runs on the agent's **Node.js 24** handler, with **Node.js 20** kept
as a fallback for older agents.

## How it works

The task uploads the plan JSON as a build attachment under the type
`terraform-plan-viewer.plan`. By default it redacts Terraform-marked sensitive
values and keeps only the fields the tab reads (`format_version`,
`terraform_version`, `resource_changes`, `output_changes`). The tab fetches the
attachment via Azure DevOps's Build REST API, parses it client-side, and
renders the diff entirely in the browser. No server, no database, no
third-party endpoint — plan data sits in your Azure DevOps organization the
same way build logs do. See [Privacy & security](security.md) for the full
picture, and [`redactSensitive`](task-inputs.md#redactsensitive) to opt out.
