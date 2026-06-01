# Releasing the Extension

This document covers the CI/CD pipeline architecture, one-time setup, and day-to-day release flow.

## Pipeline architecture

Three workflows in `.github/workflows/`:

| Workflow | Trigger | What it does |
|---|---|---|
| `pr.yml` | Pull request to `main` | Build, typecheck, package, verify marketplace assets, upload `.vsix` artifact, comment the GitVersion-calculated version on the PR. **No publishing.** |
| `main.yml` | Push to `main` (or manual `workflow_dispatch`) | Same build pipeline + stamp the GitVersion-calculated version into `vss-extension.json`, package, attach `.vsix` to a new GitHub Release tagged `v<version>`. **No marketplace publish.** |
| `marketplace-publish.yml` | Manual `workflow_dispatch` only — takes a release tag as input | Download the `.vsix` from that GitHub Release and publish it to the Azure DevOps Marketplace via `tfx extension publish`. |

**Why three workflows, not one?** Splitting the marketplace publish into a manual gate means every main commit gets a tested, packaged artifact (zero marketplace risk), and you press the button when you're confident the release is ready. Once you've stabilised post-1.0, you can collapse `marketplace-publish.yml` into `main.yml` for fully continuous deployment.

---

## One-time setup

### 1. Create the Azure DevOps Publisher PAT

The marketplace-publish workflow needs a Personal Access Token with permission to publish to your publisher account.

1. Sign in to Azure DevOps at https://dev.azure.com.
2. Click your avatar (top right) → **Personal access tokens** → **+ New Token**.
   - Direct link: https://dev.azure.com/_usersSettings/tokens
3. Configure the token:
   - **Name**: `azdo-tf-plan-viewer marketplace publish`
   - **Organization**: `All accessible organizations` (the marketplace API is org-agnostic).
   - **Expiration**: 1 year (rotate annually) or your org's policy max.
   - **Scopes**: click **Show all scopes**, scroll to **Marketplace**, check **Manage**.
     - This is the only scope needed. Don't grant anything else.
4. Click **Create**. **Copy the token immediately** — Azure DevOps shows it only once.

### 2. Add the PAT as a GitHub repository secret

1. Go to the repo on GitHub → **Settings** → **Secrets and variables** → **Actions**.
   - Direct link pattern: `https://github.com/WayneGoosen/azdo-tf-plan-viewer/settings/secrets/actions`
2. Click **New repository secret**.
   - **Name**: `ADO_PUBLISHER_PAT` (must match exactly — `marketplace-publish.yml` reads `secrets.ADO_PUBLISHER_PAT`).
   - **Secret**: paste the PAT from step 1.
3. Click **Add secret**.

### 3. Anchor GitVersion's commit count

GitVersion counts commits since the most recent reachable tag. Without an anchor tag it counts from repo init, which produces surprisingly high numbers on the first auto-published version.

After CI is wired up (this branch landed on `main`), tag `main` HEAD with the last manually published version:

```bash
git checkout main
git pull
git tag v0.0.13
git push --tags
```

(Adjust `v0.0.13` to whatever version is currently live on the marketplace when you're reading this.)

After that, every subsequent commit on main increments cleanly: `v0.0.13` → `v0.0.14` → `v0.0.15` → ...

### 4. First marketplace upload (manual)

The `marketplace-publish.yml` workflow can only **update** an existing extension entry. For the very first publish you need to upload manually so the publisher + extension records get created in the marketplace.

1. Trigger `main.yml` once (push any commit to main, or run it via `workflow_dispatch`). Wait for it to complete.
2. On the GitHub Releases page, find the release it created (e.g. `v0.0.14`) and download the `.vsix`.
3. Go to https://marketplace.visualstudio.com/manage.
4. Click **+ New extension** → **Azure DevOps**, drag the `.vsix` in.
5. Mark it **Private** for the first upload so you can verify before going public.
6. Share it with your test organization, install, smoke-test.
7. When happy, return to the manage page → **Make Public**.

After this first manual upload, `marketplace-publish.yml` will work for all future updates.

---

## Day-to-day flow

### Releasing a new version

```
1. Open PR with your change.
2. PR workflow runs → comments calculated version on the PR.
3. Verify the version is reasonable.
4. Merge.
5. Main workflow runs → creates GitHub Release with .vsix attached.
6. (Optional) Run `Publish to Marketplace` workflow against the new release tag.
```

### Triggering a marketplace publish

1. Go to **Actions** → **Publish to Marketplace** → **Run workflow**.
2. Enter the release tag (e.g. `v0.0.14`).
3. Click **Run workflow**.
4. Watch the run; it'll pull the `.vsix` from the GitHub Release and call `tfx extension publish`.

### Choosing the bump

The primary signal is the **Conventional Commits** prefix on the commit subject:

| Prefix | Bump |
|---|---|
| `feat:` (or `feat(scope):`) | minor |
| `fix:` (or `fix(scope):`) | patch |
| anything else | patch (default) |

For overrides, a `+semver:` footer in the commit body wins over the prefix:

```
+semver: skip   ← no version change (chore/docs/CI)
+semver: minor  ← feature
+semver: major  ← breaking change (DON'T USE while pre-release)
```

See `CLAUDE.md` → **Versioning** for the full policy.

---

## Troubleshooting

### `Marketplace publish` fails with `401 Unauthorized`

The PAT is missing, expired, or doesn't have **Marketplace: Manage** scope. Recreate the PAT (step 1 above) and update the `ADO_PUBLISHER_PAT` secret.

### `Marketplace publish` fails with `extension already exists with this version`

The marketplace rejects re-uploads of the same version. This usually means GitVersion produced a duplicate — check that the GitHub Release tag matches the version inside `vss-extension.json` in the `.vsix`. If you hit this, either bump intentionally (push a no-op commit with `+semver: patch`) or delete the conflicting marketplace version through the manage UI.

### PR workflow says version is `0.0.64` (or some weirdly high number)

GitVersion has no tag anchor on main and is counting all commits since repo init. Fix: tag main HEAD with the last published version (step 3 above) and push the tag. Re-run the PR workflow.

### Manifest-verification step fails: `Missing Content.Details asset`

Something put the marketplace asset directory back into `vss-extension.json` `files[]`. See `CLAUDE.md` → **Extension Manifest** for the gotcha. Remove the `marketplace` entry from `files[]`.

### `tfx-cli` warns about deprecated dependencies during install

Cosmetic warnings from `tfx-cli`'s own transitive deps. Ignore unless `tfx extension publish` itself fails.

---

## What's not automated (yet)

- **Task version** (`buildAndReleaseTask/task.json:version`) is now auto-stamped by `main.yml` from the same GitVersion `majorMinorPatch` as `vss-extension.json`, so the extension and task versions are always identical — no manual bump. The committed values in both files are placeholders the release overwrites.
- **Major bumps are breaking and still need a manual sweep.** A `+semver: major` footer moves both versions to the next major, which means every `TerraformPlanViewer@N` reference across `README.md`, `marketplace/overview.md`, and `TESTING.md` must be bumped to `@N+1`, and existing user pipelines break until they update. The example full-pin version quoted in the **Version pinning** sections (`@1.3.0`) should track the current major; refresh it when you bump major.
- **CHANGELOG.md** — not generated. Could layer `git-cliff` / `auto-changelog` on top later.
- **Pre-release / RC tags** — marketplace doesn't render SemVer pre-release suffixes nicely; we stay on plain `M.m.p` for now.
