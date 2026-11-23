# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vmakeer/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vmakeer/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies the edits AI models write — in four formats — to a tree of
files. Models get line numbers wrong, drift whitespace and indentation, and
wrap patches in prose and code fences; mend still finds the target lines,
and either applies every edit or changes nothing at all.

Entry for the [make.fun bounty "Build mend, one patch tool for every AI edit
format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
(`hidden-spec-cli-01-run-20261122`).

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a patch file, or `-` (the default) to read the patch from stdin.
- `--format=NAME` forces a format: `auto` (default), `unified`,
  `search-replace`, `v4a`, or `json`. With `auto`, mend detects the format
  from the patch itself.
- `--check` validates the patch and prints what it would do, without writing
  any file.
- `--strict` matches lines exactly only; without it, mend also matches lines
  whose trailing whitespace (tier 1) or leading and trailing whitespace
  (tier 2) drifted, and re-indents new lines to the file's own indentation.

Supported formats:

- **Unified diffs** (`diff --git`, `---`/`+++`, `@@` hunks) — with creations,
  deletions, renames, and `\ No newline at end of file` handling.
- **SEARCH/REPLACE blocks** (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`).
- **V4A patches** (`*** Begin Patch` … `*** End Patch`), with Update, Add,
  Delete, Move to, anchors (`@@`), and end-of-file chunks.
- **JSON tool calls** — one JSON object per line, or a single JSON array:
  `create`, `str_replace`, `insert`, `delete`.

Exit codes: `0` applied (or valid, with `--check`), `1` an edit failed
(`no-match`, `ambiguous`, `missing`, `exists`, `unsafe` — every failure is
listed in patch order, then `failed: k of n edits`), `2` a usage, patch, or
parse error (`error: usage`, `error: no-patch`, `error: format`,
`error: parse <N>`).

## Files

- `main.ts` — the whole tool. Node 22 and its standard library alone; no
  dependencies, nothing installed at runtime.
- `runner.ts` — the kit's trial runner, kept as it is.
- `check.ts` — the practice harness: `node check.ts
  <practice.json>` runs the 100 public practice checks.
- `SPEC.md` — the specification mend implements, sentence by sentence.

## Verification

- 100 of 100 public practice checks pass (practice score 1000), under both
  Node v24 and Node v22.23.5 (the grading runtime).
- 88 additional hand-written boundary checks — wrong line numbers,
  whitespace and indentation drift, cross-file atomicity, illegal input and
  its exit codes — all pass.

## License

MIT — see `LICENSE`.
