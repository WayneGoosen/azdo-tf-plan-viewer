# Task inputs

| Input | Required | Description | Default |
|---|---|---|---|
| `planPath` | Yes | Path to a Terraform plan — binary (`terraform plan -out=…`) or JSON (`terraform show -json`). Binary plans are converted on the agent. | – |
| `attachmentName` | No | Identifier for the attachment; used as the label in the tab's plan selector. | `terraform-plan` |
| `cliTool` | No | CLI used to convert binary plans: `auto`, `terraform`, `tofu`, or a path to a `terraform`/`tofu` binary. Ignored for JSON plans. | `auto` |

## `planPath`

Point this at the plan file your pipeline produced. Both forms are accepted:

- **Binary** — `terraform plan -out=tfplan` (or `tofu plan -out=tfplan`). The
  task runs `show -json` on the agent to convert it, so the CLI must be
  available — see [`cliTool`](#clitool).
- **JSON** — `terraform show -json tfplan > tfplan.json` (or `tofu show -json`).
  Pre-converted, so the publishing agent doesn't need either CLI.

## `attachmentName`

Only relevant when you publish more than one plan per build (see the
[multi-stage example](usage.md#multi-stage-example)). Each distinct
`attachmentName` becomes an entry in the tab's dropdown; alphabetical order
decides which is selected first. With a single plan the selector is hidden.

## `cliTool`

Only used when `planPath` is a binary plan.

- `auto` (default) — uses `terraform` if it is on PATH, otherwise `tofu`.
- `terraform` / `tofu` — use that CLI only. Set `tofu` when both are installed
  but the plan was produced by OpenTofu.
- Any other value must be a path to a `terraform` or `tofu` binary (e.g.
  `/opt/tofu/bin/tofu`). Paths to any other program are rejected, so the task
  never runs an arbitrary executable.

```yaml
- task: TerraformPlanViewer@1
  inputs:
    planPath: '$(System.DefaultWorkingDirectory)/tfplan'
    cliTool: 'tofu'
```
