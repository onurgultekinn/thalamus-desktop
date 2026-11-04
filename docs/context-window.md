# Context window: measurements and design

This document records what was measured while attacking the "context window
fills up" problem, what worked, and what did **not** work. Every number here
came from a runnable example in `src-tauri/examples/`. Nothing is estimated.

## The problem

Two separate failures happen in a long agent session, and they need different
fixes:

1. **The window fills.** Applications either drop old turns or summarise them.
   Both lose information permanently. The user is told to start a new session,
   and the agent forgets everything.
2. **The model degrades as the window fills.** This is "context rot":
   attention dilutes and facts in the *middle* of a long prompt are lost. The
   2026 RULER / NoLiMa measurements put multi-fact recall at roughly **60%** —
   about **40% of facts disappear**. A larger window does not fix this; it only
   gives you more middle where things can get lost.

So "just use a bigger window" is not a solution to either problem.

## What we measure with

| Example | What it answers |
|---|---|
| `examples/pyramid_probe.rs` | How much does lossless compression actually save, and on what shape of data? |
| `examples/tok_probe.rs` | Does savings depend on the tokenizer? |
| `examples/context_soak.rs` | Over 200 turns, can old information still be reached, and at what context cost? |
| `examples/readable_test.rs` | **Superseded** — see Result 4 for why its verdict was wrong. |
| `examples/presentation_test.rs` | Which presentation lets a small model use the context (needle in tool output, length-matched control). |
| `examples/continuity_test.rs` | Does compression alone make a 60-turn session fit? |
| `examples/map_navigation_test.rs` | Can the model navigate a context map by itself? (negative result) |
| `examples/deterministic_test.rs` | Is keyword matching enough to pick the right item? (negative result) |
| `examples/e2e_context_live.rs` | Does the whole chain work end-to-end against a real model? |

All examples use synthetic, deterministic data (seeded LCG). No private data.

## Result 1 — the unit of compression matters more than the algorithm

`pyramid_probe`, 100-turn synthetic agent session:

| Strategy | Bytes | Saving |
|---|---:|---:|
| Raw | 1,312,655 | — |
| A — each turn compressed separately (today) | 1,311,854 | **0.1%** |
| B — all turns in one array | 1,301,802 | 0.8% |
| C — dedup (same file re-read) | 609,314 | **53.6%** |
| D — dedup + merged | 599,652 | **54.3%** |

The important measurement is a control case at the same data:

| Record shape | Saving |
|---|---:|
| Bare payload `[{"id":..,"file":..}, …]` | **85.7%** |
| Wrapped message `{"role":"tool","content":[…]}` | **0.4%** |

**Conclusion:** the compressor's win comes from cross-row repetition
(constant columns, dictionaries, prefixes). Inside a message wrapper the top
level has two keys with heterogeneous values, so none of that fires.

Merging five turns and recompressing adds almost nothing (80% → 86%). So a
"compress five, then compress those five" pyramid does **not** pay for itself.

**The real fix is separating the envelope from the payload:** the envelope
becomes a thin index row, the heavy payload is stored bare and compressed.

## Result 2 — savings do not depend on the tokenizer

`tok_probe`, same 100-record JSON payload:

| Tokenizer | Raw tokens | Compressed | Saving | Round-trip |
|---|---:|---:|---:|---|
| cl100k (GPT-4/3.5) | 2,203 | 886 | **59.8%** | lossless |
| o200k (GPT-4o) | 2,203 | 886 | **59.8%** | lossless |
| p50k (GPT-3/codex) | 2,466 | 918 | **62.8%** | lossless |
| r50k (GPT-2) | 2,466 | 918 | **62.8%** | lossless |

Verification is at the **JSON value level**, not the byte level of a token
stream, so the result is tokenizer-independent. Every candidate is decompressed
and compared before it is used; a candidate that does not reproduce the
original is dropped and the raw text is kept.

## Result 3 — storage is lossless, always

`context_soak`, 200-turn session, 40 random probes into old turns:

| Condition | Old info reachable | Context sent | Verified |
|---|---|---|---|
| Today (sliding window) | **1/40 (2%)** | 51,548 B | — |
| Big window (send everything) | 40/40 (100%) | 1,285,250 B | — |
| **Store + map + recall** | **40/40 (100%)** | **6,036 B** | lossless |

Same access, **1/213 of the context**. Store stats for that run: 600 map rows,
407 stored artefacts after dedup, **69.6% compression**, **0 unverified**.

