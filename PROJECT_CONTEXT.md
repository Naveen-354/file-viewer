# OneOpen project context

This is the fast handoff for engineers and coding agents. Read this file before inspecting implementation details. Use `ARCHITECTURE.md` and `SECURITY.md` only when the task needs deeper design or threat-model context.

Several agents work on this project concurrently. Read [`AGENT_WORKLOG.md`](AGENT_WORKLOG.md) before starting and record your workstream there, so two agents do not edit the same files at once.

## Workspace management

Workspaces are local SQLite metadata records containing a name, multiple folder paths, optional pinned file paths, a restore-session preference, and last-opened time. Folder contents are loaded lazily through `list_directory`; missing saved paths remain visible as unavailable. Workspace removal only deletes OneOpen database rows and never deletes, moves, or edits source folders/files. The active workspace id is stored locally, while durable workspace data is defined by `0002_workspaces.sql`.

## Product snapshot

OneOpen is a Windows-first universal desktop file workspace built with Tauri 2, Rust, React, and TypeScript. It accepts files from the picker, drag-and-drop, command-line arguments, and Windows file associations. A single running instance owns a multi-tab workspace and receives subsequent open requests.

Supported viewers:

| Handler | Formats | Main implementation |
| --- | --- | --- |
| Text/code | TXT, LOG, MD, Java, Kotlin, JS/TS/JSX/TSX, Rust, Python, SQL, YAML, properties, ENV; Markdown source/rich-text modes | `src/handlers/text/TextViewer.tsx` |
| Structured data | JSON, XML; tree/raw/table inspector, node details, raw editing with save | `src/handlers/structured-data/StructuredViewer.tsx` |
| Delimited data | CSV, TSV | `src/handlers/csv/CsvViewer.tsx` |
| Spreadsheets | XLSX, XLSM, XLSB, legacy XLS, ODS; cell editing on XLSX/XLSM | `src/handlers/spreadsheet/SpreadsheetViewer.tsx` |
| Word documents | DOCX, DOCM | `src/handlers/document/DocumentViewer.tsx` |
| Images | PNG, JPEG, GIF, WebP, sanitized SVG; raster inspector with pixel probe, channels, histogram and metadata | `src/handlers/image/ImageViewer.tsx` |
| PDF | PDF.js preview; rich-text annotations, images, rotation, deletion, undo, Save/Save As | `src/handlers/pdf/PdfViewer.tsx` |
| Media | Video: stream inspector, transport, frame capture. Audio: waveform, spectrum, EBU R128 loudness, tags | `src/handlers/media/MediaViewer.tsx`, `AudioViewer.tsx` |
| Archives | ZIP browse and guarded extraction | `src/handlers/archive/ArchiveViewer.tsx` |
| Fallback | Metadata, hex preview, system open/reveal | `src/handlers/fallback/FallbackViewer.tsx` |

## Architecture in one minute

```text
React shell and lazy viewer modules
        ↓ typed invoke/events
Narrow Tauri commands
        ↓
Rust detection, bounded I/O, persistence, ZIP safety, OS integration
```

- `src/app/App.tsx` wires startup restoration, open events, drag/drop, keyboard shortcuts, window persistence, and the shell.
- `src/stores/workspace.ts` is the authoritative tab state. It deduplicates sequential and concurrent open requests.
- `src/app/ViewerHost.tsx` dynamically loads the selected handler and keeps viewer callbacks stable. Do not replace its memoized callbacks with inline functions; viewer effects depend on callback identity.
- `src/handlers/registry.ts` is the only frontend handler registry. Every viewer must remain dynamically imported.
- `src/services/tauri.ts` is the typed frontend command boundary and maps structured Rust errors.
- `src-tauri/src/commands/mod.rs` is the only frontend-facing Rust command surface.
- `src-tauri/src/file_detection/mod.rs` classifies by magic bytes/content first and extension last.
- `src-tauri/src/file_io/mod.rs` provides bounded chunk reads and atomic text/binary replacement.
- `src-tauri/src/handlers/archive.rs` applies ZIP traversal, symlink, count, size, and compression-ratio defenses.
- `src-tauri/src/handlers/image.rs` decodes raster images and SVG and re-encodes them to a chosen format; `TARGETS` there is the single source of truth the converter UI is built from.
- `src-tauri/src/handlers/spreadsheet.rs` reads workbooks through `calamine` and returns one bounded sheet at a time, and owns the editability and conflict checks for saves.
- `src-tauri/src/handlers/xlsx_edit.rs` applies cell edits by patching only the worksheet XML and copying every other package part byte-for-byte, so charts, images, macros and styles survive.
- `src-tauri/src/handlers/document.rs` reads `word/document.xml` and `word/numbering.xml` with the archive decompression defenses and returns a typed block model, never HTML.
- `src-tauri/src/persistence/mod.rs` owns SQLx queries and migrations.
- `src-tauri/capabilities/main.json` and the CSP in `src-tauri/tauri.conf.json` define the frontend security boundary.

