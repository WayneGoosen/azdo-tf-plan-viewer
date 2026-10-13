# Contributing to Azure DevOps Terraform Plan Viewer

Thank you for considering contributing to this project! This guide will help you get started.

## Development Setup

1. Fork and clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Make your changes
4. Test your changes locally

## Before Submitting a PR

Before submitting a pull request, make sure the following commands pass:

```bash
npm test           # Run unit tests
npm run lint       # Run ESLint
npm run typecheck  # TypeScript type checking for task
npm run typecheck:tab  # TypeScript type checking for tab
npm run build      # Full build (includes packaging)
```

All of these checks run automatically on every PR via GitHub Actions.

## Testing

We use [Vitest](https://vitest.dev/) for unit testing. Tests are located alongside the source files with a `.test.ts` suffix.

To run tests:
```bash
npm test              # Run all tests once
npm run test:watch    # Run tests in watch mode
```

When adding new features or fixing bugs:
- Add unit tests to cover your changes
- Ensure all existing tests still pass
- For bug fixes, consider adding a regression test

## Linting

We use [ESLint](https://eslint.org/) with TypeScript support. Run:
```bash
npm run lint
```

The linter enforces code style and catches common mistakes.

## Local Development

To iterate on the tab UI locally without deploying to Azure DevOps:
```bash
npm run dev
```

This starts a local dev server at `http://localhost:8080` that renders sample plans from `dev-fixtures/`. The dev harness uses the same production rendering code, so what you see locally matches what users will see in Azure DevOps.

Query string options:
- `?slow=15000` — delays loading to test loading states
- `?single=1` — tests single-plan UI (hides dropdown)

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/) for automated versioning:

- `feat:` — minor version bump (new features)
- `fix:` — patch version bump (bug fixes)
- Other prefixes — patch bump by default

You can override the bump with a footer:
- `+semver: skip` — no version change
- `+semver: minor` — force minor
- `+semver: major` — force major

Example:
```
feat: add multi-stage plan selector

Allows publishing multiple plans per build (dev/staging/prod)
and switching between them in a dropdown.

Closes #123
```

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Ensure tests and lint pass
4. Commit with conventional commit messages
5. Push to your fork
6. Open a pull request against `main`

The PR build will:
- Run all tests and linting
- Type-check both task and tab code
- Build and package the extension
- Calculate the next version number
- Post the version calculation as a comment

## Questions?

If you have questions or need help, feel free to:
- Open an issue for discussion
- Ask in your PR

We're here to help!
