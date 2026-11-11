# Contributing to myco

Thank you for your interest in contributing!

## Current phase: Private beta

The repository is **private** while it goes through an early test round, so the
standard Fork→PR flow below does not apply yet. Use one of these instead:

| Your access | How to contribute |
|---|---|
| **write** (invited collaborator) | Push a feature branch → open a PR against `main`. CI runs automatically. |
| **read** (invited viewer) | You cannot push branches. Send a patch (`git diff` / `git format-patch`) in an Issue or to the maintainers — we'll apply it with your authorship and DCO sign-off preserved. |

Once the repo goes public, the standard Fork→PR flow below takes over.

## Getting Started (public phase)

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YourName/myco.git`
3. Create a branch: `git checkout -b feat/your-feature`
4. Make changes and test
5. Push and create a Pull Request

## DCO (Developer Certificate of Origin)

We use DCO instead of CLA. Every commit must include a `Signed-off-by` line:

```bash
git commit -s -m "feat: add X"
```

This produces:

```
feat: add X

Signed-off-by: Your Name <you@example.com>
```

The sign-off certifies that you wrote the code or otherwise have
the right to submit it under the project's open-source license.

## Code Style

- **Rust**: Follow standard `rustfmt` formatting. Run `cargo fmt` before committing.
- **TypeScript/React**: Follow existing code patterns. Run `npx tsc --noEmit` to check.
- **Java (Android)**: Follow existing patterns in `android-shell/`.

## Testing — RED → GREEN is required

Every change that touches behavior **must come with tests**. Bug fixes follow
the RED → GREEN cycle:

1. **RED** — write a test that reproduces the bug and *watch it fail* on the
   current code. Paste the failing output in the PR description.
2. **GREEN** — apply the fix and the same test now passes.
3. **Refactor** (optional) — clean up while keeping the test green.

A bug fix PR without a reproducing test (or RED evidence) will not be merged.
Pure documentation / comment / CI-config PRs are exempt — state the exemption
explicitly in the PR description.

Where tests live:

| Change area | Test location | Runner |
|---|---|---|
| Phone UI (`apps/phone/src`) | co-located `*.test.ts` | `npx vitest run` |
| Home UI (`apps/home/ui/src`) | co-located `*.test.ts(x)` | `pnpm --dir apps/home/ui exec vitest run` |
| Rust core (`apps/home/src-tauri/src`, `apps/vnet/src`, `core/*`) | `#[cfg(test)]` in-file | `cargo test --workspace` |
| Identity service (`services/identity-svc`) | co-located `*.test.mjs` | `node --test` |

```bash
# run the suites locally before pushing
cd apps/phone && npx vitest run
cd apps/home/src-tauri && cargo test --workspace
cd services/identity-svc && node --test
```

## Pull Request Process

1. **Include tests per the RED → GREEN rule above** (bug fixes: paste RED output)
2. Ensure all CI checks pass (four suites run automatically)
3. Update documentation if needed
4. Keep PRs focused — one feature/fix per PR
5. Add `Signed-off-by` to every commit (DCO)

## Reporting Issues

Use [GitHub Issues](https://github.com/youling-cc/myco/issues). Include:
- Platform (Windows/Android/Linux)
- Version
- Steps to reproduce
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed
under the Apache License 2.0.
