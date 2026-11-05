# Privacy & security

- **No third-party calls.** Plan JSON stays in your Azure DevOps organization.
  Nothing leaves your tenant.
- **Sensitive values are redacted on upload.** By default the task replaces
  every Terraform-marked sensitive leaf (`before_sensitive` /
  `after_sensitive`) with `(sensitive)` and drops unused plan fields
  (`prior_state`, `configuration`, `variables`, …) before attaching. The tab
  also masks remaining sensitive markers in the UI so the underlying value
  never reaches the DOM. Set `redactSensitive: false` to attach the raw plan.
- **DOM-safe rendering.** Plan content goes through `textContent` /
  `createElement`, never as an HTML string — so a malicious resource address
  can't inject script.

## Where plan data lives

The task uploads the plan JSON as a build attachment (type
`terraform-plan-viewer.plan`). Anyone with permission to read the build can
download that attachment, which is why redaction is on by default — the
stored file should not contain Terraform-marked secrets. The tab reads the
attachment back via the Build REST API and renders everything client-side in
the browser. There is no server, database, or external endpoint involved —
the data has the same residency and access controls as your build logs.

## Content Security Policy

The tab runs under a strict Content Security Policy. Plan content is inserted via
`textContent` / `createElement` — never as an HTML string — so even a malicious
resource address or attribute value can't execute script inside the tab.
