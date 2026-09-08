# Contributing

Use Rust stable, Node.js LTS, and the pnpm version declared in `package.json`. Keep changes inside the relevant feature or platform boundary and preserve the content-first handler registry.

Before submitting a change, run:

```powershell
pnpm lint
pnpm test
pnpm build
Push-Location src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
Pop-Location
```

Tests should create fixtures at runtime. Do not commit large or sensitive files. Security fixes should cover both the command boundary and the underlying service. New viewers must be dynamically imported, bound resource use, cancel background work on disposal, and include corrupt/oversized input tests. New commands must use typed requests and responses, structured errors, canonicalized paths, and the minimum capability required.

Do not add remote scripts, telemetry, generic execution APIs, or broad frontend filesystem permissions. Keep file association extensions in the single bundle entry in `src-tauri/tauri.conf.json`.
