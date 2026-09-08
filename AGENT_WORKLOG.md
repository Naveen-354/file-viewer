# Agent worklog

Several agents work on OneOpen at the same time. This file is how they stay out of
each other's way. Read it before starting, and add your own entry before you touch code.

## Protocol

- **One section per workstream, owned by whoever opened it.** Append your own; never
  rewrite, reorder, or delete someone else's.
- **Claim your files.** List the paths your workstream owns under your entry. If you need
  to change a file another open workstream lists, say so in your entry rather than editing
  quietly.
- **Shared files are append-only.** `PROJECT_CONTEXT.md`, `README.md`, `SECURITY.md`,
  `ARCHITECTURE.md`, `CHECKLIST.md`, `package.json`, `Cargo.toml`,
  `src/handlers/registry.ts`, `src/types/files.ts`, `src/services/tauri.ts`,
  `src-tauri/src/domain/models.rs`, `src-tauri/src/commands/mod.rs`, and
  `src-tauri/src/lib.rs` are edited by everyone. Add your lines; do not restructure
  sections you did not write. The change-history list in `PROJECT_CONTEXT.md` has already
  lost one entry to a concurrent rewrite.
- **Re-read before editing a shared file.** Another agent may have changed it since your
  last read.
- **Leave the status honest.** If something is unverified or half-done, write that down.

## Workstreams

| Status | Workstream | Owner | Last updated |
| --- | --- | --- | --- |
| Complete | Excel and Word viewers | Claude (Opus 5) session `1a7e36cd` | 2026-09-02 |
| Complete | Image format converter | Claude (Opus 5) session `1a7e36cd` | 2026-09-02 |
| Complete | Spreadsheet sizing, filtering and cell editing | Claude (Opus 5) session `1a7e36cd` | 2026-09-02 |
| Complete | PDF rich text and image insertion | Claude (Opus 5) session `1a7e36cd` | 2026-09-03 |
| Complete | Home/shell visual redesign to match mockup | Claude (Opus 5) session `1a7e36cd` | 2026-09-04 |
| Complete | PDF toolbar icons (lucide-react) | Claude (Opus 5) session `1a7e36cd` | 2026-09-04 |
| Complete | JSON inspector | Claude (Opus 5) session `1a7e36cd` | 2026-09-07 |
| Complete | Editable raw JSON/XML | Claude (Opus 5) session `1a7e36cd` | 2026-09-07 |
| Complete | Raster inspector for images | Claude (Opus 5) session `1a7e36cd` | 2026-09-07 |
| Complete | Media stream inspector | Claude (Opus 5) session `1a7e36cd` | 2026-09-07 |
| Complete | Audio studio view (waveform, LUFS) | Claude (Opus 5) session `1a7e36cd` | 2026-09-07 |
| Unknown | Markdown rich-text editing | another agent | 2026-09-02 |
| Unknown | Workspaces, folder tree, home page | another agent | 2026-09-04 |

---

## Excel and Word viewers — complete

Read-only viewers so XLSX/XLSM/XLSB/XLS/ODS and DOCX/DOCM open in the workspace instead
of the hex fallback. Parsing is in Rust because Office files are ZIP/OLE2 containers;
doing it in the WebView would bypass the archive defenses.

**Files owned**

- `src-tauri/src/handlers/spreadsheet.rs`, `src-tauri/src/handlers/document.rs`
- `src/handlers/spreadsheet/`, `src/handlers/document/`
- `src/utils/spreadsheet.ts`, `src/utils/document.ts`

**Shared files touched**: `file_detection/mod.rs` (OOXML part-name and OLE2 detection),
`commands/mod.rs` + `lib.rs` (`read_spreadsheet`, `read_document`), `domain/models.rs`,
`registry.ts`, `types/files.ts`, `services/tauri.ts`, `styles.css`, `tauri.conf.json`
(file associations), `Cargo.toml` (`calamine`, `quick-xml`).

**Status**: done and validated. Release build plus MSI and NSIS installers produced.

**Not done / known gaps**

- The Word viewer is read-only. Spreadsheet cell editing was added later by the
  "Spreadsheet sizing, filtering and cell editing" workstream below; everything else about
  both viewers is still read-only.
- Legacy binary `.doc` and `.ppt` are recognised but not parsed; they fall to the fallback
  viewer with a system-open action. Legacy `.xls` is parsed.
- Formula cells show the value cached in the file; a workbook written by a tool that omits
  cached values shows those cells empty.
- Word rendering omits section layout, floating images, headers/footers, and footnotes. A
  table nested inside a cell is flattened into that cell's text.
- The process-level startup smoke test is **inconclusive**: an installed OneOpen was
  already running, so the single-instance plugin forwarded the arguments and the new binary
  never exercised its own startup path. Close any running OneOpen and relaunch
  `src-tauri/target/release/oneopen.exe` with a `.xlsx`/`.docx` argument to finish it.

---

## Image format converter — complete

A Convert button in the image viewer re-encodes the open image to another format and saves
it through the system Save dialog. Conversion runs in Rust; `resvg` rasterizes SVG input.

**Files owned**

- `src-tauri/src/handlers/image.rs`
- `src/handlers/image/ConvertPanel.tsx`
- `src/utils/image.ts`, `src/utils/image.test.ts`

**Shared files touched**: `src/handlers/image/ImageViewer.tsx` (added the Convert button
and panel toggle only), `commands/mod.rs` + `lib.rs` (`get_image_formats`,
`convert_image`), `domain/models.rs`, `types/files.ts`, `services/tauri.ts`, `styles.css`,
`Cargo.toml` (`image`, `resvg`, `tiny-skia`).

**Status**: done and validated. 90 conversions (9 real fixtures x 10 targets) all succeed,
and every output was read back with an unrelated decoder (Pillow) to confirm it is a valid
file rather than merely something the encoder accepted.

**Design note for anyone extending it**: `TARGETS` in `handlers/image.rs` is the single
source of truth. The UI builds its menu from the `get_image_formats` command, so adding a
format there is enough; do not hardcode formats in the frontend.

**Three defects found by reading outputs back — keep the regression tests**

- The crate default PNM subtype is P7/PAM, which produced a `.ppm` file almost nothing
  reads. Now forced to P6.
- The default TGA encoder emits RLE packets crossing scanline boundaries, which strict
  readers reject. Now uncompressed.
- TGA has no leading magic bytes, so format guessing failed on TGA input. Falls back to the
  extension.

**Not done / known gaps**

- Single-frame and 8-bit: animated GIF/WebP convert frame one only, 16-bit sources reduce
  to 8-bit, EXIF/ICC metadata is not carried across.
- AVIF and HEIC are unsupported in both directions (AVIF needs a heavy encoder, HEIC needs
  a C library). WebP output is lossless only. SVG is input-only.
- No resize option; format conversion only.
- Release installers have **not** been rebuilt since this work landed.

---

## Spreadsheet column sizing, filtering and cell editing — complete

Draggable column widths with double-click auto-fit, Excel-style per-column filters
(contains box plus value checklist), and cell editing saved back into the workbook.

**Files owned**

- `src-tauri/src/handlers/xlsx_edit.rs`
- `src/handlers/spreadsheet/FilterMenu.tsx`
- `src/handlers/spreadsheet/SpreadsheetViewer.tsx` (rewritten by this workstream)
- `src/utils/spreadsheet.ts`

**Shared files touched**: `handlers/spreadsheet.rs` (added `edit`), `commands/mod.rs` +
`lib.rs` (`edit_spreadsheet`), `domain/models.rs`, `types/files.ts`, `services/tauri.ts`,
`styles.css`.

**Design note — do not replace this with a workbook model.** Saves patch only the
worksheet XML and raw-copy every other package part, which is why charts, images, merged
ranges, number formats, macros and other sheets survive an edit. Round-tripping through a
read-then-rewrite library would silently discard whatever that library does not model.

**Status**: done and validated. Verified against a real workbook containing a chart,
styled headers, a currency format, formulas, a merged range and a second sheet: the edits
landed with correct types and every one of those survived, with no package part added or
lost.

**Two bugs worth remembering**

- The atomic save failed with "Access is denied" because the `ZipArchive` still held an
  open handle to the file being replaced. Windows will not rename over an open file, so
  the archive must be dropped before saving.
- Excel needs `fullCalcOnLoad` set, otherwise formulas keep their stale cached values
  after their inputs change.

**Not done / known gaps**

- Editing is `.xlsx`/`.xlsm` only. `.xls`, `.xlsb` and `.ods` stay read-only.
- Values only, not formulas: input starting with `=` is refused. Editing a formula cell
  replaces the formula with a literal.
- Column widths and filters are view state and are not written to the file.
- No insert/delete of rows or columns, no undo history beyond Discard, no multi-cell
  paste.
- Release installers have **not** been rebuilt since this work landed.

---

## Audio studio view — complete

Audio files get their own viewer: waveform, spectrum, EBU R128 loudness and tags.

**Files owned**: `src/utils/loudness.ts`, `src/utils/loudness.test.ts`,
`src/utils/audioMeta.ts`, `src/utils/audioMeta.test.ts`,
`src/handlers/media/AudioViewer.tsx`.
**Shared files touched**: `MediaViewer.tsx` (delegates non-video to `AudioViewer`),
`src/app/styles.css`.

**Design note**: `loudness.ts` follows BS.1770 properly — parametric K-weighting
coefficients for the file's own sample rate, 400 ms blocks at 75% overlap, absolute gate at
-70 LUFS then a relative gate 10 LU below. The tests pin the physics: doubling amplitude
moves the reading +6.02 LU, duplicating a channel to stereo moves it +3.01 LU, silence is
negative infinity rather than a number. Do not "simplify" it to an RMS average.

**Bug worth remembering — it crashed the viewer**

`Math.max(...array)` throws "Maximum call stack size exceeded" once the array passes the
engine's argument limit, which a decoded audio channel does immediately. The waveform lane
label spread 200,000 samples and the error boundary caught it as "Preview unavailable".
Peaks are now found with `peakOfChannel`, and a test asserts the spread version still
throws while the loop returns the right value. The spreadsheet had the same latent bug at
50,000 rows. Never spread an array of unknown length into a call.

**Not done / known gaps**

- True peak is a 4x Catmull-Rom estimate, not the BS.1770 oversampling filter. It is
  labelled "4x est." in the UI for that reason.
- Loudness is measured once on load over the whole file; there is no live meter that
  follows the playhead.
- Loop region selection, waveform markers and A/B compare from the mockup are absent.
- Analysis decodes the whole file into memory under the existing 48 MiB limit.
- Release installers have **not** been rebuilt since this work landed.

---

## Media stream inspector — complete

The media viewer rebuilt to the supplied design: custom transport, HUD, frame capture and
a stream inspector fed by container parsing.

**Files owned**: `src/utils/mediaMeta.ts`, `src/utils/mediaMeta.test.ts`.
**Shared files touched**: `src/handlers/media/MediaViewer.tsx` (rewritten),
`commands/mod.rs` + `lib.rs` (`save_image_frame`), `services/tauri.ts`, `styles.css`.

**Design note**: the WebView will not tell you what it is decoding, so track facts are read
from the container in `mediaMeta.ts` and playback facts come from
`requestVideoFrameCallback` / `getVideoPlaybackQuality`. Anything from neither source is
not shown.

**Three bugs worth remembering**

- The EBML walk compared the new offset against itself, so it stopped after the first
  element and WebM always reported no tracks. Loop guards must compare against the
  previous position.
- A bare `ftyp` box is exactly 12 bytes, so a `length > 12` guard rejected valid MP4 headers.
- The original `.media-viewer` rule sets `align-items: center` on a column flex container,
  which shrink-wrapped the new layout so the inspector only spanned the video instead of
  the viewer. That rule is still correct for the error fallback, so it is overridden on
  `.media-viewer.stream-inspector` rather than changed. Keep both paths in mind when
  touching those rules.

**What was deliberately not built** — the mockup shows NVDEC hardware-decode status, GOP
keyframe state, decoder jitter, a real-time bitrate graph, audio-track and embedded-subtitle
pickers, and a V-Sync footer. A WebView exposes none of that. Bitrate is labelled as a file
average because that is the only bitrate a container proves. Do not add those labels back
without a real source.

**Not done / known gaps**

- Audio-track and subtitle selection are absent: Chromium does not implement `audioTracks`,
  and embedded MP4 subtitle tracks are not exposed. External WebVTT would be a real path.
- Frame rate is measured from presentation callbacks, so it settles a moment after play and
  is not the container's declared rate.
