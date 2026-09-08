# Security

## Trust model

Every opened file, filename, archive entry, and persisted path is untrusted. The frontend has only the Tauri capabilities in `src-tauri/capabilities/main.json`; it cannot invoke a generic shell or unrestricted filesystem API. The CSP blocks remote scripts, frames, objects, forms, and arbitrary network connections.

Rust canonicalizes existing files and directories at every command boundary. Write destinations require an existing canonical parent. Explicit user actions are required before external opening, folder reveal, or extraction.

## Content handling

- Text is displayed as text in CodeMirror and is never evaluated.
- JSON/XML tree values are rendered through React text nodes.
- SVG is sanitized, with scripts, foreign objects, event attributes, and links removed, then loaded from an isolated Blob URL.
- PDF.js runs from packaged code and cancels page rendering on disposal.
- Excel and Word files are parsed in Rust, never in the WebView. Word text, formatting, and table cells cross the boundary as typed data and are rendered through React text nodes, so document content can never become markup or script.
- Word package parts are read with the archive size and compression-ratio limits, and the XML reader expands no custom or external entities, so entity-expansion and external-reference attacks do not apply. Macros, embedded objects, and external links are never read or executed.
- Images and media use bounded Blob URLs that are revoked on disposal.
- Image conversion decodes in Rust with explicit decoder limits on dimensions and allocation, so a decompression-bomb image fails with a structured error instead of exhausting memory. SVG input is rendered by resvg with `resources_dir` unset and the string `href` resolver overridden to refuse every external reference, because usvg resolves local file paths by default.
- No remote scripts, analytics, telemetry, authentication, or cloud services are used.
- Logs include timings and byte counts in development, never file content or paths.

## Writes and conflicts

Text saves compare the expected modification timestamp and return `external_modification` on conflict. Writes use a temporary sibling and atomic replacement. Permission, missing-file, path, and persistence errors are serialized with stable codes and presented without crashing the application.

## ZIP extraction

Extraction rejects absolute, device, empty, parent-traversal, and symbolic-link entries. Every output remains under a canonical destination. File count, per-entry size, aggregate decompressed size, and compression ratio are bounded. Writes are chunked and cancellation removes the partial current file. Collisions use an explicit skip, overwrite, or rename policy. Archive contents are never executed.

## Spreadsheet editing

Cell edits patch the worksheet XML only; every other package part is copied without being parsed, so an edit cannot corrupt parts the app does not understand. Sheet parts are resolved through the workbook relationships and validated with the archive path check, so a crafted relationship target cannot escape the package. Values are written as inline strings, numbers or booleans and never as formulas, and both the per-cell and per-save limits are bounded. Saves honour the modification-timestamp conflict check and land through the atomic write path.

## Image conversion

Conversion never overwrites the source. The user picks the destination through the system Save dialog, the destination extension must match the chosen encoder so a converted file cannot misreport its contents, and the bytes are written through the same atomic-replacement path as every other save.

## Office documents

Workbook and document viewing is read-only; OneOpen never writes back to an Office file. Bounded row, column, cell, block, and text limits stop a hostile or oversized file from exhausting memory, and every limit failure returns a structured error code rather than a crash.

## Reporting

Do not attach sensitive user files to reports. Include the OneOpen version, operating system, reproduction steps using generated fixtures, and the structured error code when available.