## File-open flow

1. Startup arguments are queued in Rust; secondary instances emit `open-files` to the first instance.
2. The frontend sends each path to `detect_file`.
3. Rust canonicalizes the path, samples at most 8 KiB, selects a handler, and records the recent file.
4. Zustand creates or activates one tab. In-flight paths are tracked so simultaneous startup/session requests cannot create duplicates.
5. `ViewerHost` imports only the selected viewer module.
6. Viewers request bounded chunks and dispose editors, render tasks, listeners, and Blob URLs on unmount.

## Persistence

SQLite is stored in Tauri's per-user app-data directory. Migration `src-tauri/migrations/0001_initial.sql` creates recent files, pins, settings, session tabs, window state, and handler preferences. File contents are never persisted. Missing recent and session files do not block startup.

## Resource and security limits

- Rust read command: maximum 4 MiB per request.
- Editable text: 16 MiB; larger files receive a 4 MiB read-only preview. Markdown rich-text mode is capped at 2 MiB.
- Structured tree: 12 MiB; parse failures use the text handler.
- CSV: 64 MiB, 100,000 rows, 256 columns, virtualized DOM rows.
- Images: 80 MiB; SVG scripts, foreign objects, event handlers, and links are removed.
- Image conversion: 80 MiB input, 100 megapixels, 20,000 pixels per side, 128 MiB output; ICO targets are limited to 256x256.
- PDF: 64 MiB preview; 24 MiB in-app edit input; 64 MiB edited output; 16 MiB per inserted image; only the current page is rendered.
- Media: 48 MiB; larger or unsupported-codec files use the system fallback.
- Spreadsheet: 48 MiB workbook; per sheet 50,000 rows, 256 columns, and 500,000 cells.
- Spreadsheet editing: 10,000 cells per save, 32,767 characters per cell, 64 MiB per decompressed part at a maximum 1000:1 ratio.
- Word document: 32 MiB file, 64 MiB per decompressed part at a maximum 1000:1 ratio, 20,000 blocks, 8 MiB of text, 5,000 table rows, 64 table columns.
- ZIP: 100,000 entries, 1 GiB per entry, 4 GiB total decompressed data, maximum 1000:1 ratio; links and unsafe paths are rejected.

Do not broaden frontend filesystem permissions, introduce a generic shell command, log file paths/content, evaluate file content, or bypass Rust path validation.

## Common change routes

- Add a viewer: update Rust detection, add a lazily imported registry entry, implement `ViewerProps`, add corrupt/large-input tests, and update file associations if appropriate.
- Add a command: define typed domain models, validate paths in Rust, return `AppError`, register it in `lib.rs`, add the typed wrapper in `src/services/tauri.ts`, and grant only a required capability.
- Change persistence: add a new numbered SQL migration; never edit an already released migration.
- Change tab behavior: add Zustand tests for duplicate, dirty, close, reopen, and concurrent-open behavior.
- Change a viewer effect: keep callback dependencies stable and add a mount/reload regression test.

## Validation and run commands

The current machine has a broken system Corepack shim, so validation used the installed npm-global pnpm executable:

```powershell
& "$env:APPDATA\npm\pnpm.cmd" lint
& "$env:APPDATA\npm\pnpm.cmd" test
& "$env:APPDATA\npm\pnpm.cmd" build
Push-Location src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
Pop-Location
```

Development:

```powershell
& "$env:APPDATA\npm\pnpm.cmd" tauri dev
```

`tauri build` and `tauri dev` run `beforeBuildCommand`/`beforeDevCommand` as a nested bare `pnpm`, which resolves to the broken shim again. Put the working executable first on `PATH` for those commands:

```powershell
$env:PATH = "$env:APPDATA\npm;" + $env:PATH
& "$env:APPDATA\npm\pnpm.cmd" tauri build
```

Built application and installers:

```text
src-tauri/target/release/oneopen.exe
src-tauri/target/release/bundle/msi/OneOpen_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/OneOpen_0.1.0_x64-setup.exe
```

## Change history

### 2026-09-02 — Markdown rich-text editing

- Added a rendered rich-text mode for Markdown with headings, emphasis, underline, strike, lists, quotes, inline code, links, and undo/redo.
- Added two-way Markdown conversion so rich-text changes save through the existing atomic save, conflict detection, dirty-tab, and Save As workflows.
- Kept the editor lazily loaded so non-Markdown text files do not load the rich-text dependency bundle.