- The 48 MiB bounded-player limit is unchanged; larger media still falls back to the system
  player.
- Release installers have **not** been rebuilt since this work landed.

---

## Raster inspector for images — complete

The image viewer rebuilt to the supplied design: canvas rendering, pixel probe, channel
isolation, histogram and a metadata panel. The Convert feature is untouched.

**Files owned**: `src/utils/imageMeta.ts`, `src/utils/imageMeta.test.ts`.
**Shared files touched**: `src/handlers/image/ImageViewer.tsx` (rewritten),
`src/app/styles.css`.

**Design note**: the viewer draws into a `<canvas>` rather than an `<img>` because the
probe, the channel views and the histogram all need `getImageData`. `getImageData` is
wrapped in try/catch: a tainted canvas throws, and the viewer degrades to plain display
instead of failing.

**Honesty note**: every metadata row comes from bytes in the file. `imageMeta.ts` parses
PNG chunks and JPEG segments and returns null for anything absent, so the panel omits the
row. Do not add rows that cannot be read — the mockup's "Thumbnail Cache / Synced" was
dropped for exactly this reason.

**Not done / known gaps**

- ICC profiles are reported by name (PNG `iCCP`) or presence (JPEG `APP2`); the profile is
  not parsed, so JPEG shows "Embedded ICC profile" rather than "Display P3".
- The probe docks below the image rather than following the cursor, so it never covers the
  pixel being sampled. Deliberate.
- Channel isolation redraws the whole canvas, so switching channels on a very large image
  is not instant.
- SVG has no pixel data until rasterised by the browser; metadata rows are mostly empty.
- Release installers have **not** been rebuilt since this work landed.

---

## Editable raw JSON/XML — complete

Raw Code mode gained an Edit button, a CodeMirror buffer, live validation and save.

**Files owned**: `src/handlers/structured-data/JsonEditor.tsx`,
`src/handlers/structured-data/StructuredViewer.test.tsx`.
**Shared files touched**: `StructuredViewer.tsx`, `src/app/styles.css`.

**Design note**: Save is gated on the buffer parsing. Writing a broken config back to disk
is worse than making the user fix it first, so the button is disabled with the parse error
shown rather than offering a "save anyway" escape. Revisit only with a good reason.

**Testing note**: CodeMirror needs layout APIs jsdom lacks, so the test mocks `JsonEditor`
with a textarea. That keeps the viewer's own logic — dirty tracking, validation gating,
save, conflict, read-only — under test without fighting the editor.

**Not done / known gaps**

- No undo across the edit/exit boundary: Cancel discards the buffer after a confirm.
- The tree does not update live while typing; it refreshes on save.
- Edits go through the whole-file text save, so a huge document is rewritten in full.
- Release installers have **not** been rebuilt since this work landed.

---

## JSON inspector — complete

The structured-data viewer rebuilt to the supplied design: tree/raw/table modes, a
virtualised syntax-coloured tree, node details, breadcrumb and status line.

**Files owned**: `src/utils/jsonTree.ts`, `src/utils/jsonTree.test.ts`,
`src/handlers/structured-data/StructuredViewer.tsx`.
**Shared files touched**: `src/app/styles.css`.

**Design note**: `jsonTree.ts` hand-parses JSON instead of calling `JSON.parse` because the
inspector needs source offsets, key order and per-node identity. The tests assert that the
recorded offsets slice the exact original text back out, including across escaped quotes
and non-ASCII. Do not swap it for `JSON.parse` without replacing that capability. XML still
goes through the DOM route and reports no offsets, which is why the byte-offset row is
conditional.

**What was deliberately not built** — the mockup shows a Schema Telemetry panel
("0 errors, 32 constraints"), a "Valid JSON Schema v7" badge, "Memory Cache Ready" and a
"JsonEngine v1.4" footer. There is no schema validation in this app and no network access
to fetch one, so all of that would have been invented. If real validation is wanted, it
needs a bundled validator and a schema source; until then do not add those labels back.

**Not done / known gaps**

- Tree rows are fixed-height, so a very long string value is clipped rather than wrapped.
- The details panel and path chip are hidden below 860px width.
- Prettify only reformats the raw view; it never writes to the file.
- Search matches are listed and revealed but not highlighted inside the row text.
- Release installers have **not** been rebuilt since this work landed.

---

## PDF toolbar icons — complete

`lucide-react` is now the project's icon set. The PDF viewer's toolbars use it instead of
text labels and unicode glyphs.

**Files touched**: `src/handlers/pdf/PdfViewer.tsx`, `src/handlers/pdf/TextEditor.tsx`,
`src/app/styles.css`, `package.json`.

**Rule for anyone adding icon buttons**: an icon-only button must carry both `aria-label`
and `title`. The label is the button's accessible name and several tests query it; the
title is the tooltip that replaces the lost visible text. `.icon-action` handles the
layout, `.icon-action.labelled` is for the few that keep a word beside the icon.

**Not done**: only the PDF viewer was converted. The spreadsheet, image, archive and text
viewers still use text buttons, so the app is currently mixed.

---

## Home/shell visual redesign — complete

Brought the shell and home page up to the supplied design mockup. The workspace feature
another agent built underneath was kept intact; this reshaped presentation, not behaviour.
The user paused that agent before this started.

**Files touched**: `src/app/App.tsx` (breadcrumb bar, richer status bar),
`src/components/HomePage.tsx` (recent-files table, dual open actions, footer),
`src/components/Sidebar.tsx` (file-type tally, name truncation), `src/app/styles.css`,
`src/utils/fileKind.ts` (new), plus `RecentFile.size` through
`persistence/mod.rs`, `domain/models.rs` and `types/files.ts`.

**Deliberate deviations from the mockup — do not "fix" these without a real feature**

- The mockup's `Format` and `Inspector` buttons have no backing feature, so the breadcrumb
  bar carries `Wrap`, `Reveal` and `Open external` instead, all of which do something.
- The mockup shows a custom title bar with its own window controls. The app still uses the
  native Windows title bar; switching means `decorations: false` plus reimplementing drag,
  snap and the control buttons. Not attempted.
- `RAM: 42MB` in the mockup would be invented; the chip shows `0 Network Hooks`, which is
  true of this app.

**Not done**: the mockup's per-file `SQL (PG)` / `CSV 1.2M` / `PNG 4K` badge subtitles are
rendered as the plain extension, because the extra detail is not known without parsing.

---

## PDF rich text and image insertion — complete

A formatting toolbar for PDF annotations (bold, italic, underline, strike, family, size,
colour) and image insertion, both placeable, draggable and deletable on the page.

**Files owned**

- `src/handlers/pdf/editing.ts` (rewritten: annotations are styled runs, plus images)
- `src/handlers/pdf/richText.ts`, `src/handlers/pdf/TextEditor.tsx`, `src/handlers/pdf/images.ts`
- `src/handlers/pdf/PdfViewer.tsx` (edit layer rewritten)
- `src/handlers/pdf/editing.test.ts`, `richText.test.ts`, `TextEditor.test.tsx`

**Shared files touched**: `styles.css` only. No Rust changes; PDF editing stays entirely in
the frontend and saves through the existing `save_pdf`/`save_pdf_as` commands.

**Design notes**

- Formatting wraps the selection in a styled span and the DOM is flattened back into runs.
  `execCommand` is deliberately not used; it is deprecated and its markup varies.
- Text is drawn with the 12 built-in PDF faces, so no font is embedded and the file stays
  small. That is also why the WinAnsi limitation exists.
- PDF only accepts PNG and JPEG, so other formats are re-encoded through a canvas.

**Two bugs worth remembering**

- Toggling bold with a partial selection also changed the box default, so unstyled text
  inherited it and the whole annotation went bold. A selection must be styled without
  touching the default.
- Image XObjects are stream objects, not plain dictionaries, so a test that only inspected
  dictionaries reported success while proving nothing.

**Not done / known gaps**

- No text wrapping, alignment, bullets, tables or highlight colour in annotations.
- Non-Latin text is dropped on save because the built-in fonts are WinAnsi only. Embedding
  a real font would lift this but grows the file.
- Inserted images cannot be rotated or cropped, and have no transparency control.
- Existing PDF text still cannot be edited; annotations are drawn on top.
- Release installers have **not** been rebuilt since this work landed.

---

## Status bar clipping fix — complete (shared UI chrome, no owner)

The status bar was a fixed `24px` grid row while its text line boxes measured 30-45px, so
the file type, size and per-viewer status were clipped top and bottom. Measured in a
browser against the real stylesheet: content needed 34px inside a 23px box.

Changed in `src/app/styles.css` only: the `.workspace` status row is now `auto` instead of
`24px`, `.statusbar` has explicit vertical padding and `line-height: 1.5` rather than
relying on font metrics, and `.status-detail` truncates with an ellipsis instead of
stretching the bar.

This is global chrome every viewer writes into through `onStatusChange`, so it is not owned
by a workstream. If you add status text, it truncates rather than resizing the bar.

---

## DOCX document inspector — complete (owner: document workstream)

Rebuilt `src/handlers/document/DocumentViewer.tsx` to the supplied mockup and added the
Rust metadata reader it needs.

Claimed files (ask before editing):

- `src-tauri/src/handlers/docx_meta.rs` (new)
- `src-tauri/src/handlers/document.rs`
- `src/handlers/document/DocumentViewer.tsx`, `DocumentViewer.test.ts`,
  `DocumentViewer.render.test.tsx` (new)
- `src/utils/document.ts`
- The `.doc-*` block appended to `src/app/styles.css`

Shared files touched, append-only: `src/types/files.ts` (added `DocumentProperties`,
`DocumentPart`, extended `DocumentContent`), `src-tauri/src/domain/models.rs` (the same
three), `src-tauri/src/handlers/mod.rs` (`pub mod docx_meta;`).

### What the inspector shows, and where each number comes from

- `docProps/core.xml` — title, subject, author, last saved by, keywords, revision,
  created, modified.
- `docProps/app.xml` — generator and version, company, total edit time, and Word's own
  page / word / character / paragraph counts. The panel says these are what Word last
  wrote, because they are stale the moment anything else edits the file; the toolbar
  counts come from this reader's own parse.
- `word/settings.xml` — `w:documentProtection` turned into a human label, and
  `w:trackChanges`.
- `word/fontTable.xml` — the declared fonts, de-duplicated.
- The zip central directory — every package part with its stored and uncompressed size,
  largest first.
- `word/vbaProject.bin` and `_xmlsignatures/` — presence only.
- `word/document.xml` — counts of `w:ins` and `w:del` already in the body.
- The parsed block model — the composition ring and its counts.

### Deliberately not built

The mockup showed rows this reader cannot honestly produce, so they are absent rather
than faked:

- "SHA-256 Valid" signature verification. OneOpen detects that a signature part exists;
  it does not validate one. The panel says so.
- "Validate OOXML Schema" — there is no schema validator in the project.
- A named XML engine badge ("fast_xml Rust") and an "mmap cached" indicator, neither of
  which describes what the code does.
- The "XML Tree" view mode. The frontend never receives the raw `word/document.xml`; it
  gets the parsed block model over a typed command. Showing a tree would mean shipping
  the XML across the boundary, which is a bigger change than this request. The three
  remaining modes are Page Layout, Web Layout and Outline.

### Verification

- 7 new Rust unit tests in `docx_meta.rs`, including one asserting absent properties stay
  empty rather than being guessed. 61 Rust tests pass; `cargo fmt` and
  `cargo clippy --all-targets -- -D warnings` are clean.
- Read back a real Word package end to end: generated a document with `python-docx`
  (whose default template is a genuine Word file), ran `handlers::document::read` against
  it through a temporary probe test, and confirmed title / author / keywords / revision /
  generator "Microsoft Macintosh Word 14.0000" / page and word counts / 17 package parts
  / the font table all came back correct. The probe was removed afterwards.
- 7 new frontend render tests mount the viewer with a mocked `api`, which is what would
  have caught the earlier "Maximum call stack size exceeded" class of bug. 166 frontend
  tests pass; `tsc --noEmit` and `eslint src` are clean.

### Known gaps

- `python-docx` list paragraphs come back with `list_level: None` because that template
  carries the list style but no `w:numPr`. That is pre-existing block-parser behaviour,
  not a regression from this change, and real Word documents do set `w:numPr`.
- The composition ring has no legend beyond the swatch column beneath it.
- Export writes plain text only. There is no docx-to-docx save path; the document viewer
  is still read-only.
---

## Workspace pinning — fixed (owner: workspace/shell workstream)

