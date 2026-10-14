# Security Policy

## Reporting a vulnerability

**Use [GitHub private vulnerability reporting](https://github.com/WayneGoosen/azdo-tf-plan-viewer/security/advisories/new)** — do not open a public issue.

Go to the **Security** tab → **Report a vulnerability** to submit your report privately. We'll acknowledge it within 5 business days and provide best-effort fixes as time allows. This is a volunteer-maintained project, so response times may vary.

## What to include

- Extension/task version (from the Marketplace listing or `vss-extension.json`)
- Azure DevOps Services or Server (include Server version if applicable)
- Steps to reproduce
- Impact (what an attacker could do or what data could be exposed)

**Redact secrets from any plan snippets** — if you're sharing Terraform output, strip access keys, connection strings, or anything marked `sensitive`.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅ Latest minor/patch only |
| < 1.0   | ❌ |

Only the latest 1.x release receives security fixes. Older minor/patch versions are not backported.

## Data handling

For details on how the extension handles plan data (no third-party calls, sensitive value masking, DOM-safe rendering), see [docs/security.md](docs/security.md).
