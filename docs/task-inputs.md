# Task inputs

| Input | Required | Description | Default |
|---|---|---|---|
| `planPath` | Yes | Path to a Terraform plan — binary (`terraform plan -out=…`) or JSON (`terraform show -json`). Binary plans are converted on the agent. | – |
| `attachmentName` | No | Identifier for the attachment; used as the label in the tab's plan selector. | `terraform-plan` |

## `planPath`

Point this at the plan file your pipeline produced. Both forms are accepted:

- **Binary** — `terraform plan -out=tfplan`. The task runs `terraform show -json`
  on the agent to convert it, so the `terraform` CLI must be available.
- **JSON** — `terraform show -json tfplan > tfplan.json`. Pre-converted, so the
  publishing agent doesn't need the `terraform` CLI.

## `attachmentName`

Only relevant when you publish more than one plan per build (see the
[multi-stage example](usage.md#multi-stage-example)). Each distinct
`attachmentName` becomes an entry in the tab's dropdown; alphabetical order
decides which is selected first. With a single plan the selector is hidden.