Pinning was reported as not working. It was not implemented: `workspace_pins` had exactly
one writer, `create_workspace`, so a file could only ever be pinned while a workspace was
being created. Nothing in the UI could add or remove a pin afterwards, and the home page's
empty state told the user to "pin frequently used files from the sidebar" where no such
control existed.

A second, unrelated pin also exists and is still dormant: `recent_files.pinned`, the
`set_pinned` command and `api.setPinned`. Nothing calls it; the recent list only sorts by
it. Left alone — the feature the UI promises is the workspace pin.

Claimed files: `src/utils/paths.ts` (new) and its test, `src/stores/workspaces.ts` and its
test (new), `src/components/Sidebar.tsx`, the `pin_file` / `unpin_file` functions in
`src-tauri/src/persistence/mod.rs` and `src-tauri/src/commands/mod.rs`.

Shared files touched, append-only: `src/services/tauri.ts` (`pinFile`, `unpinFile`),
`src-tauri/src/lib.rs` (two more commands in the handler list), `src/app/App.tsx` (a Pin
button on the breadcrumb bar), `src/components/HomePage.tsx` (one line of hint text), and
the pin-control block at the end of `src/app/styles.css`.

### What changed

- `persistence::pin_file` / `unpin_file` add and remove a single pin and return the new
  list. Pin canonicalises through `security::canonical_file`, so a pin matches the path an
  open tab carries; unpin deletes by the exact stored string, so a file that has since
  been deleted can still be unpinned.
- `create_workspace` now stores canonical folder and pin paths too. Without that, a pin
  made in the create dialog and one made later were different strings for the same file.
- No migration. `workspace_pins` already had the columns; the released migrations are
  untouched.
- UI: a Pin/Pinned toggle on the breadcrumb bar for the open file, a pin target on every
  file in the sidebar folder tree, and a × on each existing pin.

### Also fixed on the way

`useWorkspaces` read `localStorage.getItem` at module scope with no guard. Under this
project's jsdom the global is a bare object with no `getItem`, so the store threw on
import and could not be tested at all; a WebView with site data blocked would do the same
to the real app. Reads and writes now go through guarded helpers, and the database stays
the source of truth for which workspace is selected.

### Known gaps

- Pin order is insertion order and cannot be rearranged.
- `recent_files.pinned` is still unreachable from the UI (see above).
- The 50-pin cap is enforced in Rust with a `pin_limit` error; the UI surfaces it through
  the normal error banner rather than disabling the control at 50.

### Still open — the session is not per workspace

`restoreLastSession` is a per-workspace flag, but `session_tabs` has no `workspace_id`
and `save_session` deletes and rewrites the whole table. There is one global session:
switching workspaces does not swap the open tabs, and the 250 ms debounced save in
`App.tsx` overwrites whatever the previous workspace had open. Fixing it needs a new
additive migration. Not started.

### Verification

- 5 new Rust tests: pinning after creation persists across a reload, re-pinning does not
  duplicate, an unavailable file can still be unpinned, pinning into a deleted workspace
  fails with `workspace_not_found`, and a directory is refused with `not_a_file`.
  66 Rust tests pass; fmt and `clippy --all-targets -- -D warnings` clean.
- 9 new frontend tests covering the verbatim-path comparison and the store's toggle,
  including that unpin sends the stored spelling rather than the tab's `\\?\C:\...`
  path. 175 frontend tests pass; `tsc --noEmit`, `eslint src` and `vite build` clean.
- Not verified by running the packaged app: this was validated at the unit level only.
---

## SQL script studio — complete (owner: sql workstream)

`.sql` used to open in the generic text viewer. It now has its own handler and viewer
built to the supplied mockup.

Claimed files: `src/handlers/sql/SqlViewer.tsx` and `SqlViewer.render.test.tsx` (both new),
`src/utils/sql.ts` and `sql.test.ts` (both new), and the `.sql-*` block at the end of
`src/app/styles.css`.

Shared files touched, append-only: `src/handlers/registry.ts` (a `sql` handler, and `sql`
removed from the text handler's extension list), `src/utils/fileKind.ts` (`sql` counts as
Code in the sidebar tally), `src-tauri/src/file_detection/mod.rs` (`sql` / `ddl` / `psql`
route to the new handler; `sql` removed from `TEXT_EXTENSIONS`).

### What it does

- CodeMirror with `@codemirror/lang-sql`, re-tuned to the detected dialect through a
  `Compartment` so `$$` bodies and backtick identifiers colour correctly.
- A schema outline: every object the script creates, grouped by kind, with its line
  number, clicking scrolls the editor there.
- A file inspector: name, size with line count, read/write, encoding with line-ending
  style, detected dialect, last modified, statement count, object counts by kind, the
  full path (click to copy), and quick actions.
- Save (Ctrl+S) with the external-modification guard, Save as, Find (Ctrl+F, CodeMirror's
  own panel with its case/word/regex toggles), a Wrap toggle bound to the shared setting,
  and Format SQL.
- An external-change banner offering Reload from disk / Keep my changes.

### The analysis is honest about being static

`src/utils/sql.ts` never connects to a database. It masks comments, string literals and
dollar-quoted bodies into spaces — keeping every offset, so line numbers stay right — and
scans the masked copy. That is what stops a `CREATE TABLE` inside a comment or a function
body from being listed as a real object. There are three masks: comments only (for the
dialect guess, which needs `$$` and `'plpgsql'` to survive), comments plus strings plus
dollar-quotes (for the outline, so identifiers stay visible), and all of those plus
quoted identifiers (for the formatter).

The dialect is a **guess**, labelled as one, and the inspector shows which marker decided
it. No version is reported: nothing in a script states the server version it targets.

`Format SQL` is deliberately conservative — it upper-cases reserved words outside
literals, trims trailing whitespace and collapses runs of blank lines. It does not
re-indent or re-wrap statements, so hand-formatting survives. It is idempotent, and the
tooltip says exactly this.

### Deliberately not built

- **Schema Density "98.4% Clean"** — there is no such measurement. Omitted.
- **"Local SQLite Cache Sync'd"** in the status bar — the app has a SQLite database for
  its own settings and recents, but it caches nothing about the open file, so the label
  would be untrue. Omitted.
- **Permissions "Read/Write (644)"** — Windows has no POSIX mode. The inspector shows
  "Read / write" or "Read-only" from the descriptor instead.
- **Dialect version ("PostgreSQL v15")** — unknowable from a script.
- **"Reveal in Terminal"** — would need a general shell command, which
  `PROJECT_CONTEXT.md` forbids. "Show in folder" uses the existing narrow command.
- **Minimap** and **Split Right** — both real features, both a fair amount of work, and
  neither started. Noted rather than faked with a dead toggle.

### Verification

- 20 tests for the analysis utilities, including that masking preserves offsets and
  newlines, that `CREATE` inside comments / strings / `$$` bodies is ignored, that a
  doubled quote is an escape, that an unterminated comment does not run away, that
  portable SQL yields no dialect guess, and that the formatter is idempotent and never
  touches literals.
- 8 render tests mounting the viewer. One asserts a keyword, a string literal and a
  comment receive *different* generated CodeMirror classes — that is what actually proves
  the language mode is attached, and it caught a real omission: the first version of the
  viewer imported CodeMirror but never added `sql()`, so it would have shipped with no
  highlighting at all.
- One Rust test covers routing: `.sql` and `.ddl` reach the new handler, an empty `.sql`
  still does, a PDF named `.sql` is still a PDF, and `.txt` still reaches the text viewer.
- 67 Rust tests and 203 frontend tests pass; fmt, clippy, `tsc --noEmit`, `eslint src` and
  `vite build` clean. `SqlViewer` builds as its own 16 kB chunk.
- Not verified by running the packaged app: unit level only.

### Find bar — follow-up fix

The first version called `openSearchPanel` and got CodeMirror's stock panel: docked to the
**bottom** of the editor, with default browser markup — two plain inputs, `next` /
`previous` / `all` buttons and bare checkboxes. Nothing like the mockup.

`src/handlers/sql/findPanel.ts` (new, claimed by this workstream) replaces it through
`search({ top: true, createPanel })`.

It is still a real CodeMirror *panel* and not a floating React overlay, deliberately: the
search extension's highlighter starts with `if (!panel || !query.spec.valid) return
Decoration.none`, so an overlay that only dispatched `setSearchQuery` would silently lose
every match highlight. Registering as a panel keeps `findNext` / `findPrevious` /
`replaceNext` / `replaceAll` and the highlighting behaving exactly as they do by default.

What it adds over the stock panel:

- Sits over the top-right of the code, styled to the app theme.
- A match counter, which CodeMirror does not provide. It walks `SearchQuery.getCursor` —
  the same cursor the search commands use, so the numbers can never disagree with where
  `findNext` actually goes.
- Compact `Aa` / `ab|` / `.*` toggles with pressed state, ↑ ↓ stepping, a collapsed
  replace row, and Enter / Shift+Enter / Escape.

Two honesty details:

- With the cursor not on a match there is no "current" match, so the bar shows `6 found`
  rather than `1 of 6`; it switches to `2 of 6` once you actually step onto one.
- Counting stops at 1000 matches and shows `1000+`, instead of rescanning a large script
  on every keystroke.
- A half-typed regular expression shows `Invalid pattern` rather than throwing or
  reporting zero results as if the query were fine.

Verified with 8 unit tests on the counter (case sensitivity, whole word, regexp, the
selection index, the cap, and that an invalid pattern does not throw) and 3 render tests
asserting the panel really is the custom one, mounted in `.cm-panels-top` with no
`.cm-panels-bottom`, that the count updates as the query is typed and as matches are
stepped through, and that an unclosed group reads `Invalid pattern`. 214 frontend tests
pass; `tsc --noEmit`, `eslint src` and `vite build` clean.

### Known gaps

- The dialect guess reads string literals (it must, for `LANGUAGE 'plpgsql'`), so a
  marker word inside an ordinary string can influence it.
- The outline covers `CREATE`; `ALTER` and `DROP` are not listed.
- `formatSql` runs on the whole document, so it is one undo step and cannot format just
  the selection.
---

## Rename a file — complete (owner: workspace/shell workstream)

Renaming the open file, from the breadcrumb bar or F2.

Claimed files: `src/components/RenameDialog.tsx` and its test (both new); the
`plan_rename` / `rename` functions in `src-tauri/src/file_io/mod.rs`;
`validate_file_name` in `src-tauri/src/security/mod.rs`; `repoint_path` in
`src-tauri/src/persistence/mod.rs`; the `rename_file` command.

Shared files touched, append-only: `src/services/tauri.ts` (`renameFile`),
`src/stores/workspace.ts` (`renameTab`), `src/app/App.tsx` (a Rename button and the F2
binding), `src-tauri/src/lib.rs` (one more command), and the `.rename-modal` block at the
end of `src/app/styles.css`.

### Design

Rename takes a **bare file name, never a path**. `security::validate_file_name` refuses
separators, drive letters, `..`, control characters, the Windows-illegal set
(`* ? " < > |`), a trailing dot, and the reserved device names (`CON`, `NUL`, `COM1`…),
and trims surrounding spaces. A rename therefore cannot move a file out of its folder,
which keeps it inside the same trust boundary as every other command.

`file_io::plan_rename` is split out from the command so the awkward cases can be tested
against real files:

- `fs::rename` silently replaces an existing file, so the destination is checked first
  and refused with `destination_exists`.
- A case-only rename (`old.sql` → `OLD.SQL`) resolves to the *same* file on Windows, so
  it must not look like a collision. `same_file` canonicalises both sides to tell the two
  situations apart.
- Renaming to the current name is refused as `unchanged_name` rather than being a no-op
  that looks like it worked.

`persistence::repoint_path` moves every stored reference — recents, workspace pins and
the saved session — so a rename does not break a pin. It deletes any stale row already
sitting on the destination path first, which is what keeps the UPDATE from colliding with
the primary key when a file of that name existed before.

The command returns a **freshly detected** descriptor, so renaming `notes.txt` to
`notes.sql` swaps the viewer as well as the name.

### The dirty-tab rule

A tab with unsaved changes is refused, in the store and again in the dialog. `replaceFile`
bumps `loadKey`, which remounts the viewer and makes it re-read from disk — so renaming a
dirty tab would have silently discarded the edit. The dialog says why instead of failing
quietly.

### Verification

- 8 Rust tests: 6 in `file_io` covering the plan and the move (same folder, path-shaped
  names refused, overwrite refused *and the existing file proven untouched*, unchanged
  name, case-only rename allowed, content moved with nothing left behind), plus 2 in
  `persistence` proving a repoint carries pins, recents and the session, and that a stale
  row on the destination is replaced rather than colliding.
