# Benchmarks

## Purpose

Two questions matter for a prompt-compression engine, and they are separate:

1. **Does it save tokens?** Measured deterministically, no model involved.
2. **Does it hurt the answer?** Measured with a real model, A/B against the raw
   data, with an A/A noise floor.

Token savings alone are not a quality claim. Quality alone without a measured
token delta is not a savings claim. This page keeps them apart.

## Protocol

### Token measurement

`src-tauri/examples/bench_public.rs` generates deterministic synthetic data from
a seeded LCG, runs it through `process_with_metrics`, and reports raw tokens,
compressed tokens, savings percentage, whether the engine applied compression,
and whether the compressed form decodes back to the original.

- Tokenizer: `cl100k_base` (`tiktoken-rs`).
- Data is regenerated on every run; nothing is downloaded.
- Control cases: plain prose and a fenced code block, both expected to come out
  unchanged at 0% savings.

Reproduce:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --example bench_public --release
```

### Quality measurement

`src-tauri/examples/bench_dump.rs` writes `bench/out/cases.json` with the raw
prompt, the compressed prompt, and questions whose answers are computed from the
generated data. `scripts/bench-quality.mjs` then asks a model three conditions
at `temperature=0` — `RAW`, `COMPRESSED`, `RAW_REPEAT` — and scores normalised
exact match. See [bench/README.md](../bench/README.md) for how to run it against
Ollama, llama.cpp, LM Studio, or a cloud provider.

## Models

- **Token measurement:** none (deterministic).
- **Quality measurement:** whatever model you point the harness at. No quality
  result in this document was produced for this release — see below.

## Task counts

| Source | Datasets | Questions |
|---|---|---|
| `bench_public` (token only) | 12 (10 structured + 2 control) | — |
| `bench_dump` (quality) | 10 | 30 |

(The markdown-table dataset contributes questions but currently passes through
uncompressed; see Limitations.)

## Metric

- **Tokens:** `cl100k_base` token count before and after; savings percentage is
  the engine's own reported value.
- **Quality:** exact-match accuracy per question kind, with a 95% Wilson
  confidence interval, and the `RAW−COMPRESSED` difference shown next to the
  `RAW−REPEAT` A/A difference.

## Results

### Token savings (measured)

Real output of `cargo run --example bench_public --release` in this repository
on 2026-10-27. The same table is written to
[`bench/results/token-savings.md`](../bench/results/token-savings.md).

| Dataset | Kind | Raw tokens | Compressed tokens | Savings % | Round-trip | Applied |
|---|---|---:|---:|---:|---|---|
| JSON records | json | 7403 | 4270 | 42.3 | ok | yes |
| JSONL access log | jsonl | 18500 | 7614 | 58.8 | ok | yes |
| CSV orders | csv | 5862 | 5177 | 11.7 | ok | yes |
| logfmt lines | logfmt | 10799 | 4626 | 57.2 | ok | yes |
| Markdown table | md-table | 1618 | 1618 | 0.0 | n/a | no |
| XML catalog | xml | 6756 | 2141 | 68.3 | ok | yes |
| SQL inserts | sql | 3280 | 2416 | 26.3 | ok | yes |
| INI profiles | ini | 368 | 219 | 40.5 | ok | yes |
| TOML deps | toml | 368 | 265 | 28.0 | ok | yes |
| YAML workers | yaml | 302 | 136 | 55.0 | ok | yes |
| CONTROL prose | prose | 521 | 521 | 0.0 | n/a | no |
| CONTROL code | code | 36 | 36 | 0.0 | n/a | no |

These are the numbers this run produced. They are not a promise; different data
shapes will produce different savings.

### Comprehension (earlier internal measurement)

The only comprehension evidence that exists is the measurement recorded in the
comment at the top of `src-tauri/src/engine/plain_table.rs`. Its wording:

> Anlama kapısı (43 eşleştirilmiş soru, yerel 7B, 3 tekrar):
> ham %100 / tablo %100. Token: XML %65-77, SQL %26-37.

Read that carefully:

- It measured **only the plain-table adapter** (the XML/SQL table representation).
- It did **not** measure the JSON `@T` encoding.
- It is **43 paired questions, one local 7B model, 3 repeats** — a small run, not
  a benchmark suite.
- The source is that code comment; the harness and corpora are not published
  in this repository.

It is reported here as historical context, not as a current claim. The public
harness above is the way to produce a result that can be checked.

### Quality (not yet measured for this release)

No quality A/B run was executed for `0.1.0-beta`: it requires a running model
endpoint, which was not available in the environment that produced this
document. Run `scripts/bench-quality.mjs` against your own model and fill in the
table from `bench/results/quality-<date>.md`:

> TODO: quality A/B output (RAW / COMPRESSED / RAW_REPEAT accuracy per question
> kind, with 95% CI and the A/A noise floor).

## Limitations

- **Prose and code are never compressed.** Savings come only from structured
  data. The control rows show 0%.
- **Token counts use `cl100k_base`.** Claude, Gemini, and Llama tokenizers count
  differently; do not carry these percentages over to those models without
  re-measuring.
- **Quality results are model-specific.** A result from one 7B model does not
  transfer to another model.
- **The A/A noise floor matters.** Without `RAW−REPEAT`, a small
  `RAW−COMPRESSED` difference cannot be interpreted.
- **Markdown tables are not compressed today.** The segmenter starts structural
  runs at 3 lines but a markdown table needs at least 4 (header, separator, and
  two rows); the table therefore passes through untouched. This is recorded as
  an ignored test in `src-tauri/src/engine/roundtrip_tests.rs` and is a known
  engine gap, not a measurement artefact.
- **Synthetic data.** Savings depend on how repetitive the data is. Real-world
  data may save less; re-run `bench_public` in your own context to check.

## How to reproduce

```bash
# Token savings (no model needed)
cargo run --manifest-path src-tauri/Cargo.toml --example bench_public --release

# Engine speed (no model needed)
cargo run --manifest-path src-tauri/Cargo.toml --example bench_engine --release

# Quality A/B (bring an OpenAI-compatible endpoint)
cargo run --manifest-path src-tauri/Cargo.toml --example bench_dump --release
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 MODEL=llama3.2 \
  node scripts/bench-quality.mjs
```

Nothing here downloads data or calls a third party unless you point the quality
harness at one.