### 2026-09-07 — Audio studio view

- Audio files now open in `AudioViewer` instead of the video player: per-channel waveform with peak and RMS envelopes, Stereo/Mid-Side/Mono-Sum views, zoom, click-to-seek playhead, a live 4096-point FFT spectrum on a log axis, and a full transport.
- `src/utils/loudness.ts` implements ITU-R BS.1770 K-weighting, 400 ms gating blocks and the two-stage gate, giving real integrated/short-term/momentary LUFS, loudness range, sample peak, an oversampled true-peak estimate and stereo correlation.
- `src/utils/audioMeta.ts` reads FLAC STREAMINFO and Vorbis comments, WAV `fmt `/`LIST INFO`, and MP3 ID3v2 plus the frame header, so codec, bit depth, sample rate, encoder and tags come from the file.
- The Output section reports the device sample rate and whether resampling occurs, both from `AudioContext`.
- Deliberately omitted from the supplied design: the ASIO/WASAPI device picker, roundtrip-buffer latency, xrun counts, "mmap zero-copy" memory figures, A/B compare, stem export and waveform markers. A WebView exposes none of that. True peak is labelled as a 4x estimate rather than the BS.1770 filter.

### 2026-09-07 — Media stream inspector

- Rebuilt the media viewer with a custom transport (play/pause, ±10s, restart, scrub, volume, speed, loop, fullscreen), fit modes, an on-video HUD, and Capture PNG which writes the current frame through a new `save_image_frame` command.
- `src/utils/mediaMeta.ts` parses MP4 boxes (`mvhd`, `trak`/`hdlr`/`stsd`, `avcC`, `hvcC`, `esds`) and walks EBML for WebM, so codec, profile/level, dimensions, sample rate and channel count come from the container.
- Frame rate, frame count, dropped frames and buffer depth come from `requestVideoFrameCallback` and `getVideoPlaybackQuality`, which is the only playback truth the WebView exposes.
- `save_image_frame` accepts only PNG bytes to a `.png` destination, so it cannot become a general file-writing primitive.
- Deliberately omitted from the supplied design: the NVDEC/hardware-decode badge, GOP/keyframe state, decoder jitter, the real-time bitrate graph, audio-track and embedded-subtitle pickers, and the V-Sync footer. None of that is observable from a WebView, and the bitrate shown is labelled as a file average because that is what a container can prove.

### 2026-09-07 — Raster inspector

- Rebuilt the image viewer around a canvas instead of an `<img>`, which is what makes pixel probing, channel isolation and the histogram possible.
- Added a zoom slider with Fit and 1:1, a pixel grid from 400%, a transparency toggle, an eyedropper reporting X/Y and RGBA/hex under the cursor with crosshair guides, and RGBA/R/G/B/Alpha channel isolation.
- Added an Inspector panel: dimensions, aspect ratio, colour space, colour type, bit depth, file size, compression and interlacing, a live colour histogram, and embedded metadata.
- `src/utils/imageMeta.ts` reads PNG chunks (IHDR, sRGB, gAMA, cHRM, iCCP, pHYs, tEXt/iTXt) and JPEG segments (SOF, JFIF, Exif IFD0, ICC presence). Fields the file does not carry are omitted rather than guessed, so the panel never invents a colour profile or gamma.
- The Convert action is unchanged and still opens the existing panel.

### 2026-09-07 — Editable raw JSON

- Added an Edit button to the inspector's Raw Code mode, backed by a CodeMirror editor with JSON/XML syntax, line numbers and search.
- The buffer is validated on every keystroke; Save and Save as are disabled while the document does not parse, and the reason is shown in a banner and in the status line. A config file cannot be corrupted by a stray comma.
- Save reuses the existing `save_text_file` path, including the modification-timestamp conflict prompt, and refreshes the tree from the saved text. Read-only files can still Save as.
- Format reflows the buffer being edited; the earlier Prettify only reformatted the read-only view and is hidden while editing.

### 2026-09-07 — JSON inspector

- Rebuilt the structured-data viewer as an inspector: Tree/Raw/Table modes, expand and collapse all, search with a match count that reveals hits, a virtualised syntax-coloured tree, a node-details panel, a path breadcrumb, and a validity/size/depth/encoding status line.
- `src/utils/jsonTree.ts` adds a JSON parser that records source offsets, because `JSON.parse` discards them and the details panel reports a real byte offset and can locate a node in the raw text.
- The tree is virtualised, so a large document renders only the visible rows.
- Table mode appears only when the selected node is an array of objects; it is disabled with an explanatory tooltip otherwise.
- Deliberately omitted from the supplied design: the "Schema Telemetry" panel (violations, rules evaluated), the "Valid JSON Schema v7" badge, "Memory Cache Ready", and the "JsonEngine v1.4" footer. Nothing validates against a JSON Schema, so those numbers would have been fabricated. The validity badge reports only what the parser actually proved.