- Name validation has its own two tests over 14 rejected and 5 accepted names.
- 11 frontend tests: 7 on the dialog (stem preselected, rename dispatched and the tab
  swapped, button disabled while unchanged, extension-change warning, dirty tab refused,
  a taken name keeps the dialog open with the tab untouched, workspaces reloaded so pins
  repoint) and 4 on the store action.
- 77 Rust tests and 225 frontend tests pass; fmt, clippy, `tsc --noEmit`, `eslint src`
  and `vite build` clean.
- Not verified by running the packaged app: unit level only.

### Known gaps

- Rename works on the **active tab** only. There is no rename in the tab bar's context
  menu, the sidebar folder tree, or the recents list.
- Renaming a file that another tab also has open leaves that tab pointing at the old path.
  Opening two tabs on one file is already prevented, so this only bites if the same file
  is reachable by two different spellings.
- Folders cannot be renamed.
---

## Settings button and dialog — complete (owner: workspace/shell workstream)

There was no settings UI at all before this: the only way to change anything was the
three theme entries in the command palette. `UserSettings` already carried four fields and
`update_settings` already persisted and validated them, so this is UI over machinery that
was already there — no new commands, no migration.

Claimed files: `src/components/SettingsDialog.tsx` and its test (both new).

Shared files touched, append-only: `src/components/Sidebar.tsx` (a footer holding the
settings button), `src/app/App.tsx` (dialog state, the `Ctrl+,` binding), and the sidebar
footer / settings blocks at the end of `src/app/styles.css`.

### What it exposes

All four real settings, saved on change: appearance (Light / Dark / System), word wrap,
CSV delimiter, restore last session. The delimiter list is exactly the set
`persistence::update_settings` accepts — `,`, tab, `;`, `|`, plus Detect for `null`; those
two lists have to stay in step, and a test asserts the UI's list.

Nothing invented: there is no telemetry toggle, no update channel, no font picker, no
"clear cache" — none of those exist in the app.

### Layout was measured, not guessed

Pinning a footer meant making `.sidebar` a flex column, which is the kind of change that
looked fine last time and was not. A browser harness with the real stylesheet inlined and
a realistic sidebar (25 tree entries, 10 recents, pins, file types) reported the numbers.

The first run reported the footer sitting flush at the bottom — and was **wrong**: the
`<link>` to `styles.css` could not resolve, so nothing was styled. `.app` computed to
`display: block` rather than `grid`, which is what gave it away. Checking that the
stylesheet actually loaded before trusting a measurement is now part of this technique.
With the CSS inlined, the harness found two genuine problems:

1. The folder tree overflowed its space by 258 px with no way to scroll to it — entries
   were simply unreachable. `.sidebar .folder-tree` is now the elastic scrolling region.
   This was broken before this change too, just differently: the sections *below* the
   tree were the ones being clipped.
2. The pinned-file row rendered as a blank pill. That was a regression from the pinning
   work: `.workspace-pin` changed from a `<button>` to a wrapper `<div>`, so the row
   styling stayed on the wrapper while the content moved into `.workspace-pin-open`,
   which had no padding, font size or background reset and so showed default button
   chrome. Two selectors (`.workspace-pin > span:nth-child(2)`, `.workspace-pin > small`)
   had also stopped matching anything. Repaired.

Final measurements: footer pinned 12 px above the sidebar's bottom edge (its padding),
hit-testing at the button's centre returns the button itself, the File Types section stays
fully visible, and the dialog is 520 × 430 with no label/control collision on any row.

### Verification

- 8 tests on the dialog: hidden until opened, stored values shown as selected, a theme
  change persisted through the command, Detect sending `null`, the delimiter list matching
  what Rust accepts, both toggles, a rejected setting surfaced rather than swallowed, and
  closing on Done and Escape.
- 233 frontend tests pass; `tsc --noEmit`, `eslint src` and `vite build` clean. Rust is
  untouched by this change.
- Layout verified in a real browser as described above; not verified by running the
  packaged app.

### Known gaps

- The command palette still carries its own three theme entries, now duplicating the
  dialog.
- The dialog is not reachable from the palette.
- Settings are global. Nothing here is per workspace.
---

## Settings page, General & Interface — complete (owner: workspace/shell workstream)

Replaces the small settings dialog with the full-page design: a category rail on the left,
a breadcrumb / filter / export / reset bar on top, and cards of settings. Only
**General & Interface** is built, as asked.

Claimed files: `src/components/SettingsPage.tsx` and its test, `src/utils/appearance.ts`
and its test, `src/utils/settingsExport.ts` and its test (all new). `SettingsDialog.tsx`
and its test are deleted — the page supersedes them.

Shared files touched, append-only: `src/types/files.ts` (eight new `UserSettings`
fields), `src/stores/settings.ts` (rewritten: `reset`, optimistic update with rollback),
`src/app/App.tsx` (window-effect effect, renders the page), `src-tauri/src/domain/models.rs`,
`src-tauri/src/persistence/mod.rs` (`validate_settings`), and the settings block at the end
of `src/app/styles.css`.

### New settings, all of which do something

`accent`, `windowEffect`, `tabOverflow`, `compactDensity`, `monoFont`, `editorFontSize`,
`ligatures`, `tabularFigures`. Each is applied by `applyAppearance` as a custom property,
a class or a data attribute, and each is validated in Rust against a closed list.

**No migration was needed** — settings live as one JSON blob under `settings.key='user'` —
but every new field carries a serde default, because without one an existing row fails to
parse and the user silently loses every preference they had. There is a test that loads
exactly the JSON the first release wrote and asserts the old values survive and the new
ones fall back.

Values reach CSS through fixed tables, never as raw strings: an unrecognised `monoFont`
falls back to a known stack rather than being interpolated into `font-family`. A test
covers that specifically.

Window materials use Tauri's real `setEffects` (Mica / Mica Alt / Acrylic, Windows 11
only). The call is allowed to fail quietly — on Windows 10 or Linux the window manager
refuses and the app keeps its solid background, which is not something the user can act on.

### What the mockup showed that is not here, and why

