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
| `examples/readable_test.rs` | Which *presentation* lets a small model use the context? |
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

This was the most surprising measurement.

`readable_test`, 60-turn session, 20 questions about secret codes in old turns,
`qwen2.5-coder:7b`, temperature 0:

| Presentation | Tokens | Fits 32K? | Correct |
|---|---:|---|---:|
| A — raw JSON history | 46,680 | no | **0/20** |
| B — compressed `@T` tables | 27,420 | yes | **0/20** |
| C — readable plain sentences | **6,640** | yes | **20/20** |

Same information, same model. The only difference is how it was written:

```
Turn 120: Tool found 30 items. Status: ok:10, warn:10, error:10.
```

`@T` tables fit the window but the model cannot read them. Plain sentences are
**7× smaller than raw and 100% correct**.

So compression has two jobs, and they are different:

- **Storage** — lossless, tight, machine-oriented (`@T`, dedup). Nothing lost.
- **Presentation** — readable, derived deterministically from the stored data.
  No LLM call, no summary written by a model.

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

`e2e_context_live.rs`, real `qwen2.5-coder:7b` through Ollama:

```
12 turns, 37 messages, 21,168 tokens   → budget 1,500 exceeded
compaction: 12 messages → readable summaries, 20,048 chars saved
1,120 tokens (budget met), recall ids [1,4,7,10,13] — all resolvable
model called recall(id=1) → returned content: LOSSLESS
model answer: "45 items, src/module_00.rs"  — matches the store exactly
```

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
- **Budget is deliberately conservative** — 55% of the model's declared window.
  Room is needed for output and tool schemas, and narrower context reduces the
  lost-in-the-middle effect.
- **The window is not eliminated, it is bounded.** Nothing can make the window
  infinite; the goal is to keep it small while keeping information reachable.

## How to reproduce

```bash
# No model needed
cargo run --manifest-path src-tauri/Cargo.toml --example pyramid_probe --release
cargo run --manifest-path src-tauri/Cargo.toml --example tok_probe --release
cargo run --manifest-path src-tauri/Cargo.toml --example context_soak --release

# Needs a local model (Ollama)
ollama serve
ollama pull qwen2.5-coder:7b
cargo run --manifest-path src-tauri/Cargo.toml --example readable_test --release
cargo run --manifest-path src-tauri/Cargo.toml --example continuity_test --release
cargo run --manifest-path src-tauri/Cargo.toml --example e2e_context_live --release
```

The negative results are reproducible too — `map_navigation_test` and
`deterministic_test` are kept in the repository on purpose.
