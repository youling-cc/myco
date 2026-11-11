## What changed

<!-- One or two sentences. Link the Issue if there is one: Fixes #123 -->

## Why

<!-- The problem this solves. For bug fixes: how you reproduced it. -->

## Tests — RED → GREEN (required for behavior changes)

- [ ] Added/updated tests covering this change
- [ ] **RED**: pasted the failing test output before the fix (required for bug fixes)

```
# paste RED output here, e.g.
#  FAIL  src/foo.test.ts > opens browser on macOS
#  AssertionError: expected 'open' to be 'xdg-open'
```

- [ ] **GREEN**: all four suites pass locally
  - [ ] `cd apps/phone && npx vitest run`
  - [ ] `pnpm --dir apps/home/ui exec vitest run`
  - [ ] `cd apps/home/src-tauri && cargo test --workspace`
  - [ ] `cd services/identity-svc && node --test`
- [ ] Exemption stated if this PR touches no behavior (docs/comments/CI only)

## Checklist

- [ ] Every commit has `Signed-off-by` (DCO): `git commit -s`
- [ ] One feature/fix per PR
- [ ] No secrets, tokens, or real network addresses in the diff

---
<!-- Maintainer note: on merge, business-logic changes are backported to the
     internal repo; sanitization transforms from this repo are NOT backported. -->
