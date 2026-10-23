# Contributing to Terraform Plan Viewer

Thank you for your interest in contributing! This guide will help you set up your development environment, test changes locally, and submit a pull request.

## Prerequisites

- **Node.js** version 20.9 or higher (check with `node --version`)
  - Use the version specified in `.nvmrc`: `20`
  - If you use [nvm](https://github.com/nvm-sh/nvm), run `nvm use` in the project root
- **npm** (comes with Node.js)
- **tfx-cli** (Azure DevOps extension packaging tool)
  - Install globally: `npm install -g tfx-cli`

## Getting Started

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/WayneGoosen/azdo-tf-plan-viewer.git
cd azdo-tf-plan-viewer

# Install root dependencies
npm ci

# Install task dependencies
cd buildAndReleaseTask && npm ci && cd ..
```

> **Note**: Use `npm ci` instead of `npm install` for reproducible builds matching lockfile versions.

### 2. Build the Extension

```bash
npm run build
```

This command:
- Cleans previous builds
- Compiles TypeScript for the task (`npm run build:task`)
- Bundles the tab UI with webpack (`npm run build:tab`)
- Copies static assets (JSON, HTML, CSS, PNG)
- Installs production dependencies in `dist/buildAndReleaseTask/`

### 3. Run Type Checks

```bash
npm run typecheck       # Check task code
npm run typecheck:tab   # Check tab code
```

## Local Development

### Dev Harness

Test the tab UI locally without packaging the extension:

```bash
npm run dev
```

This command:
1. Builds the tab UI
2. Copies assets and fixtures to `.dev/`
3. Serves the content on **http://localhost:8080**
4. Automatically opens `/dev.html` in your browser

The dev harness loads sample Terraform plans from `dev-fixtures/` so you can iterate on the UI quickly.

## Testing in Azure DevOps

To test the full extension (task + tab) in a real Azure DevOps organization, follow the steps in [TESTING.md](./TESTING.md).

### Using a Dev Publisher (Recommended)

Instead of editing `vss-extension.json` directly (which risks committing your publisher ID), use the dev override file:

1. **Copy the template**:
   ```bash
   cp vss-extension.dev.json vss-extension.dev.local.json
   ```

2. **Edit `vss-extension.dev.local.json`** with your dev publisher:
   ```json
   {
     "publisher": "your-dev-publisher",
     "id": "terraform-plan-viewer-dev",
     "name": "Terraform Plan Viewer (Dev)",
     "public": false
   }
   ```

3. **Package with overrides**:
   ```bash
   npm run build
   tfx extension create --manifest-globs vss-extension.json --overrides-file vss-extension.dev.local.json --output-path dist/
   ```

4. **Upload the `.vsix`** to your dev publisher at https://marketplace.visualstudio.com/manage

> **Note**: `vss-extension.dev.local.json` is gitignored, so you won't accidentally commit your dev publisher.

See [TESTING.md](./TESTING.md) for complete instructions on installing and testing the extension in your Azure DevOps organization.

## Commit Style

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

- **`feat:`** — A new feature (triggers minor version bump)
- **`fix:`** — A bug fix (triggers patch version bump)
- **`docs:`** — Documentation changes
- **`chore:`** — Maintenance tasks (dependencies, tooling)
- **`refactor:`** — Code changes that neither fix bugs nor add features
- **`test:`** — Adding or updating tests
- **`ci:`** — CI/CD configuration changes

### Examples

```
feat: add support for Terraform 1.7 plan format
fix: handle empty resource_changes array
docs: update CONTRIBUTING.md with dev workflow
chore(deps): bump azure-devops-extension-sdk to 4.3.0
```

### Version Overrides

GitVersion automatically calculates the next version based on commit messages. You can override with a footer in the commit body:

- `+semver: skip` — no version change
- `+semver: minor` — force minor bump
- `+semver: major` — force major bump (use sparingly)

## Pull Request Workflow

1. **Fork and branch** from `main`:
   ```bash
   git checkout -b my-feature-branch
   ```

2. **Make your changes**, commit following Conventional Commits

3. **Push to your fork**:
   ```bash
   git push -u origin my-feature-branch
   ```

4. **Open a Pull Request** against `main`

### CI Checks

When you open a PR, the [`pr.yml` workflow](./.github/workflows/pr.yml) runs automatically:

- ✅ **Typecheck** — `npm run typecheck` and `npm run typecheck:tab`
- ✅ **Build** — `npm run package` produces a `.vsix`
- ✅ **Marketplace assets verification** — ensures Content.Details, Screenshots, and Icons are bundled correctly
- ✅ **GitVersion** — calculates the next semantic version based on commits
- ✅ **SonarCloud** (optional) — static analysis if configured

A bot will comment on your PR with the calculated version (e.g., `1.4.0-my-feature-branch.1`).

All checks must pass before merging.

## Project Structure

```
azdo-tf-plan-viewer/
├── buildAndReleaseTask/     # Azure Pipelines task (Node.js)
│   ├── task.json            # Task manifest
│   └── index.ts             # Task entry point
├── tab/                     # Build results tab (browser UI)
│   ├── tab.html
│   ├── tab.ts               # Tab entry point
│   └── ...
├── dev-fixtures/            # Sample plans for local dev
├── dist/                    # Build output (gitignored)
├── vss-extension.json       # Main extension manifest
├── vss-extension.dev.json   # Dev override template (copy to *.local.json)
├── package.json             # Root build scripts
└── TESTING.md               # Full Azure DevOps testing guide
```

## Questions?

- **Bug reports and feature requests**: [GitHub Issues](https://github.com/WayneGoosen/azdo-tf-plan-viewer/issues)
- **Discussions**: [GitHub Discussions](https://github.com/WayneGoosen/azdo-tf-plan-viewer/discussions) (if enabled)

Thank you for contributing! 🚀