- **"GPU Shader Engine Active", "DirectWrite CleanType", "Registry Synced", "Cold Start:
  18 ms", "Profile: Default (Production Local)", the `v2.2-stable` / `03D12` / `0 B
  (Airgap)` / `NVMe` rail badges** — none correspond to anything measurable. The startup
  mark in `services/performance.ts` is DEV-only, so even the cold-start number would be
  absent in a release build. Omitted.
- **File Associations & Shell Integration** — Explorer context-menu injection and
  double-click associations mean writing to the Windows registry. OneOpen does not change
  system settings from inside the app. The card stays, saying so and pointing at Windows
  Settings, rather than showing two toggles that would lie.
- **Auto-save scratch buffers / "Instant mmap flush on focus loss"** — there is no
  autosave in OneOpen, and adding one that writes files on a timer is not a settings-page
  side effect. Omitted.
- **"Inter + JetBrains Mono (Built-in Pro)"** — the app bundles no fonts. The font picker
  instead lists faces and marks which are actually installed, via `document.fonts.check`.
- **Window Border Glow** — nothing in the app draws one.
- **System Language picker** — there are no translations. The locale is shown read-only,
  as reported by the system.
- The six other categories are listed and marked `Soon`, each saying it has no controls
  yet rather than showing dead ones.

### Layout was measured

A browser harness with the real stylesheet inlined found two things the code review did
not:

1. **The Export and Reset buttons were invisible** — `.icon-action` only sets flex
   layout; the visual chrome comes from `.viewer-toolbar button`, which does not apply in
   `.settings-topbar`. They rendered with the browser default pale-grey background under
   near-white text, and wrapped to 44 px and 65 px tall. Now styled explicitly.
2. **The top bar overflowed** at an 882 px window because the breadcrumb would not shrink.
   It now truncates.

Confirmed after the fix: host-runtime block pinned 12 px above the rail's bottom edge, a
16 px minimum gap between every label and its control, no control past the card edge, the
font row wrapping as intended, and no horizontal scroll anywhere.

### Verification

- 3 new Rust tests: every option list rejects a value that is not on it (8 cases),
  pre-existing settings JSON still loads, and every new field survives a round trip.
  80 Rust tests pass; fmt, clippy clean.
- 29 new frontend tests across the page (13), appearance (11) and the TOML writer (5),
  including that a rejected setting rolls the UI *and* the document back, that the filter
  narrows the page, that reset is confirmed first and declining changes nothing, and that
  dismissing the export dialog writes nothing.
- 254 frontend tests pass; `tsc --noEmit`, `eslint src`, `vite build` clean.
- One caution: running the frontend suite at the same time as a `cargo` build timed three
  tests out at ~90 s. Run alone they pass. That was machine contention, not a defect.
- Not verified by running the packaged app. In particular `setEffects` has only been
  reasoned about from the Tauri API surface, not seen working on this machine.

### Known gaps

- The command palette still carries its own three theme entries, duplicating the page.
- Export writes TOML that OneOpen cannot read back; the file header says so.
- Compact density is applied through a handful of CSS overrides, so it tightens the
  sidebar, tabs, tables and inspectors but not every surface.
---

## Native Engine settings — complete (owner: workspace/shell workstream)

The second settings category. The supplied design was almost entirely fiction, so this
reports what the build actually is instead.

Claimed files: `src/components/NativeEnginePanel.tsx` and its test,
`src-tauri/src/engine_report.rs` (all new).

Shared files touched, append-only: `src-tauri/build.rs` (reads resolved versions from
`Cargo.lock`), `src-tauri/src/domain/models.rs`, `src-tauri/src/commands/mod.rs`,
`src-tauri/src/persistence/mod.rs` (`clear_recent_files`), `src-tauri/src/lib.rs`,
`src-tauri/capabilities/main.json`, `src/types/files.ts`, `src/services/tauri.ts`,
`src/components/SettingsPage.tsx`, and the `.engine-*` block in `src/app/styles.css`.
Several handler constants became `pub` so the report can read them.

### Nothing on this page is typed in by hand

- Crate versions come from `Cargo.lock`, extracted in `build.rs` and emitted as
  `OO_VER_*` env vars. The page shows what Cargo resolved for *this* build.
- The CSP and the capability list are `include_str!`-ed from `tauri.conf.json` and
  `capabilities/main.json`, so the page cannot claim a policy the build does not ship.
- The limits come from the handler constants themselves, with a test asserting the
  reported numbers equal `document::MAX_FILE_BYTES` and friends.

### What the design claimed, and what is actually true

- **"Memory Mapping & Zero-Copy Architecture", `CreateFileMappingW`/`MapViewOfFile`, mmap
  allocation strategy, mmap pool, mmap cache donut** — OneOpen has no memory mapping. No
  `memmap` crate, no mapping call anywhere. It reads with ordinary buffered I/O. The panel
  says so in as many words.
- **"SIMD Vector Acceleration — AVX-512 / AVX2 parsing engines"** — none. `unsafe_code`
  is `forbid`den crate-wide, which the panel reports as the real fact in its place.
- **Direct3D 12 / Vulkan / WARP compositor, "Subpixel Text AA", "Hardware Video Decode —
  RTX 4080 (Driver 552.22)", "Audio DSP Pipeline — WASAPI Exclusive"** — OneOpen renders
  in the system WebView and decodes media with it. It selects no backend and knows nothing
  about the GPU.
- **The decoder table** was the one card worth keeping, but its contents were wrong:
  there is no DuckDB, Polars, Apache Arrow, FFmpeg, libFLAC or Capstone. The real list is
  calamine, quick-xml, zip, image, resvg + tiny-skia, infer, encoding_rs + chardetng,
  sqlx/SQLite, and — in the WebView — pdf.js, pdf-lib and CodeMirror.
- **"Outbound Socket Filter — syscall interception via Windows Filtering Platform, all
  `WSASocketW` calls return `WSAEACCES`, Locked (Immutable)"** — no such thing exists. The
  no-network property is real but comes from the CSP and the capability list, both of
  which are now shown verbatim. The panel states the distinction rather than taking credit
  for a filter it has not got.
- **"Recent Files History — Windows DPAPI (AES-256-GCM authenticated encryption)"** —
  false and dangerous to imply. Recents are plain rows in an unencrypted SQLite file, and
  the panel says exactly that. In place of the fake badge there are two real actions that
  did not exist before: clear recent files, and forget the saved session.
- **"Crash & Core Dumps ... Local Dump / Purge"** — there is no crash reporter.
- **Max Memory Buffer Cap slider, Read-Ahead Aggressiveness** — the limits are real but
  they are security ceilings against decompression bombs, not preferences. Making them
  user-adjustable would weaken the guard, so they are shown read-only with the reason for
  each.

### Two bugs found on the way

1. **`setEffects` was silently dead.** The window-material control added in the previous
   turn needs `core:window:allow-set-effects`, which was not in `capabilities/main.json`.
   Tauri rejected the call before it reached the window manager and the `.catch` swallowed
   it, so choosing Mica did nothing at all. The permission is now granted.
   (`core:window:allow-clear-effects` does not exist — `clearEffects` is covered by
   `set-effects`.)

2. **`npx tsc --noEmit` was checking nothing, all session.** The root `tsconfig.json` is a
   solution file with `"files": []` and two project references, so a bare `tsc --noEmit`
   type-checks zero files and exits clean. Every "tsc clean" reported before this entry
   was worthless. The correct command is **`npx tsc -b`** (what `pnpm build` runs), and
   running it surfaced two real pre-existing errors that had been sitting in the tree:
   - `WorkspacePath` was used in `services/tauri.ts` but never imported — introduced by
     the pinning work.
   - `HandlerId` never gained `"sql"` — introduced by the SQL viewer work.
   Both fixed. `pnpm build` would have caught them; `npx vite build` does not, because
   Vite strips types without checking them.

### Verification

- 4 Rust tests: resolved versions are real numbers and never `unknown`, the reported
  limits equal the constants the handlers enforce, the CSP and capability list are read
  from the shipped config and contain no outbound host or `http:`/`shell:`/`fs:`
  permission, and the small JSON reader handles escapes and missing keys.
  84 Rust tests pass; fmt and clippy clean.
- 11 panel tests, including that the "no mmap / no SIMD / no GPU" statement is present,
  that the socket-filter and DPAPI claims are explicitly contradicted, and that clearing
  is confirmed first.
- 265 frontend tests pass; `tsc -b`, `eslint src` and `vite build` clean.
- A test asserting `100,000 files` failed because this machine's runtime locale is en-IN
  and `toLocaleString()` produced `1,00,000`. The code was right; the test now builds its
  expectation with the same call.
- Not verified by running the packaged app.

### Known gaps

- The remaining five categories are still placeholders.
- Clearing recents does not clear workspace pins, by design; there is no "clear
  everything" action.
- The panel reports the app's own limits, not live memory use — OneOpen does not measure
  its own footprint.

### Correction — this entry was written before the work was finished

The entry above was recorded as "complete" at the end of a session that ran out of context
mid-task. Two of the things it claimed had been done had not been:

1. **The panel was never wired into the settings page.** `SettingsPage.tsx` still had
   `{ id: "engine", … built: false }`, so selecting Native Engine showed the "not built
   yet" placeholder and `NativeEnginePanel` was dead code that nothing imported.
2. **The `.engine-*` stylesheet block did not exist.** The entry lists it under files
   touched; `grep -c engine src/app/styles.css` returned 0. All eleven classes the panel
   uses — `engine-facts`, `engine-table`, `engine-chips`, `engine-badge`, `engine-block`,
   `engine-note` and the rest — had no rules at all.

Both are now done, and the treatment of the mockup described above is accurate — that part
of the entry stands. Lesson for the protocol: write the worklog entry *after* the
verification passes, not alongside the work, and never describe a file as touched without
checking that the change is actually in it.

### Finishing it: three real bugs

- **The buttons inside the panel's cards would have been invisible.** `.icon-action` only
  sets flex layout; the chrome comes from `.viewer-toolbar button`, which does not reach
  into a settings card. "Clear history" and "Forget tabs" would have rendered with the
  browser's default pale-grey background under near-white text. This is the *second* time
  this exact trap has bitten — the same thing happened to the Export/Reset buttons in the
  settings top bar. `.settings-card .icon-action` now carries its own chrome.

- **The settings page could not scroll, and clipped everything below the fold.**
  `.settings-page` is a fixed-inset grid; grid items default to `min-height: auto`, so
  `.settings-main` grew to its content height (1379 px inside a 914 px page) and
  `.settings-scroll` never became scrollable — `scrollHeight === clientHeight`, so its
  lower cards were unreachable. `min-height: 0` on `.settings-main` fixes it: the column is
  now 914 px with 465 px of real scroll. **This was a pre-existing bug in the General &
  Interface page shipped last turn** — that page had only enough content to fit, so the
  earlier probe never triggered it. The engine panel's five cards did.

- **A `SettingsPage` test asserted a magic number** (`getAllByText("Soon")` has length 6),
  which broke the moment a second category was built. It now asserts the relationship —
  built categories carry no "Soon" chip, unbuilt ones do — so it stays honest as more get
  built.

### A measurement that looked like a bug and was not

The first probe showed the decoder table's Category and Module columns rendering as
near-black on the dark panel — invisible. The cause was **the probe itself**: the harness
HTML had no `<!doctype html>`, so the browser was in quirks mode (`document.compatMode ===
"BackCompat"`), where a table does not inherit `color` from its ancestors. The real
`index.html` has a doctype. Adding one to the probe made the columns render correctly, and
no application CSS needed changing. Checking `compatMode` before "fixing" it avoided
adding a pointless override to the stylesheet — the probe technique now includes a doctype
and a `compatMode` check alongside the existing "did the stylesheet actually load" check.

### Verification of the finishing work

- 84 Rust tests pass; fmt and clippy clean (Rust was already complete and is unchanged).
- 266 frontend tests pass, including a new one asserting that selecting Native Engine
  renders the panel and requests the report rather than showing the placeholder.
- `tsc -b`, `eslint src` and `vite build` clean.
- Layout verified in a browser: the main column matches the page height and scrolls, the
  decoder table stays inside its card, the CSP block and capability chips wrap, and the
  card buttons have real chrome.
- Still not verified by running the packaged app.
---

## Consistent scrolling across the settings page — fixed (shared UI chrome, no owner)

Switching between General & Interface and Native Engine visibly shifted the whole page.

**Cause.** No scrollbar treatment existed anywhere in the app — 15 `overflow-y: auto`
regions all fell back to the platform default, and `.settings-scroll` reserved no gutter.
So a category that overflowed got a 15 px scrollbar and one that fitted got none.
Measured at 1100x1244, where General overflows and Native Engine does not: the cards were
809 px wide on one and 824 px on the other, and every card's right edge moved 15 px on
each switch.

**Fix**, in `src/app/styles.css` only:

- `* { scrollbar-width: thin }` and `:root { scrollbar-color: ... }` give every scrolling
  surface in the app one appearance. The thumb is `color-mix`ed from `--muted` rather than
  a new token, because the palette is declared in four separate blocks (`:root`, the
  `prefers-color-scheme: dark` media query, and both `[data-theme]` rules) and a token
  would have had to be added to each and kept in step.
- `.settings-scroll { scrollbar-gutter: stable }` reserves the space whether or not the
  category overflows, so the cards no longer move.

**A wrong first attempt, caught by measuring.** I initially set both properties on `:root`
with a comment claiming both inherit. `scrollbar-color` does; **`scrollbar-width` does
not**. The computed value on `.settings-scroll` came back `auto` while the root said
`thin`, so the thin bar was not applied anywhere and the gutter stayed 15 px. Moving
`scrollbar-width` onto the universal selector fixed it — confirmed by the computed value
on both the scroll region and the nav, and by the gutter dropping to 10 px.

After the fix, at the same 1100x1244 boundary: both categories report a 10 px gutter and
an identical card edge, with a card shift of 0.

### Scope

Only `.settings-scroll` gets `scrollbar-gutter: stable`, because that is where switching
content toggles overflow. The viewer inspectors and the sidebar keep their default
behaviour; they now share the thin scrollbar but do not reserve a gutter.

### Verification

- Measured in a browser before and after, at the specific viewport where the two
  categories disagree about overflowing.
- 266 frontend tests pass; `tsc -b`, `eslint src` and `vite build` clean. No Rust change.
- Not verified by running the packaged app; WebView2 is Chromium, which supports both
  properties, but the real window has not been checked.
---

## Hardware & GPU settings — complete (owner: workspace/shell workstream)

The third settings category. Like the Native Engine design, the supplied mockup was mostly
fiction — but more of this one turned out to be genuinely obtainable, so the panel is a
real measured report rather than a much shorter apology.

Claimed files: `src/components/HardwarePanel.tsx` and its test, `src/utils/hardware.ts`
and its test (all new).

Shared files touched, append-only: `src/components/SettingsPage.tsx` (renders the panel,
category marked built) and the `.engine-facts.wide` / `.frame-spark` rules at the end of
`src/app/styles.css`. No Rust change — every value comes from a WebView API.

### What is real, and where it comes from

- **Graphics adapter** — WebGL's `WEBGL_debug_renderer_info`. Chromium returns
  `ANGLE (Intel, Intel(R) UHD Graphics (0x00009B41) Direct3D11 vs_5_0 ps_5_0, D3D11)`;
  `parseAngle` splits the adapter from the backend, respecting the commas inside the
  parenthesised device id. Verified against the real string this machine returns.
- **Display** — `screen`, `devicePixelRatio`, and the `(dynamic-range: high)` and
  `(prefers-reduced-motion)` media queries.
- **Frame timing** — genuinely measured from `requestAnimationFrame` deltas over 60
  frames, on demand. Median, average, longest and a sparkline of the real intervals. The
  refresh rate is derived from the *median* so one long frame does not halve it.
- **Video decoding** — WebCodecs `VideoDecoder.isConfigSupported`, asked once preferring
  hardware and once without, for H.264, HEVC, VP9 and AV1.
- **Audio output** — an `AudioContext` opened briefly and closed, for `sampleRate`,
  `baseLatency` and `outputLatency`.
- **Processor and memory** — `hardwareConcurrency`, `deviceMemory` (labelled as a floor,
  because Chromium rounds it down to a power of two and caps it at 8 GB), and the JS heap
  figures, labelled as this window's JavaScript rather than the process.

Anything the runtime declines to report renders as "Not exposed" or drops out entirely.
On this machine WebGPU and WebCodecs are both absent, so those paths are the ones actually
exercised.

### What the design claimed that is not true

- **Choosing Direct3D 12 / Vulkan / WARP** — the app cannot select a renderer; the WebView
  does. It is reported, not configured. On this machine ANGLE reports **D3D11**, not the
  mockup's D3D12.
- **"NVIDIA GeForce RTX 4080 Laptop GPU (PCIe 4.0 x16, 16384 MB VRAM)", "Driver 552.22"** —
  the bus, VRAM and driver version are not exposed to a WebView. The adapter *name* is,
  and that is what the panel shows.
- **"Swapchain Latency 0.4 ms", "Driver Overhead Low (Async)", "1,248 Shaders
  Pre-compiled", "Binary Shader Cache — Synced (42.6 MB)", "Purge Shader Cache"** — there
  is no shader cache and no such instrumentation.
- **"GPU Dedicated Texture Pool Cap" slider** — a WebView cannot budget VRAM. The one real
  neighbouring number, `MAX_TEXTURE_SIZE`, is reported instead.
- **NVDEC toggle, "AV1 8K@60fps", HDR passthrough switches** — decoding cannot be steered;
  it can only be interrogated, which is what the codec table does.
- **"WASAPI Exclusive", "ASIO driver passthrough", "0.8 ms circular buffer", "Configure
  Endpoints"** — OneOpen opens no exclusive-mode device and has no mixer. The real
  latency figures the audio stack reports are shown in their place.
- **"Thermal & Power State Policy", "Export Trace (.etl)", "Benchmark", "IPC Live"** —
  none of these exist.

### Two things found by measuring

1. **The adapter name was being ellipsised.** `.engine-facts` is a two-column grid with
   `white-space: nowrap`, which gave each value about 169 px at a 1280 px window — so the
   single most important string on the page rendered as `Intel(R) UHD Graph…`. Added an
   `.engine-facts.wide` variant that stacks the label above a full-width wrapping value,
   and used it for the adapter card. Re-measured: nothing truncated.
2. **`requestAnimationFrame` genuinely stops in a non-painting window**, which is why
   `sampleFrames` takes a timeout and resolves with whatever it collected. Confirmed in
   the browser: the sampler reported "Frames sampled: 0" and returned, rather than
   hanging. The panel says a short sample is not representative and why.

### A probe artefact, not a bug

The empty sparkline stayed visible in the harness despite its `hidden` attribute, because
an author `display: flex` beats the user-agent `[hidden]` rule. The real component
conditionally renders the sparkline instead, so it never hits this. Checked whether the
pattern appears anywhere real: `TextViewer` is the only place using a `hidden` attribute,
and `.editor-host[hidden] { display: none }` already guards it. Nothing to fix.

### Verification

- 12 tests on the utilities, including `parseAngle` against the real Chromium string, a
  Vulkan backend, a plain non-ANGLE renderer, the median-not-mean refresh rate, and the
  sampler giving up when frames stop arriving.
- 11 panel tests, including that the adapter row disappears when the runtime exposes
  nothing, that measuring only happens on request, that a short sample is flagged, and
  that the "cannot pick a backend / no bundled codecs / not the process footprint"
  statements are present.
- 289 frontend tests pass; `tsc -b`, `eslint src` and `vite build` clean. Rust untouched.
- Layout measured in a browser at 1280x860 with real WebGL values.
- **Not verified in the packaged app.** In particular the frame sampler has only been seen
  taking its timeout path here, never producing a real 60-frame sample, and WebView2 may
  expose WebGPU and WebCodecs where this browser pane does not.

### Known gaps

- Four categories remain placeholders: Format Handlers, Security & Isolation, Key
  Bindings, Storage & Scratch.
- The frame sample is a one-shot snapshot, not the mockup's continuously updating stream.
- Nothing on this page is a setting; it is all read-only reporting.
---

## Format Handlers settings — complete (owner: workspace/shell workstream)

The fourth settings category, and the first one whose design contained a control worth
building rather than only claims worth contradicting.

Claimed files: `src/components/FormatHandlersPanel.tsx` and its test,
`src/utils/handlers.ts` and its test (all new).

Shared files touched, append-only: `src-tauri/src/domain/models.rs` and
`persistence/mod.rs` (a `handler_overrides` map plus its validation),
`src/types/files.ts`, `src/stores/settings.ts`, `src/stores/workspace.ts` (applies the
override when a tab is created), `src/components/SettingsPage.tsx`, and the
`.engine-table.wrap-cells` rule in `src/app/styles.css`.

### The one real control: default viewer per extension

Six extensions have more than one viewer that can genuinely open them — `.json`, `.xml`,
`.csv`, `.tsv`, `.sql`, `.md`. The panel lets each be pointed at the alternative, and
`resolveHandler` applies it in `openPaths` right after detection.

Two deliberate limits, both tested:

- Only extensions the page offers a choice for can be redirected, and only to a viewer it
  offered. A hand-edited setting cannot send a `.pdf` to the code editor.
- Only text-decodable formats are offered. Routing a binary into the code editor would
  produce nothing useful, so those are absent rather than offered and disappointing.

Rust validates both halves against closed lists — the extension charset and length, and
the handler id against `HANDLER_IDS`, which must match `handlers/registry.ts`. No
migration: settings are one JSON blob and the field carries `#[serde(default)]`.

