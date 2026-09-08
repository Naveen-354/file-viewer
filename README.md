# OneOpen

OneOpen is a lightweight Tauri desktop workspace that detects untrusted files and opens them in lazy-loaded viewers. The current Windows build supports text/source files, JSON, XML, CSV/TSV, WebView-compatible images and media, PDF, Excel workbooks, Word documents, ZIP, and a metadata/hex fallback. Markdown files have source and editable rich-text modes. PDF files can be annotated with text, rotated, pruned, undone, and saved from the in-app editor. Word files open read-only. Excel workbooks support resizable columns, per-column filters, and cell editing saved back to .xlsx/.xlsm. Any image the app can decode, including SVG, can be converted to another format from the image viewer's Convert button.

New contributors and coding agents should start with [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md).

## Prerequisites (Windows 10/11)

Install WebView2 (included with current Windows), the Visual C++ build tools, Rust stable, Node.js LTS, and pnpm:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
winget install OpenJS.NodeJS.LTS
rustup default stable
npm install --global pnpm@10.15.0
```

See the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/) if a compiler or WebView2 component is missing.

## Install dependencies

```powershell
pnpm install
```

## Development

```powershell
pnpm tauri dev
```

Open files at startup by appending quoted paths:

```powershell
pnpm tauri dev -- "C:\path with spaces\sample.txt" "C:\data\sample.json"
```

Opening a second OneOpen process forwards its file arguments to the existing process.

## Testing

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

## Production build

```powershell
pnpm tauri build
```

## Create the Windows installer

Both MSI and NSIS targets are configured:

```powershell
pnpm tauri build -- --bundles msi,nsis
Get-ChildItem .\src-tauri\target\release\bundle -Recurse
```

## Register and test file associations

File associations are centralized in `src-tauri/tauri.conf.json`. Build and install the generated NSIS package, then select OneOpen once from Explorer's **Open with** menu:

```powershell
$installer = Get-ChildItem .\src-tauri\target\release\bundle\nsis\*.exe | Select-Object -First 1
Start-Process -FilePath $installer.FullName -Wait
Start-Process -FilePath "C:\path with spaces\sample.txt"
```

To test argument forwarding without changing the default application, start the installed `OneOpen.exe` twice with different quoted file paths.

## Safety limits

Text editing is capped at 16 MiB, Markdown rich-text mode at 2 MiB, and larger text files get a bounded read-only preview. PDF editing is capped at 24 MiB input and 64 MiB output. Structured trees, images, PDF, and media use separate bounded preview limits. CSV parsing stops at 64 MiB or 100,000 rows. Image conversion is capped at 80 MiB input, 100 megapixels, and 128 MiB output. Workbooks are capped at 48 MiB and 500,000 cells per sheet; Word documents at 32 MiB, 20,000 blocks, and 8 MiB of text. ZIP extraction rejects unsafe paths, links, suspicious ratios, entries over 1 GiB, more than 100,000 files, and more than 4 GiB total decompressed data.

Application data is stored in SQLite in Tauri's per-user app-data directory. File contents are never stored in the database.
