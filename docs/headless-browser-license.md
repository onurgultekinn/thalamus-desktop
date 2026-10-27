# Headless browser licence note (Lightpanda / Obscura)

Status: **research note, no code change**. Lightpanda is not referenced in this
repository; it is used by the separate `arastir` component. This note records
the licence facts and options so the decision can be made with evidence.

## The issue

`arastir`'s page-reading fallback ("browser" stage in the fallback chain) has
used Lightpanda. Lightpanda is licensed **AGPL-3.0**, which is a strong copyleft
licence with a network-use clause (section 13):

- If a modified version is offered to users over a network, its source must be
  offered to those users.
- Distributing a binary that links/combines with AGPL code generally requires the
  combined work to be AGPL as well.

For a proprietary or Apache-2.0 product that ships a bundled binary, this is a
licensing conflict unless the vendor grants a separate commercial licence.
Lightpanda's public licence file is plain AGPL-3.0 with **no** commercial or
linking exception (verified against the repository's `LICENSE`). Commercial
terms, if any, are handled privately by the vendor (they direct licensing
enquiries to a sales address) — that must be negotiated, not assumed.

Facts verified on 2026-10-27 via the GitHub API:

| Project | Licence | Language | Stars | Latest release |
|---|---|---|---|---|
| `lightpanda-io/browser` | AGPL-3.0 | Zig | 37,044 | active (pushed 2026-10-27) |
| `h4ckf0r0day/obscura` | Apache-2.0 | Rust | 29,483 | v0.2.5 (2026-10-17) |

## Options

### Option A — Obscura (Apache-2.0, Rust)

`h4ckf0r0day/obscura` describes itself as a headless browser for AI agents and
web scraping, written in Rust, executing JavaScript via V8 and exposing the
Chrome DevTools Protocol (CDP), so Puppeteer/Playwright-style clients can drive
it.

**Pros**

- Apache-2.0: compatible with this project's licence, no copyleft obligations
  for the combined work, commercial use permitted by the licence text.
- Rust, so it fits the existing toolchain and can be a single process instead of
  a foreign runtime.
- CDP compatibility means the client side does not have to be rewritten if the
  existing code already speaks CDP.
- Active, recent releases.

**Cons / risks**

- Young project (first commit April 2026, current line 0.2.x). API and behaviour
  may change; pin an exact version.
- Its own README states rendering can differ from Chromium on long-tail CSS,
  some Web APIs, media playback, compositor effects, and font rasterisation.
  For "read a page as text" this is usually acceptable; for pixel-perfect
  rendering it is not.
- Defaults to blocking private/internal network access (good — aligns with the
  SSRF guard), but this must be verified in practice.
- Apache-2.0 still requires keeping the licence and NOTICE. Since this project
  generates `ATTRIBUTIONS.md`, the dependency would have to be reflected there
  by the existing script, not by hand.

### Option B — Keep a full Chromium via Playwright/Puppeteer

Playwright is Apache-2.0 and downloads Chromium (Chrome for Testing) binaries.
This is the most compatible rendering path.

**Pros:** best fidelity, mature, well-documented.
**Cons:** large download/install size (hundreds of MB), a second browser stack
to keep patched, and a bigger footprint than a purpose-built scraper.

### Option C — Negotiate a Lightpanda commercial licence

**Pros:** keeps the current integration; Lightpanda is the fastest of these for
its intended workload.
**Cons:** commercial cost, private terms, and an ongoing dependency on a vendor
agreement; the AGPL obligations apply until that agreement is in place.

### Option D — No headless browser

Keep `read_page` on the plain-HTML fetch path only (already the first stage) and
degrade gracefully on JavaScript-heavy pages, with a clear message to the user.

**Pros:** zero new licensing surface, smallest footprint.
**Cons:** some pages will not be readable.

## Recommendation

1. **Do not ship an AGPL binary** in a distributed build without either a
   commercial licence or accepting AGPL for the combined work. The current
   situation is a licensing risk for a public beta.
2. **Evaluate Obscura (Option A) first.** It is the closest fit: permissive
   licence, Rust, CDP-compatible. Pin the exact version and add it to
   `ATTRIBUTIONS.md` through the generator.
3. Keep a Chromium/Playwright path as the fidelity fallback if a page is not
   readable through Obscura.
4. Whatever is chosen, treat the browser as an **optional** component: the
   tool's documented behaviour is that missing helpers degrade with an explicit
   error, and that must hold for the browser stage too.

## What still must be checked before adopting Obscura

- Whether it builds cleanly on Windows x64 (the only supported target here) and
  what its binary size is.
- Whether the CDP subset it implements covers what the current client uses.
- Its own third-party dependency licences (V8 and friends) — run the same
  licence gate used for npm/cargo.
- A security review of its sandbox and SSRF defaults.

**Not legal advice.** A licence question with revenue implications should be
confirmed by the project owner and, where needed, a lawyer.