The map stays bounded while the store grows without limit: at 600 items the map
was 912 tokens, the oldest 507 items were "collapsed" in the map but their ids
were kept, and `recall(id)` still resolved every one of them.

## Result 4 — presentation decides whether a model can use the context

> **Correction (2026-10-31).** The first version of this result claimed
> "compressed `@T` tables fit the window but the model cannot read them" (0/20).
> That claim was wrong and is withdrawn. Two flaws invalidated it:
>
> 1. **Length and format were mixed.** B was 27,420 tokens against C's 6,640 —
>    four times larger. A score difference could not be attributed to format
>    while length varied freely.
> 2. **The needle was in a user message.** The secret code was planted in a
>    *user* turn, and compaction never touches user messages. So 0/20 → 20/20
>    showed that searching a short context is easier — not that summaries
>    preserved tool output.

### The corrected measurement

`presentation_test.rs`, 40 turns, 11 probes, `qwen2.5-coder:7b`, temperature 0,
`num_ctx=32768` verified through `/api/ps` before the run started.

The needle (`KEY-nnnn-nnnn`) sits in a `note` field **inside one tool output**,
on one row of one turn. User and assistant text never contain it. Every probe
names the turn it asks about (a concrete handle — see Result 6).

| Condition | Tokens | Correct | `prompt_tokens` |
|---|---:|---:|---:|
| A — raw JSON | 33,260 | **4/11** | 16,386 |
| B — `@T` full | 20,740 | **11/11** | 27,314 |
| C — readable sentences | 4,300 | **11/11** | 5,051 |
| D — `@T` truncated to C's budget | 5,696 | **11/11** | 7,577 |

**What this says:**

- **`@T` is perfectly readable.** D and C both score 11/11 at essentially the
  same length. The earlier "unreadable" verdict was a length artifact.
- **Raw history is the one that fails**, and it fails for the boring reason: A
  exceeds the loaded window, the server truncates it to half the window
  (16,386 = 32768/2), and the information is gone. This is the same silent
  truncation as Result 8, seen from the model's side.
- **Readable presentation is much cheaper** at equal accuracy: 4,300 vs 20,740
  tokens. That is the real win, and it is ~4.8× on this data, not 7×.

**What this still does not say:** nothing about retrieval without a handle, and
nothing about how often the chain completes (one run is not a rate).

Original (invalidated) numbers, kept so the error is traceable:

| Presentation | Tokens | Fits 32K? | Correct |
|---|---:|---|---:|
| A — raw JSON history | 46,680 | no | 0/20 |
| B — compressed `@T` tables | 27,420 | yes | 0/20 |
| C — readable plain sentences | 6,640 | yes | 20/20 |

### What this means for the design

Compression still has two separate jobs — that conclusion survives:

- **Storage** — lossless, tight, machine-oriented (`@T`, dedup). Nothing lost.
- **Presentation** — readable, derived deterministically from the stored data.
  No LLM call, no summary written by a model.

The correction changes *why* presentation matters. Not because `@T` is
unreadable, but because readable sentences carry the same answer in **~5× fewer
tokens** at equal accuracy. Fewer tokens is what keeps the request inside the
loaded window — which, for local runtimes, is the binding constraint.

## Result 5 — compression alone makes a session fit

`continuity_test`, 60 turns, 32K window:

| Form | Tokens | Fits 32K? |
|---|---:|---|
| Raw | 49,980 | **no** |
| Compressed | 26,640 | **yes** (46.7% saving) |

So the window problem is solvable by compression alone, independent of the
model. What is *not* solved by compression alone is getting the model to use
that context — see Result 6.

## Result 6 — the model cannot navigate; we must do the navigation

Two negative results, both worth keeping so they are not repeated.

**`map_navigation_test`** — context map + a `recall` tool, model decides:

| Condition | Correct | recall calls |
|---|---:|---:|
| No context | 0/20 | 0 |
| Map + recall tool | **0/20** | **0** |
| Full text injected (reference) | 20/20 | — |

The model never called the tool. Giving the right content produced 20/20, so
the problem is not the model's ability to *read* — it is its ability to
*choose*.

**`deterministic_test`** — keyword matching picks the item:

| Condition | Correct |
|---|---:|
| Keyword retrieval | **0/20** |
| Full text injected | 20/20 |

