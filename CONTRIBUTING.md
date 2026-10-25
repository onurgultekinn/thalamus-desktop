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
- Rust code must pass `cargo check` / existing tests; frontend must pass
  `npm run build`.
- Follow the existing style of the file you are touching. Comments in the
  codebase are a mix of Turkish and English; either is fine — clarity
  matters more.
- Product principle: compression features must be **lossless** (round-trip
  verified). Proposals that trade fidelity for savings belong behind an
  explicit opt-in, never a default.

## Licensing

By submitting a contribution, you agree that it will be licensed under the
Apache License 2.0, like the rest of this repository.