### 2026-09-04 — PDF toolbar icons

- Added `lucide-react` and replaced the PDF viewer's text labels and unicode glyphs with real icons: page previews, paging, zoom, fit, edit, search, outline, print and file info, plus the edit toolbar's text/select/image/delete/rotate/undo/save actions.
- The annotation editor's `B`/`I`/`U`/`S` letters became Bold/Italic/Underline/Strikethrough icons; the italic `I` in particular was unreadable at that size.
- Every icon-only button carries an `aria-label` and a `title`, so accessible names and tooltips survive the loss of visible text. Existing tests query those names unchanged.

### 2026-09-04 — Home and shell visual redesign

- Reworked the home page and shell to the supplied design: a recent-files table with format badges, size and last-inspected columns, dual Open File / Open Directory actions, a file-type tally in the sidebar, a breadcrumb bar with Wrap/Reveal/Open external, a richer status bar, and a footer.
- Added `RecentFile.size`, taken from the stat the recent-files query already performed.
- `src/utils/fileKind.ts` maps handler ids to kind, tone, badge label, size and relative-time formatting, and is the single source for those across the sidebar and home page.
- Sidebar entries and tree rows now truncate instead of wrapping, which was the visible breakage on long file names.

### 2026-09-02 — PDF rich text and image insertion

- Replaced the single-line PDF annotation input with a rich-text editor: bold, italic, underline, strikethrough, Helvetica/Times/Courier, sizes from 8 to 64, and colour, applied to the selection or to the whole box.
- Added image insertion. PNG and JPEG embed directly; anything else the WebView can decode is re-encoded to PNG first, and formats it cannot decode point at the image viewer's converter.
- Existing text and images can be selected, dragged, resized (images) and deleted, and text reopens in the editor on double-click.
- Annotations are now a list of styled runs written with the 12 built-in PDF faces, so nothing is embedded and the file stays small. Underline and strikethrough are drawn as lines.
- Characters the built-in fonts cannot encode are folded to their ASCII equivalents where one exists and dropped otherwise, so a save never fails on a smart quote.

### 2026-09-02 — Spreadsheet column sizing, filtering and cell editing

- Added draggable column widths with double-click auto-fit, and an Excel-style per-column filter combining a contains box with a value checklist.
- Added cell editing with keyboard navigation, a dirty-tab indicator, Save/Discard, and Ctrl+S. Unsaved edits shadow the file values everywhere, including in the filters.
- `edit_spreadsheet` writes through `handlers/xlsx_edit.rs`, which rewrites only the worksheet part and raw-copies every other package part, so charts, images, merged ranges, number formats, macros and other sheets are preserved. `fullCalcOnLoad` is set so Excel recomputes formulas whose inputs changed.
- Editing is restricted to `.xlsx` and `.xlsm`. Writing `.xls`, `.xlsb` or `.ods` would mean regenerating the file and discarding everything the app does not model, so those stay read-only.
- Saves reuse the existing modification-timestamp conflict check and atomic write.

### 2026-09-02 — Image format converter

- Added a Convert action to the image viewer that re-encodes the open image to PNG, JPEG, lossless WebP, GIF, BMP, ICO, TIFF, TGA, QOI, or PPM and saves it through a Save As dialog.
- Conversion runs in Rust (`convert_image`) using the `image` crate, with `resvg` rasterizing SVG input at its intrinsic size. The frontend builds its format menu from `get_image_formats`, so the UI can never offer a target the encoder lacks.
- JPEG quality is adjustable, and targets without an alpha channel composite transparency onto a chosen background colour instead of turning it black.
- The destination extension must match the chosen encoder, and the file is written with the existing atomic-write path.
- PPM is written as P6 rather than the crate default of P7/PAM, and TGA is written uncompressed, because both defaults produce files other decoders reject. Formats with no leading signature, such as TGA, fall back to the extension when guessing.

### 2026-09-02 — Excel and Word viewers

