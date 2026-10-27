# Contributing to Thalamus Desktop

Thanks for your interest in contributing. The project is in early beta, so
the ground rules are still simple:

## How to help right now

1. **Bug reports** — open an issue using the *Bug report* template. Include
   the error code shown in the app (e.g. `429`, `401`), the Thalamus
   version, and your Windows version.
2. **Feature ideas** — open an issue using the *Feature request* template,
   or start a Discussion. Ideas that reduce tokens or cost are especially
   welcome.
3. **Code** — before investing time in a pull request, open an issue first
   describing what you intend to change. The codebase moves quickly during
   beta and we want to avoid wasted work on your side.

## Ground rules for pull requests

- Keep PRs small and focused; one concern per PR.
- Run the checks before opening a PR:

  ```bash
  npm run lint            # oxlint
  npm run build           # tsc + vite build
  npm test                # vitest (pure functions)
  npm run i18n:check      # TR/EN key parity
  npm run license:check   # dependency licence gate
  cd src-tauri
  cargo check --all-targets
  cargo test --lib
  ```

- Follow the existing style of the file you are touching. Comments in the
  codebase are a mix of Turkish and English; either is fine — clarity
  matters more.
- Product principle: compression features must be **lossless** (round-trip
  verified). Proposals that trade fidelity for savings belong behind an
  explicit opt-in, never a default.
- Read [docs/security-model.md](docs/security-model.md) before touching the
  backend's auth, CORS, host guard, `safe_join`, SSRF guard, or the credential
  vault — those layers must not be weakened, only strengthened.

## Licensing

By submitting a contribution, you agree that it will be licensed under the
Apache License 2.0, like the rest of this repository.
