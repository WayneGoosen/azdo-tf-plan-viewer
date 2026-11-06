# Task inputs

| Input | Required | Description | Default |
|---|---|---|---|
| `planPath` | Yes | Path to a Terraform plan — binary (`terraform plan -out=…`) or JSON (`terraform show -json`). Binary plans are converted on the agent. | – |
| `attachmentName` | No | Identifier for the attachment; used as the label in the tab's plan selector. | `terraform-plan` |
| `cliTool` | No | CLI used to convert binary plans: `auto`, `terraform`, or `tofu`. Ignored for JSON plans. | `auto` |
| `redactSensitive` | No | Replace Terraform-marked sensitive leaves with `(sensitive)` and drop unused plan fields before attaching. | `true` |
| `hideNoChangePlans` | No | Leave this plan out of the tab's plan dropdown when it has no changes. | `false` |

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
`attachmentName` becomes an entry in the tab's dropdown. With two or more
plans the tab defaults to an **All plans** overview; pick a name to open that
plan's detail. With a single plan the selector is hidden. To keep plans without
changes out of the dropdown, see [`hideNoChangePlans`](#hidenochangeplans).

## `cliTool`

Only used when `planPath` is a binary plan.

- `auto` (default) — uses `terraform` if it is on PATH, otherwise `tofu`.
- `terraform` / `tofu` — use that CLI only. Set `tofu` when both are installed
  but the plan was produced by OpenTofu.

The CLI is always looked up on the `PATH` of the account running the agent;
`cliTool` doesn't accept a file path, and any other value fails the task. If
the CLI is installed somewhere else, add its directory to `PATH` in an earlier
step:

```yaml
- script: echo "##vso[task.prependpath]/opt/tofu/bin"
```

```yaml
- task: TerraformPlanViewer@1
  inputs:
    planPath: '$(System.DefaultWorkingDirectory)/tfplan'
    cliTool: 'tofu'
```

## `redactSensitive`

On by default. After the plan is available as JSON, the task:

1. **Redacts** every leaf Terraform marked in `before_sensitive` / `after_sensitive`, replacing it with `(sensitive)` — the same placeholder the Plan Review tab displays.
2. **Drops unused fields** the tab never reads (`prior_state`, `configuration`, `variables`, `planned_values`, `resource_drift`, and so on), keeping `format_version`, `terraform_version`, `resource_changes`, and `output_changes`.

The attachment type stays `terraform-plan-viewer.plan`. Set `false` only if you need the full unredacted plan JSON on the build (anyone with build read access can download it):

```yaml
- task: TerraformPlanViewer@1
  inputs:
    planPath: '$(System.DefaultWorkingDirectory)/tfplan'
    redactSensitive: false
```

## `hideNoChangePlans`

Off by default. Useful when one build publishes many plans (for example a
Terragrunt loop) and only a few of them change. When set on the publishing
step, the tab leaves plans with no resource or output changes out of its plan
dropdown:

```yaml
- task: TerraformPlanViewer@1
  inputs:
    planPath: '$(System.DefaultWorkingDirectory)/tfplan'
    attachmentName: '${{ deployment.name }}'
    hideNoChangePlans: true
```

- The tab's **Hide plans without changes** checkbox, next to the dropdown,
  appears once a plan without changes has loaded (it isn't shown when every
  plan has changes). It starts checked when any published plan set this input. Viewers can untick it
  to list every plan; their choice lasts for that visit.
- A plan is only hidden once it has loaded and is known to have no changes.
  Plans still loading, or that failed to load, stay listed.
- The plan currently open always stays in the dropdown.
- The **All plans** view is unaffected: plans without changes contribute no
  resource rows there anyway.
- The setting travels inside the attached plan JSON as a top-level
  `terraform_plan_viewer` key. Anything else that reads the attachment can
  ignore it.

