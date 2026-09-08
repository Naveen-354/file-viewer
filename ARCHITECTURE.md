# Architecture

## Runtime boundaries

The React layer owns presentation and transient workspace state. It requests narrow operations through typed Tauri commands. Rust canonicalizes paths, detects content, performs bounded reads and atomic writes, applies archive defenses, invokes the operating system, and persists application state with SQLx/SQLite.

The frontend never receives a generic filesystem or shell API. File bytes cross the command boundary only in bounded chunks. Viewer modules are registered in `src/handlers/registry.ts` and dynamically imported after Rust selects a handler using signatures, content/MIME evidence, then extensions as a fallback.

## Frontend

- `src/app` contains shell composition and viewer hosting.
- `src/components` contains reusable navigation, status, command, and error UI.
- `src/handlers` contains independently loaded viewers.
- `src/services` is the typed Rust command boundary.
- `src/stores` contains Zustand workspace and settings state.
- `src/types` contains shared frontend contracts.

Office files are ZIP or OLE2 containers, so they are parsed in Rust rather than in the WebView: the frontend receives a bounded, already-typed view (one sheet of cells, or a block model of paragraphs and tables) instead of raw package bytes, and Word content reaches the DOM only as React text nodes.

Tabs hold descriptors rather than file content. Viewers own bounded content and release editor, worker, object-URL, media, and render resources when unmounted. Closed tabs retain descriptors only. Viewer failures are isolated by an error boundary.

## Rust

- `commands` exposes typed command functions.
- `application` normalizes startup and secondary-instance arguments.
- `domain` defines serialized models and structured errors.
- `file_detection` applies content-first classification.
- `file_io` owns chunk reads and atomic saves.
- `handlers` owns non-UI format logic: secure ZIP access, workbook reading, Word document parsing, and image decoding/re-encoding.
- `persistence` runs versioned migrations and SQLx queries.
- `platform` contains fixed, platform-specific open/reveal operations.
- `security` canonicalizes paths and validates archive destinations.
- `state` contains the SQLite pool, cancellation flags, and initial file queue.

## Persistence

Migration `0001_initial.sql` creates recent files, settings, session tabs, window state, and handler preference tables. Missing recent/session files are tolerated. Content is never persisted. Session writes are transactional and bounded to 50 tabs.

## Extension points

New viewers implement the `FileHandler` contract, add a dynamic registry entry, and add a Rust classification rule when content evidence exists. Future streaming media can replace the bounded Blob adapter behind the media viewer without changing the workspace or tab model. Platform-specific launching remains behind the Rust `platform` module.