- Added read-only spreadsheet and Word document handlers so XLSX/XLSM/XLSB/XLS/ODS and DOCX/DOCM open in the workspace instead of the hex fallback.
- Parsing stays in Rust: `read_spreadsheet` returns one bounded sheet with typed cells, and `read_document` returns a typed paragraph/table block model. Office packages are ZIPs, so document parts reuse the archive decompression defenses.
- Detection recognises OOXML packages by their part names and legacy OLE2 files by signature, keeping plain ZIPs on the archive viewer.
- Registered `xlsx`, `xlsm`, `xlsb`, `xls`, `ods`, `docx`, and `docm` file associations.

### 2026-09-02 — In-app PDF editing

- Added an Edit PDF mode for text annotations, page rotation, page deletion, undo, Save, and Save As.
- Added immediate canvas/thumbnail edit previews, dirty-tab protection, external-modification checks, bounded PDF encoding, extension/header validation, and atomic binary writes.
- Existing PDF text is preserved rather than rewritten; entered text is embedded as new PDF content.

### 2026-09-02 — Windows GUI launch

- Changed release builds to use the Windows GUI subsystem so launching `oneopen.exe` or an installed file association no longer opens a command window.
- Kept debug builds attached to their launching terminal so development logs remain available.

### 2026-09-02 — Scrolling and PDF previews

- Fixed the shared grid/flex height chain so every viewer can scroll fully to its bottom edge.
- Added a collapsible left PDF page-preview panel with virtualized rows and lazily rendered thumbnails.
- Added preview open/close controls and thumbnail page navigation while preserving one-page main rendering.

### 2026-09-01 — Viewer reliability fix

- Fixed file viewers repeatedly unloading and reloading after their own status updates. `ViewerHost` now supplies stable memoized callbacks.
- Added a regression test proving status changes do not reload the active viewer.
- Coalesced concurrent duplicate open requests from startup arguments, session restoration, drag/drop, and second-instance events.
- Rebuilt the release executable, MSI, and NSIS installer and passed a startup-with-file smoke test.
- Validation: 9 frontend tests, ESLint, TypeScript/Vite production build, Clippy, and 11 Rust tests passed.

### 2026-09-01 — Initial implementation

- Created the Tauri 2/Rust/React/TypeScript application from an empty directory.
- Added the single-instance workspace, tabs, recent and pinned files, command palette, themes, window/session restoration, file picker, drag/drop, and CLI/file-association handling.
- Added content-first detection, bounded chunk I/O, CodeMirror editing, atomic save, external-change conflicts, and structured error mapping.
- Added JSON/XML, CSV, image, PDF, media, ZIP, and fallback viewers with lazy module loading.
- Added SQLite migrations, restrictive capabilities/CSP, SVG sanitization, guarded ZIP extraction, performance logging, tests, documentation, icons, and Windows packaging.
- Produced validated debug/release executables and MSI/NSIS installers.

## Known limitations

- Large PDF and media files use an explicit bounded-preview fallback rather than a range-streaming custom protocol.
- Word documents are read-only, and spreadsheets are read-only except for cell values on XLSX/XLSM. Cell formatting, colours, merged cells, charts, images, and comments are not rendered, and formula cells show the value cached in the file, so a workbook saved by a tool that omits cached values shows those cells as empty.
- Cell editing enters values, not formulas: input starting with `=` is refused. Editing a formula cell replaces the formula with a literal. Column widths and filters are view state and are not written to the file.
- Word rendering covers paragraphs, headings, lists, runs (bold/italic/underline), line breaks, and tables. Section layout, floating images, headers/footers, and footnotes are omitted, and a table nested inside a cell is flattened into that cell's text.
- Image conversion is single-frame and 8 bits per channel: an animated GIF or WebP converts its first frame only, 16-bit sources are reduced to 8-bit, and EXIF/ICC metadata is not carried across. AVIF and HEIC are neither decoded nor encoded, WebP output is lossless only, and SVG is input-only because raster images cannot be vectorized.
- Legacy binary `.doc` and `.ppt` files are recognised but not parsed; they open in the fallback viewer with a system-open action. Legacy `.xls` is parsed.
- PDF editing adds text and images and changes page structure; it does not rewrite or reflow existing PDF text. Annotation text uses the 12 built-in PDF faces, so it is limited to the WinAnsi character set: non-Latin scripts are dropped on save rather than embedded. There is no text wrapping, alignment, bullet list or table support in annotations, and inserted images are always opaque rectangles with no rotation or cropping.
- Saving from Markdown rich-text mode may normalize Markdown syntax and unsupported custom constructs; source mode remains available for exact syntax control.
- Codec availability depends on the installed Windows WebView2 media stack.
- macOS and Linux boundaries exist, but only Windows builds and installers have been exercised.
- Automated desktop UI inspection was unavailable because the `orca` CLI was not installed; startup and startup-with-file smoke tests were performed at the process level.