Reason: words like "secret", "code", "turn" appear in **every** turn, so the
filter returned all 200 items and the model drowned again. Word matching cannot
express "the one about turn 47".

**Conclusion:** selecting *which* stored item is relevant is a semantic
question. Pure keyword matching does not answer it. We therefore do not rely on
the model to navigate, and we do not pretend keyword matching is retrieval.

## Result 7 — the chain works end to end (live model)

> **Scope, stated plainly.** This is **five probes in one run**, at temperature
> 0. It shows the chain completes several times, including for different stored
> items. It is still **not a rate**: temperature 0 makes repeated identical
> questions deterministic, so the repeat count says nothing about reliability
> under sampling. Treat it as a demonstration of the mechanism, not an estimate
> of how often it succeeds.

`e2e_context_live.rs`, real `qwen2.5-coder:7b` through Ollama, 12 turns each
with a 45-record tool output, budget deliberately narrow (1,500 tokens) so
compaction fires early. Five different stored items are probed:

```
12 turns, 37 messages   → budget 1,500 exceeded
compaction: 12 messages → readable summaries, recall ids [1,10,19,28,34]
all ids resolvable in the store

probe  stored id  recall called  returned content  model answer
  1        1          yes           LOSSLESS          src/module_00.rs
  2       10          yes           LOSSLESS          src/module_06.rs
  3       19          yes           LOSSLESS          src/module_05.rs
  4       28          yes           LOSSLESS          src/module_04.rs
  5       34          yes           LOSSLESS          src/module_01.rs

recall calls          5/5
lossless content      5/5
chain (file path)     5/5
```

Each answer names the first file path from *that* stored item, so the model
could not have answered from a summary alone — it had to call `recall` and read
the restored content.

### A real bug found by this test

On the first run the chain **failed**: the model wrote the tool call as plain
content instead of a `tool_calls` field:

```
{"name": "recall", "arguments": {"id": 1}}
```

The tool never ran. This is common in small/local models. Without handling it,
"model-independent" would be a false claim: on a less capable model the feature
would die silently.

Fixed in `backend/ai.rs` — `rescue_text_tool_call` accepts a text-shaped tool
call only when:
- the name matches a **known tool** (so arbitrary JSON is not mistaken for a
  call), and
- the response is essentially that JSON (a short prefix/suffix is allowed, long
  prose around it is not).

Wired into **both** tool loops (`run_tool_loop` and `stream_tool_loop` — the
latter is the path the UI actually uses).

## Result 8 — a local server's *declared* window is not its *loaded* window

This is the most dangerous failure in the whole chain, because it is silent.

The budget is derived from the context window. For cloud providers the declared
window is trustworthy. For a local server (Ollama) it is not, measured on
Ollama 0.40.11 with `qwen2.5-coder:7b`:

| Observation | Result |
|---|---|
| `GET /v1/models` fields | **no `context_length`** at all |
| `GET /api/ps` → `context_length` after a default load | **4096** (not 32K) |
| Declared model window | 32768 |
| Budget the old code derived (55% of 32768) | **18,022 tokens** |
| Actual usable window | 4096 |

What happens when the request exceeds the loaded window — the server does not
error, it **truncates**:

| Prompt sent | `prompt_tokens` returned | Needle (mid-prompt) found? |
|---|---:|---|
| 20,000 chars | 2,050 | no |
| 40,000 chars | 2,050 | no |
| 150,000 chars (32K-loaded instance) | 16,386 | no |

The last row is not a rounding error: Ollama kept exactly half the window
(32768 → 16386) and the information in the middle was simply gone. A user would
see a confident wrong answer, not an error.

Also measured: `num_ctx` cannot be fixed over the OpenAI-compatible endpoint.

| Attempt | `/api/ps` after the compat request |
|---|---|
| `options.num_ctx=32768` in `/v1/chat/completions` | **ignored** (stayed 4096) |
| Preload via `/api/generate` with `num_ctx=8192`, then compat call | **reloaded back to 4096** |
| `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`, then compat call | **32768 — honoured** |

**Fix in the code** (`backend/model_caps.rs::loaded_context_window`,
`backend/ai.rs::effective_context_window`):

1. Ask the server what it actually loaded: Ollama `/api/ps` →
   `context_length`; llama.cpp `/v1/models` → `meta.n_ctx` (the allocated
   window) before `meta.n_ctx_train` (the training window).
