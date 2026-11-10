# Contributing to myco

Thank you for your interest in contributing!

## Getting Started

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

## Testing

```bash
# Phone UI tests
cd apps/phone && npx vitest run

# Rust tests
cd apps/home/src-tauri && cargo test

# Identity service tests
cd services/identity-svc && node --test
```

## Pull Request Process

1. Ensure tests pass
2. Update documentation if needed
3. Keep PRs focused — one feature/fix per PR
4. Add `Signed-off-by` to every commit

## Reporting Issues

Use [GitHub Issues](https://github.com/youling-cc/myco/issues). Include:
- Platform (Windows/Android/Linux)
- Version
- Steps to reproduce
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed
under the Apache License 2.0.