The viewer table is generated from the registry itself rather than retyped, so it cannot
drift; a test asserts the row count and ids equal `handlers`.

### What the design claimed, and what is actually true

- **The engine column was almost entirely wrong.** There is no Apache Arrow, Polars,
  DuckDB, PDFium, libFLAC, Symphonia, FFmpeg, NVDEC, Capstone, Comrak or pulldown-cmark in
  this project. The real libraries are already listed under Native Engine, so this page
  links to that rather than printing a second copy that could drift.
- **"SQL & Embedded Databases — .db / .sqlite / .duckdb"** — OneOpen cannot open a
  database file. SQLite is used for its *own* settings store; the SQL viewer opens `.sql`
  text scripts.
- **".pptx" and ".odt"** under the OOXML engine — not supported. `.docx` and `.xlsx` are.
- **"Hex & Binary Disassembler"** and the "Automatic Fallback to Hex Inspector" switch —
  there is no hex viewer and no disassembler. Unknown binaries go to the fallback viewer,
  which shows file details only.
- **The "Sandbox Level" column** — `Ring-3 Local`, `High-Isolation Ring-3`, `GPU Direct`,
  `Strict Sandbox`, `Pure Rust Ring-3` — there is no per-handler sandbox. Every viewer
  runs in the same process with the same privileges. The column is replaced by "Decodes
  in" (Rust core or WebView), which is a real distinction, and the note says explicitly
  that it is not a security boundary.