2. Take the **smaller** of declared and loaded.
3. If a local server reports nothing, fall back to **4096** — Ollama's default
   load — instead of 32768.
4. Report `window_verified: false` in the response so the UI can say the window
   was assumed rather than measured.

Cloud providers are unaffected: they have no "loaded window", so the declared
value is used as before.

## The design that follows from these measurements

```
Every turn
  └─ tool output, user text, assistant reply
       └─ written to the store, losslessly compressed, deduped by content

Every request
  └─ context assembled under a token budget
       ├─ system prompt                      (never compacted)
       ├─ recent turns, full text            (recency)
       ├─ older turns, readable summaries    (each carries recall(id=N))
       │    └─ only if the store can resolve that id — otherwise left alone
       └─ last user message, full text       (never compacted)

Model may call recall(id) at any time
  └─ store returns the original bytes, losslessly
```

Two rules make this trustworthy:

1. **A message is only compacted if the store can resolve it.** Otherwise it is
   left untouched. Compacting something unreachable would create
   unretrievable information — that would break the project's core contract.
2. **Presentation is derived, not summarised by a model.** Readable summaries
   are produced by deterministic code, so they cost nothing and cannot
   hallucinate.

## Honest limits

- **Prose does not compress.** Measured 2.2% on prose, 0% on code. Savings come
  from structured data. This is stated in the UI and the README.
- **Item selection is not solved.** When the user asks "the thing we discussed
  earlier" without a concrete handle (turn number, file path), keyword matching
  is not enough. The information is still in the store and the user can reach
  it, but automatic selection is not reliable. Only injecting the right text
  scored 20/20.
- **7B models are weak at counting.** In the end-to-end run the model first said
  "100 items" for a 45-item array. The file path was right; the count was not.
  This is a model limitation, not a pipeline one — the store returned the
  correct content (verified `LOSSLESS`).
- **Budget is deliberately conservative** — 55% of the *effective* window (the
  smaller of declared and loaded). Room is needed for output and tool schemas,
  and narrower context reduces the lost-in-the-middle effect.
- **The window is not eliminated, it is bounded.** Nothing can make the window
  infinite; the goal is to keep it small while keeping information reachable.
- **Compaction summaries drop values unless they are rare.** The readable
  summary reports item count, status distribution and field names. A value that
  appears on every row is folded into the distribution; a value that appears on
  one or two rows is listed as `Distinct: field=value`. If a summary is ever
  wrong about a value, the full text is still in the store — but the model will
  only see it if it calls `recall(id)`. A summary is a *view*, not the record.
- **Retrieval is only as good as the handle.** Every test that scored well gave
  the question a concrete handle (turn number, file path). With no handle, the
  right item is not selected (Result 6).
- **The end-to-end run is a demonstration, not a rate.** Five probes at
  temperature 0. It shows the mechanism works across different stored items; it
  does not estimate how often it succeeds under sampling.
- **The `@T`-is-unreadable claim is withdrawn.** It came from a test that
  varied length and format at the same time (Result 4). Use
  `presentation_test` before asserting anything about format.
- **A local server can silently truncate.** Even with the fix, a server that
  reports nothing is assumed to be 4096. If the real loaded window is smaller
  than that, prompts are still truncated — and the response only says
  `window_verified: false`.

## How to reproduce

```bash
# No model needed
cargo run --manifest-path src-tauri/Cargo.toml --example pyramid_probe --release
cargo run --manifest-path src-tauri/Cargo.toml --example tok_probe --release
cargo run --manifest-path src-tauri/Cargo.toml --example context_soak --release

# Needs a local model (Ollama).
# IMPORTANT: set the context length explicitly. A default `ollama serve` loads
# the model at 4096 and silently truncates longer prompts (Result 8), which
# makes every long-context measurement below meaningless.
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
ollama pull qwen2.5-coder:7b

cargo run --manifest-path src-tauri/Cargo.toml --example presentation_test --release
cargo run --manifest-path src-tauri/Cargo.toml --example continuity_test --release
cargo run --manifest-path src-tauri/Cargo.toml --example e2e_context_live --release
```

`presentation_test` refuses to run unless `/api/ps` confirms the loaded window
is at least 32K, so a truncated-window run cannot be mistaken for a result. If
you use a second instance (`OLLAMA_BASE=http://127.0.0.1:11435`), point it
there.

The negative results are reproducible too — `map_navigation_test` and
`deterministic_test` are kept in the repository on purpose.
