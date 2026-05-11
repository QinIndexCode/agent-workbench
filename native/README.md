# SCC Native Agent Workbench

This workspace is the first Rust/native vertical slice for SCC Agent Workbench.

## Current v1 shape

- `scc-native-shared`: serializable task, event, permission, model, and tool types.
- `scc-native-core`: native runtime, permission engine, model protocol adapter, tool executor, trace writer, and portable store.
- `scc-native-app`: `egui/eframe` desktop shell with task list, timeline, composer, permissions, pause/cancel, and ask-user answer flow.

The native runtime keeps the TypeScript web/server implementation intact. It does not embed Fastify, Vite, React, or a WebView.

## Portable default

This repository currently builds on a Windows GNU Rust toolchain without a working C compiler. To keep the native slice testable in this environment, the default build uses:

- JSON store at `data/native/native.json`
- pure Rust lexical knowledge search
- platform command based OpenAI-compatible HTTP calls

The SQLite/Tantivy path should be reintroduced behind explicit Cargo features once the target build agents have MSVC/clang or a working GNU C compiler. The public native runtime boundary is intentionally shaped so the store and knowledge index can be swapped without changing the UI.

## Run

```powershell
cd native
cargo run -p scc-native-app
```

Optional model environment:

```powershell
$env:OPENAI_API_KEY="..."
$env:OPENAI_BASE_URL="https://api.openai.com/v1"
$env:OPENAI_MODEL="gpt-5.4"
```

## Test

```powershell
cd native
cargo test
```