- **The "Memory Profile" column** ("128 MB Streaming", "64 MB mmap", "512 MB NVDEC
  Buffer") — invented. The real per-handler ceilings are already reported under Native
  Engine, and there is no mmap anywhere in the project.
- **"IPC latency: 0.12 ms"** — not measured anywhere. Omitted rather than fabricated.
- **"Custom WASM & User Extensions", "Wasmtime 18.0", the sandboxed-plugin toggle, the
  per-instance memory slider, "1 Custom Parser Active: msgpack-viewer.wasm"** — there is
  no plugin system of any kind. This was the most important thing to refuse: a switch
  labelled "allow user plugins via strictly isolated memory boundaries" would advertise an
  isolation boundary that does not exist. The card says so instead.
- **"Zero OS Syscalls Permitted", "Zero Failure State", "Open Plugins Directory"** — none
  of these mean anything here.

### Found by measuring

The five-column table ellipsised three cells at a 1280 px window — the text viewer's
18-extension list and both OOXML MIME types, which are exactly the values the table exists
to show. Added `.engine-table.wrap-cells` so those columns wrap; re-measured at the same
width with zero truncated cells.

### A test that kept breaking, fixed properly

Two `SettingsPage` tests hard-coded a category name as the "unbuilt" example, and broke
for the third time as this category was built. They now find the unbuilt example in the
DOM and assert the *rule* — built categories carry no "Soon" chip — so building the
remaining three will not break them again.

### Verification

- 2 new Rust tests: three malformed overrides rejected (unknown viewer, path-shaped
  extension, uppercase extension) and a round trip that survives reload. 85 Rust tests
  pass; fmt and clippy clean.
- 12 utility tests, including that every offered option is a registered viewer, that the
  detected default is always among the options, and that an override for an unoffered
  extension or viewer is ignored.
- 11 panel tests and 3 new store tests proving the override actually changes which viewer
  a newly opened file gets — the behaviour, not just the stored value.
- 315 frontend tests pass; `tsc -b`, `eslint src` and `vite build` clean.
- Layout measured in a browser at 1280x860 against a table generated from the real
  registry.
- Not verified by running the packaged app.

### Known gaps

- Changing a default does not re-route tabs that are already open, by design; the panel
  says so.
- Three categories remain placeholders: Security & Isolation, Key Bindings, Storage &
  Scratch.
- The override list is curated rather than derived: adding a viewer that can open an
  existing extension means adding it to `OVERRIDABLE` by hand.
---

## Security & Isolation settings — complete (owner: workspace/shell workstream)

The fifth settings category, and the one where getting it wrong would have mattered most.
The design asserted specific, checkable security properties that OneOpen does not have.
A user who believed them might keep sensitive files here on the strength of protections
that do not exist, so this page reports what is actually true and contradicts the rest by
name.

Claimed files: `src/components/SecurityPanel.tsx` and its test (both new).

Shared files touched, append-only: `src/components/SettingsPage.tsx`. No stylesheet change
— the cards reuse `.engine-facts.wide` and `.engine-table.wrap-cells`. No Rust change.

### Every claim on the page was checked against the code first

- **SVG** — `ImageViewer` runs DOMPurify with the SVG profile, `FORBID_TAGS: [script,
  foreignObject]` and forbidden event-handler attributes, then renders the result as a
  blob in an `<img>`. Verified at `handlers/image/ImageViewer.tsx:45`.
- **Word/Excel macros** — the parsers read only the XML parts they need. `docx_meta`
  reports `vbaProject.bin` as *present*; nothing ever opens it.
- **XML entities** — quick-xml does not expand custom or external entities, so no
  entity-expansion or external-reference attack.
- **PDF** — pages are drawn with the pdf.js *core* API. The viewer layer that would run a
  document's JavaScript actions is not used.
- **PDF text in the annotation editor** — `htmlFromRuns` HTML-escapes the text, and there
  is already a test asserting `<script>alert(1)</script>` survives as literal text.
- **Archives** — `safe_archive_path` refuses absolute, drive-qualified and `..` entries;
  size and compression-ratio caps guard against bombs.

While checking the PDF path I followed a possible injection: `TextEditor` assigns
`innerHTML` from `htmlFromRuns`, whose `cssFor` interpolates `style.color` into a
`style="…"` attribute, and `escapeHtml` does not escape quotes. It turned out to be safe —
`toHex` accepts only `#rgb`, `#rrggbb` or `rgb()` and returns a normalised `#rrggbb` or
null, and the only other source is an `<input type="color">`. **No change needed**, but
the property the page relies on is real and already pinned by a test.

### What the design claimed, and what is true

- **"Kernel-Level Airgap", "Windows Filtering Platform (WFP) Syscall Interceptor", "ALL
  WSAConnect / socket() calls return WSAEACCES", "WFP Driver Hash: SHA256:4c8f…90de",
  "Kernel Module v1.0.8"** — there is no driver, no filter and no syscall interception.
  The no-network property is real but comes from the CSP and the capability allowlist. The
  page states the distinction and says plainly that nothing here would stop code running
  outside the app.
- **"Memory Sandboxing — APPCONTAINER, Multi-Process AppContainer, low-integrity worker
  per open buffer, Active (PID 14982)", "Integrity Level: Low Untrusted"** — one process,
  normal integrity, no AppContainer, no per-handler sandbox. Said outright, with the
  reason the parsers are bounded instead.
- **"Zero Memory On File Close — cryptographically overwrites heap buffers with 0x00"** —
  no such thing.
- **"Cryptography & Local Storage Encryption — AES-256-GCM", "Windows DPAPI", "TPM
  binding", "Rotate Key", "DPAPI-encrypted vault", "TPM 2.0 PCR Validation: MATCH"** — the
  database is plain SQLite. This was the most harmful claim on the page: the panel now
  says anyone who can read your user profile can read it, and points at the clear-history
  action as the control that does exist.
- **"Active Macro & Script Blocker — block and strip embedded VBA, JavaScript or
  PostScript payloads", "DISARMED DOCUMENT HANDLERS", "Static Disarm Log — 0 malicious
  payloads identified"** — nothing is scanned, stripped or disinfected, and there is no
  scanner to log. The distinction is stated explicitly: a macro is *never run*, not
  *removed from your file*.
- **"Crash Dump & Error Telemetry — 0 KB Allocated, Local Minidump Only"** — there is no
  crash reporter at all.
- **"Execution Policy: STRICT_NOEXEC W^X", "Windows Anti-Exploit Enforcements — ASLR /
  DEP-NX / CFG Guard ✓"** — DEP and ASLR are MSVC defaults, but Control Flow Guard is
  opt-in and this build does not request it. Rather than print three ticks of which one
  would be wrong, the card reports only what the build actually asserts: `unsafe_code`
  forbidden crate-wide.
- **"Mandate Signature: ed25519:7a8109bf…8491 (Enforced by --features=hardened-airgap)",
  "Audit Security Log", "Export Cryptographic Report", "Re-validate Sandbox"** — no
  signature, no feature flag, no audit log, nothing to export or re-validate.

A dedicated **"Not claimed"** card lists the six absent protections outright, because each
is something a reasonable person might otherwise infer from the others.

### Verification

- 12 panel tests, including that the kernel-filter, AppContainer and encryption claims are
  each explicitly contradicted, that the real recent-file count is shown and updates after
  clearing, that clearing is confirmed first, and that the written facts still render when
  the backend command fails.
- 327 frontend tests and 85 Rust tests pass; `tsc -b`, `eslint src`, `vite build`, fmt and
  clippy clean.
- Layout measured in a browser at 1280x900: all seven content rows render, the table stays
  inside its card, nothing is truncated and there is no horizontal scroll.
- Not verified by running the packaged app.

### A probe artefact worth remembering

The first probe rendered only one table row, because the rule text contains literal
`<script>` and `<foreignObject>` and the harness injected it as raw HTML. React renders
those as text nodes, so the component is unaffected — the harness needed the escaping, not
the app. Probes that inject component data as HTML must escape it.

### Known gaps

- Two categories remain placeholders: Key Bindings and Storage & Scratch.
- The content-handling table is prose checked by hand against the code, not generated from
  it; it names the implementing module in each row so a reviewer can re-check.
- `isEvalSupported` is left at the pdf.js default (true). That governs internal font and
  pattern evaluation, not document JavaScript, but turning it off would be a cheap
  hardening step and is not done.
---

## Key Bindings settings — complete (owner: workspace/shell workstream)

The sixth settings category. Fetched the design straight from the Stitch project rather
than working from a screenshot: `list_projects` -> `list_screens` -> `get_screen` returns
both a PNG and the generating HTML, and reading the HTML gives exact copy instead of
guessing at downscaled pixels. Worth doing again for the remaining screens.

Claimed files: `src/components/KeyBindingsPanel.tsx` and its test,
`src/utils/shortcuts.ts` and its test (all new).

Shared files touched, append-only: `src/app/App.tsx` (its key handler now dispatches from
the shared table), `src/components/SettingsPage.tsx`, and the `.key-*` block in
`src/app/styles.css`.

### The design's premise did not exist

The mockup is a **remapping** UI: keymap presets (VS Code / Vim / Sublime emulation), a
live keystroke recorder, CapsLock-as-Escape driver hooks, a leader-key timeout, conflict
counts and Save Mappings. **OneOpen has no key rebinding at all** — every binding is
hard-coded. Building a keymap editor that stored preferences nothing reads would have been
the worst possible outcome here, so the page is a *reference* instead, and says outright
that bindings are fixed.

Also fabricated, and absent: Ctrl+K palette (it is Ctrl+P), Ctrl+Tab buffer cycling, split
view (Ctrl+\), Ctrl+B/Ctrl+I panel toggles, hex disassembly and Capstone opcode stepping,
mmap cache flush, emergency airgap lock, memory scrub on Ctrl+Alt+Del, "64 active, 0
conflicts", "187 available combinations", "0.04 ms dispatch", and
`LowLevelKeyboardProc` — OneOpen listens for ordinary DOM `keydown`, not a Win32 hook.

### The documentation cannot drift from the behaviour

`GLOBAL_SHORTCUTS` is now the **single source of truth**. `App.tsx` had six hand-written
`if` branches; it now iterates that array and calls a handler keyed by shortcut id, and the
settings page renders the same array. Adding a shortcut in one place adds it to both.

`ShortcutId` is a literal union and the handler map is typed `Record<ShortcutId, () => void>`,
so forgetting to wire a new shortcut is a **compile error**, not a silently dead key.

The refactor also fixed a real inconsistency: the old branches did not check `shiftKey`, so
Ctrl+Shift+O and Ctrl+Shift+W fired Open and Close. They no longer do, and there is a test
for it.

Viewer-scoped bindings are described rather than dispatched, each naming the module that
implements it — the same convention as the security page.

### Verification

- 12 tests on the table: every combination matches, Cmd works like Ctrl, matching is
  case-insensitive, a bare key without a modifier does nothing, Shift no longer triggers
  the unshifted binding, no event matches two shortcuts, and the catalogue has no
  duplicate combination within a scope.
- 11 panel tests, including that every global shortcut is listed, that the total is the
  computed count rather than a written number, that filtering works by name and by key
  ("ctrl+w"), and that no Record / Listen / Save Mappings control exists.
- 350 frontend tests and 85 Rust tests pass; `tsc -b`, `eslint src`, `vite build` clean.
- Layout measured in a browser at 1280x900: 24 rows, 46 key caps, nothing overflowing its
  column and no horizontal scroll. Two module labels were being ellipsised, so they
  carry a `title` now.
- Not verified by running the packaged app.

### Known gaps

- One category remains a placeholder: Storage & Scratch. (Telemetry & Network exists as a
  Stitch screen but is not in the app's category list.)
- The viewer-scoped rows are prose checked by hand against the code, not generated from it.
- CodeMirror contributes many more bindings than the five listed; the page says so rather
  than trying to enumerate the whole default keymap.
- Rebinding is still not offered. It would need a persisted keymap, conflict detection and
  a recorder — a real feature, not a settings page.
---

## Telemetry & Network settings — complete (owner: workspace/shell workstream)

The seventh settings category, and a new one: `Telemetry & Network` existed as a Stitch
screen but was not in the app's category list, so it was added.

Claimed files: `src/components/TelemetryPanel.tsx` and its test, `src/utils/network.ts`
and its test (all new).

Shared files touched, append-only: `src/components/SettingsPage.tsx` (new category) and
the `.egress-result` block in `src/app/styles.css`. No Rust change.

### The one idea worth keeping: prove it instead of asserting it

Every previous page has *stated* that OneOpen makes no outbound connections. This one
offers a button that demonstrates it. `probeEgress` attempts a single request and listens
for `securitypolicyviolation`, so the verdict comes from the browser refusing the
connection rather than from a sentence in the UI.

Two design points that make it safe and honest:

- The target is `https://egress-check.invalid/...`. `.invalid` is reserved by RFC 2606 and
  can never resolve, so **even if the policy were missing entirely, no packet could reach
  a real host**. The check sends nothing anywhere.
- A failed request is *not* treated as proof. Without a violation event the verdict is
  `failed-otherwise`, and the text says so — a DNS failure must not be dressed up as a
  policy win. An unblocked request is reported as `not-blocked` and styled as a problem,
  not a success.

It only runs on an explicit button press.

**Verified end to end in a real browser, not just against mocks:**
- Under a page with `connect-src ipc: http://ipc.localhost` — verdict `blocked-by-policy`,
  directive `connect-src`, blocked URI reported correctly.
- The same page with the CSP removed — verdict `failed-otherwise`, "no violation
  reported". The honesty property holds where it matters.

### The rest of the page

The real CSP turns out to be genuinely strict and worth explaining directive by directive:
`connect-src` does not even include `'self'`, only the IPC bridge; `img-src`, `font-src`
and `media-src` name no remote origin, so a tracking pixel or remote font inside an opened
file cannot load; `object-src`, `frame-src`, `base-uri` and `form-action` are all `'none'`.
The table renders each directive with what it permits and what that means, and a test
asserts every directive the build sets has an explanation.

Also listed: the 14 granted capabilities (window management, events, open and save
dialogs — none granting HTTP, shell or filesystem), and the things that are absent by
construction rather than switched off, which is why the page has nothing to toggle.

### What the design claimed, and what is true

- **`wfp_oneopen.sys`, ring-0 hooks, "kernel filter arbiter", a driver SHA-256, "LOCKED /
  RING 0"** — no driver exists. The guarantee binds this window through a policy it
  enforces on itself, and the page says it would not stop another program on the machine.
- **"0 Bytes TX / 0 Bytes RX enforced across 82 runtime sessions", "14 Dropped Packets",
  the live traffic-density graph, "Sampling: 100ms"** — nothing is measured. There are no
  counters to report, so none are shown.
- **Named-pipe IPC (`\.\pipe\oneopen-ipc-*`)** — Tauri's bridge is a local HTTP
  origin, `http://ipc.localhost`, which is exactly what `connect-src` permits.
- **Crash reporter and minidump destination options** — there is no crash reporter, so
  there is no destination to choose.
- **Certificate validation, CRL and OCSP settings** — there is no TLS client in the
  window to configure.
- **Ed25519 attestation, session nonce, "Copy Session Hash", "Export Verification
  Attestation"** — nothing signs anything. The egress test replaces this: weaker than a
  cryptographic record, but real.
- **WASM plugin socket sandbox, "0/12 Plugins Requested Network"** — there is no plugin
  system, as the Format Handlers page already states.
- **"Airgapped Update Verification", "Verify Local Installer Bundle Hash"** — no updater.

### Verification

- 12 tests on the utilities: the shipped policy parses into the right directives in order,
  every directive has an explanation, the `'none'` directives are identified, no remote
  host is permitted, a loosened policy *is* detected, and the probe reports each of its
  four verdicts correctly — including that it only ever targets a `.invalid` hostname.
- 13 panel tests, including that the check runs only on request, that an ordinary failure
  is not presented as proof, that an unblocked request is flagged rather than celebrated,
  and that the kernel-driver and attestation claims are contradicted.
- 375 frontend tests and 85 Rust tests pass; `tsc -b`, `eslint src`, `vite build` clean.
- Not verified inside the packaged app — but the probe mechanism itself was verified in a
  real browser under both a matching CSP and no CSP.

### Known gaps

- One category remains a placeholder: Storage & Scratch.
- The egress check tests `connect-src` only. It does not attempt a remote image, font or
  frame, so it demonstrates one directive rather than the whole policy.
- The CSP shown is the one compiled into this build; it is not re-read from the running
  window, so a runtime override (there is none today) would not be reflected.
---

## Storage & Scratch settings — complete (owner: workspace/shell workstream)

The eighth and last settings category. Every category in the rail is now built; no "Soon"
placeholders remain.

Claimed files: `src/components/StoragePanel.tsx` and its test,
`src-tauri/src/storage_report.rs` (all new).

Shared files touched, append-only: `src-tauri/src/domain/models.rs` (`StorageReport`,
`StorageTable`), `src-tauri/src/commands/mod.rs` (`get_storage_report`),
`src-tauri/src/lib.rs`, `src-tauri/src/persistence/mod.rs` (`MIGRATOR` is now
`pub(crate)` so the report's test can build a schema), `src/types/files.ts`,
`src/services/tauri.ts`, `src/components/SettingsPage.tsx`, and the `.storage-actions`
rule in `src/app/styles.css`. No migration.

### Real numbers, counted on demand

A new command reports the database path, its size on disk, and the row count of every
table with the limit the code actually enforces on it — recents capped at 100 returned,
session tabs at 50 saved, 20 folders and 50 pins per workspace. The clear actions reload
the report, so the counts visibly change.

The table list is guarded by a test that compares it against `sqlite_master` after running
the real migrations **in both directions**: every table the migrations create must be
described, and every described table must exist. That is what stops this page drifting the
way the earlier hand-written tables could.

### A dead table found on the way

`handler_preferences` is created by `0001_initial.sql` and **referenced by nothing** — no
Rust code reads or writes it. The viewer overrides added with the Format Handlers page went
into the settings JSON row instead. It is a released migration so it stays, but the page
lists it and says it is unused rather than quietly omitting it.

### Scratch space, honestly

The only thing OneOpen writes outside that database is the temporary file `atomicwrites`
creates during a save: written next to the target and renamed over it, so an interrupted
save cannot leave a half-written file. `tempfile` is a dependency but is used **only in
tests** — the app creates no temp directory. File content is read fresh on every open and
dropped when the tab closes.

### What the design claimed, and what is true

- **NVMe device identification** ("Samsung 990 PRO ... PCIe 4.0 x4", PhysicalDrive0, queue
  depth 32, controller temperature, TRIM status) — a WebView cannot see any of this.
- **Scratch quota, 1.42 GB of 16 GB, sparse pinned buffers, eviction strategy (LRU / tab
  close / TTL), max scratch cap** — there is no scratch pool, so nothing to quota or evict.
- **Sequential read/write benchmarks, "Direct mmap Latency 0.008 ms", 940k IOPS, the live
  DMA throughput graph** — nothing is measured and there is no mmap anywhere in the
  project.
- **File backing strategy** (`FILE_ATTRIBUTE_SPARSE_FILE`, `VirtualAlloc`,
  `FILE_FLAG_NO_BUFFERING`) — reads are ordinary buffered I/O.
- **Decompression spill threshold**, **SQLite/DuckDB journal mode**, **8 async flush
  workers** — none of these are configurable, and there is no DuckDB.
- **The four cache arenas** — audio waveform ring buffer, PDF tile pyramid, WASM JIT
  cache, ephemeral SQL tables — **none exist**. That was the heart of the design and there
  is nothing there to purge, so the page says so instead of offering four dead buttons.
- **"Zero-Fill Secure Erase on Buffer Eviction"** — deleting a row does not scrub the
  disk, and claiming otherwise about deleted data would be the most misleading thing on
  the page.

### Verification

- 2 new Rust tests: the described tables match the migrated schema in both directions, and
  row counts plus a missing database file are reported correctly. 87 Rust tests pass; fmt
  and clippy clean.
- 12 panel tests, including that a zero-byte database reads "Not created yet" rather than
  "0 B", that a table with no limit shows a dash rather than an invented cap, that the
  unused table is surfaced, that clearing reloads the counts, and that the cache and
  benchmark claims are contradicted.
- 387 frontend tests pass; `tsc -b`, `eslint src`, `vite build` clean.
- Layout measured in a browser at 1280x900: eight rows, nothing truncated, and the long
  database path renders in full thanks to `.engine-facts.wide`.
- Not verified by running the packaged app — in particular the real database path and size
  have only been exercised against a temporary directory in tests.

### Known gaps

- The settings rail is complete, but nothing reads a `Storage` preference: this page is
  reporting plus the two clear actions, not configuration.
- Clearing recents still does not clear workspace pins, and there is no "delete everything
  and start fresh" action.
- `handler_preferences` remains in the schema, unused.
---

## Diff & Compare, setup state — partial by request (owner: workspace/shell workstream)

The first feature outside the settings page. Scoped deliberately: the **setup state only**,
plus the sidebar entry point. The comparison view itself is not built.

Claimed files: `src/components/DiffCompare.tsx` and its test, `src/utils/diff.ts` and its
test (all new).

Shared files touched, append-only: `src/components/Sidebar.tsx` (a File Inspection section
above Recent Files), `src/app/App.tsx` (view state, selection, drop routing), and the
`.diff-*` / `.sidebar-inspect` blocks in `src/app/styles.css`. No Rust change.

### What works

- **A File Inspection section in the sidebar**, above Recent Files, holding one entry:
  Diff Compare. The design listed six; only this one is built, so only this one is shown.
- Base and target slots, each fillable three ways: **Browse**, **an already-open tab**
  (offered as chips, filtered to text files that are not already chosen), or **dropping a
  file onto the view**. While the compare view is open a drop fills the next empty slot
  instead of opening a tab, which is what the drop targets promise.
- Swap, clear, and a verdict line: ready with the size delta, a warning on a mismatched
  extension, or a refusal naming the offending file.
- Binary files are refused rather than compared as mojibake — only `text`, `sql`,
  `structured` and `csv` are accepted.

### What deliberately does not work

**Compare is disabled**, with the reason written next to it. This was the scoped request,
and a button that opened an empty view would be worse than one that says it is not ready.
That is the whole of the omission: everything up to pressing it works.

### Not built from the design

The mockup's stage was mostly machinery that does not exist: the **SIMD Diff Engine**
status, "Read Mode: Direct Memory Map", "Tree-Sitter Syntax: Auto" and "Live AST Stream",
**Git Stash / HEAD Tree** sources (there is no git integration), the four **Accelerated
Comparison Engines** (Tree-Sitter, Apache Arrow, Capstone, pixel overlay — the same
fictional stack the Format Handlers page already refused), **Recent Comparison Sessions**
with cached statistics, the **3-Way Merge** and **AST Syntax** view modes, and the
sidebar's "AVX-512 Vector Unit / 16 Workers / Tauri Sandbox 16.3 MB" block.

The **Diff Heuristics** card is worth revisiting when the comparison itself is built:
Myers is a real algorithm and ignore-whitespace and ignore-case are real options. They are
absent for now because none of them has anything to act on yet.

### Verification

- 13 tests on the pairing rules: not-ready without complaint while a slot is empty, a
  binary side refused by name, both sides named when neither is text, the same file
  refused however it is spelled (including the `\?\` prefix), a mismatched extension
  warned but allowed, size deltas in both directions, and open-tab suggestions excluding
  binaries and already-chosen files.
- 14 component tests, including that Compare stays disabled and says why, that dismissing
  the picker selects nothing, and that a detection failure is surfaced.
- 414 frontend tests and 87 Rust tests pass; `tsc -b`, `eslint src`, `vite build` clean.
- Layout measured in a browser at 1280x860: both slots equal height, full paths not
  truncated, nothing overflowing.

### A lint warning that was a real bug

`react-hooks/exhaustive-deps` flagged the drop handler, and looking at why exposed
something worse: the first version of `fillDiffSlots` read the current slot by assigning
to a variable **inside a `setDiff` updater**. Updaters must be pure — React may call them
twice under StrictMode — so the slot chosen could have been wrong. Rewritten to track the
selection in a ref, which is also what lets a multi-file drop fill A then B before React
has re-rendered.

### A probe artefact, again

The first harness rendered the diff body into a 43 px `.viewer-area` and clipped
everything, because the probe omitted the topbar and statusbar and `main` therefore landed
in the first grid row rather than the `1fr` one. The app's own DOM has four children in
`.workspace`. Harnesses that place a component inside a grid must reproduce its siblings.

### Known gaps

- The comparison view, which is the point of the feature.
- The other five File Inspection entries from the design are not built and are not shown.
- The selection is not persisted; closing the view keeps it in memory only for the session.
---

## Diff & Compare, the comparison itself — complete (owner: workspace/shell workstream)

Completes the feature the previous entry deliberately left half-built.

Claimed files: `src/components/DiffView.tsx` and its test, `src/utils/lineDiff.ts`,
`lineDiff.test.ts` and `lineDiff.patch.test.ts` (all new).

Shared files touched, append-only: `src/components/DiffCompare.tsx` (Compare is now live),
`src/app/App.tsx` (a comparing flag), and the `.diff-view` / `.diff-table` block in
`src/app/styles.css`. No Rust change.

### The engine

Myers' greedy O(ND) diff, chosen because it stays cheap while two files remain similar —
the usual case. Runs of removals are paired with the runs of insertions that follow them,
so a replaced line shows as one **modified** row side by side rather than as a deletion
far from its insertion. Work is bounded at 20,000 lines a side and the result says when it
hit that.

Comparison keys are separate from display text: ignore-whitespace and ignore-case change
what counts as equal, never what is shown.

### Patch export, validated by git rather than by eye

`toPatch` writes a unified diff with three lines of context and merged hunks. Asserting a
patch "contains `-old`" only checks the shape, so there is a second test file that writes
the patch into a temporary git repository, runs **`git apply`**, and asserts the file that
comes out equals the target byte for byte — across a single-line change, an insertion, a
deletion, two distant hunks, and a change on the first line.

**That test found a real bug immediately.** `splitLines("a
")` returned `["a", ""]`, and
that phantom final line put a context line into every patch that the file did not have.
Every export was rejected with *"patch does not apply"*. A final newline terminates the
last line rather than starting a new one, so `splitLines` now drops it and `endsWithNewline`
reports it separately, which is also what lets the export emit
`\ No newline at end of file` correctly.

**My own earlier unit test had encoded the bug** — it asserted the phantom line was kept.
It now asserts the opposite and says why. This is the second time this session a test has
locked in wrong behaviour; asserting on a real consumer, in this case git, is what caught
it.

### Two more flaws in my own tests

- `it.runIf(hasGit)` was evaluated at collection time while `hasGit` was set inside
  `beforeAll`, so the skip could never fire and a machine without git would have seen
  failures instead. The check now runs at module scope.
- A split-view assertion used `getByText` for an unchanged line, which appears in **both**
  columns. Corrected to `getAllByText`, and the indentation assertion now reads
  `textContent` directly because testing-library normalises whitespace when matching.

### What the design showed that is not here

- **3-Way Merge** and **AST Syntax Tree** view modes — there is no merge and no parser.
- **Keep Left / Accept Right** merge actions — this compares files; it does not edit them.
- **"SIMD Diff: 0.42 ms"** — replaced with the real measured time, which the status bar
  reports as "computed in N ms". The number is honest; the SIMD claim was not.
- **SHA digests** per file, the **Semantic AST Diff** panel, **Differences by Symbol**, and
  the **Comparison Engine Profile** with its AVX-512 and worker counts.
- **"0 conflicts"** — there is no merge, so there are no conflicts to count.

A symbol-level summary for `.sql` is genuinely within reach — `parseObjects` from the SQL
viewer already extracts tables, indexes and triggers — but it is not built.

### Verification

- 30 tests on the engine: insertions, deletions, replacements paired as modifications,
  line numbers staying correct across changes, hunk boundaries, both ignore options, empty
  sides, wholly different files, the line cap, and unified conversion.
- 5 git round-trip tests as described above.
- 12 view tests: the stats, both layouts, recomputation when an option changes, the
  identical-files message distinguishing exact from "under the options selected", wrap-around
  hunk navigation, patch export and its dismissal, and a read failure surfacing.
- 457 frontend tests and 87 Rust tests pass; `tsc -b`, `eslint src`, `vite build` clean.
- Rendering measured in a browser at 1280x860 against realistic SQL: the correct tint per
  row kind, the blank half of a one-sided change falling back to the page background,
  indentation preserved by `pre-wrap`, and no horizontal scroll.
- Not verified by running the packaged app.

### Known gaps

- No syntax highlighting inside the diff; rows are plain monospace text.
- No intra-line highlighting — a modified row shows both versions but not which characters
  differ.
- Large files are compared in full on the main thread. 20,000 lines is bounded but not
  instant; a worker would be the fix if it becomes uncomfortable.
- The comparison does not re-run when either file changes on disk.
---

## Diff panes could not scroll — fixed (owner: workspace/shell workstream)

Reported directly: the diff was unscrollable. Confirmed and fixed.

**Cause.** `.viewer-area` is a plain block with `overflow: hidden`. `.diff-view` and
`.diff-setup` used `flex: 1` to fill it — but `flex: 1` means nothing to a child of a
block parent, so each pane sized itself to its content, grew past the clip, and
`.diff-scroll` never became scrollable. The content below the fold was simply unreachable.

`.viewer` had it right all along with `height: 100%`; the two new panes did not follow it.
Both now match, plus `overflow: hidden` so the inner region is the only thing that scrolls.

Measured after the fix: `.diff-view` is 817 px against a 817 px `.viewer-area`, the scroll
region reports 4028 px of content in a 664 px box, and it actually scrolls. The setup pane
was checked the same way at a 460 px window, where it also now scrolls.

**Why the earlier probe missed it.** The verification probe for that entry rendered only 17
rows, which fitted the pane, so `scrollsY` was legitimately `false` and nothing looked
wrong. A probe has to make the content exceed the container or it cannot test overflow at
all. The replacement probe used 200 rows.

### This is the third time

The same shape has now appeared three times: `.settings-main` as a grid item with
`min-height: auto`, the sidebar folder tree, and now these two panes. So it is guarded
rather than just fixed.

`src/app/layout.test.ts` asserts the stylesheet invariants directly, because jsdom has no
layout engine and cannot catch this by rendering:

- `.viewer-area` is still a clipped block, which is what makes the rest necessary.
- Every pane rendered straight into it — `.viewer`, `.diff-view`, `.diff-setup` — sets
  `height: 100%` and does **not** use `flex: 1`.
- Every scrolling region inside them sets `min-height: 0` and an `overflow: auto`.
- The settings page stays bounded by its own `position: fixed; inset: 0`, and
  `.settings-main` keeps its `min-height: 0`.

The guard was mutation-checked: reintroducing `flex: 1` on `.diff-view` fails the test with
"must set height: 100%", and restoring the fix passes. A guard that cannot fail is worth
nothing, so it was made to fail on purpose once.

### Verification

- 6 new tests in `src/app/layout.test.ts`, mutation-checked as above.
- 463 frontend tests pass; `tsc -b`, `eslint src` and `vite build` clean. No Rust change.
- Scrolling confirmed in a browser for both panes, with content deliberately exceeding the
  container in each case.
- Not verified by running the packaged app.
---

## Environment notes

- **Dev port moved 1420 -> 5173.** Windows reserves TCP ranges (`netsh interface ipv4
  show excludedportrange protocol=tcp`), and 1420 fell inside a `1375-1474` exclusion, so
  `pnpm tauri dev` died with `listen EACCES ::1:1420` before the Rust side ever started.
  Changed in `vite.config.ts` (`server.port`) and `src-tauri/tauri.conf.json`
  (`build.devUrl`) — those two must always agree.
- **Watch for a compiled `vite.config.js`.** Stale `vite.config.js` / `vite.config.d.ts`
  were sitting next to `vite.config.ts`, and Vite resolves the `.js` first, so the port
  change had no effect until they were deleted. `tsconfig.node.json` now sets an `outDir`
  under `node_modules/.tmp` so any future emit cannot land beside the source. If a config
  change seems to be ignored, check for a compiled twin first.
- The system Corepack `pnpm` shim on this machine is broken. Use
  `& "$env:APPDATA\npm\pnpm.cmd"`. For `tauri build`/`tauri dev`, which spawn a nested bare
  `pnpm`, also prepend `$env:APPDATA\npm` to `PATH`. See `PROJECT_CONTEXT.md`.
- `npx tsc --noEmit` checks NOTHING here: the root `tsconfig.json` is a solution file
  with `"files": []`. Use `npx tsc -b` (or `pnpm build`).
- Full validation: `pnpm lint`, `pnpm test`, `pnpm build`, then in `src-tauri`
  `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test --all-targets`.
- A shell wrapper can report exit 0 while `clippy` actually failed; read the output text,
  not just the exit code.
- As of the last run on this branch: 87 Rust tests and 463 frontend tests pass, with lint,
  fmt, clippy and the production build clean.
