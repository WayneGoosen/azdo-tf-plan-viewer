# Version pinning

`TerraformPlanViewer@1` references the **major** version and automatically picks
up the latest minor/patch within major 1 — the recommended form for most
pipelines, since you get bug fixes without editing YAML.

Azure DevOps also accepts a **complete** version, which some supply-chain and
SAST policies (e.g. SonarCloud's *"Use complete version number"* hotspot)
require:

```yaml
- task: TerraformPlanViewer@1.3.0   # full pin = the version on the Marketplace listing
```

The task version matches the extension version shown on the
[Marketplace listing](https://marketplace.visualstudio.com/items?itemName=WayneGoosen.terraform-plan-viewer)
and in [GitHub Releases](https://github.com/WayneGoosen/azdo-tf-plan-viewer/releases) —
they're stamped from one source, so the listing number *is* the number you pin.

!!! warning "Before pinning the full version"
    - The exact version must be **installed in your organization**. The
      extension ships one build per major, so only the latest minor/patch is
      present. Pinning an older build such as `@1.0.0` resolves to nothing and
      the pipeline fails with *"task not found"* — use the current version from
      the listing.
    - A full pin is **not auto-updating**: when a new version publishes you must
      bump the pin yourself, otherwise you stay on the old build.

## Which should I use?

| | `@1` (major) | `@1.3.0` (full) |
|---|---|---|
| Gets patches automatically | ✅ | ❌ (manual bump) |
| Satisfies "complete version" SAST rules | ❌ | ✅ |
| Reproducible across runs | ⚠️ tracks latest 1.x | ✅ exact build |

Use `@1` unless a policy forces the complete number; then pin `@1.3.0` and bump
it when you adopt a new release.
