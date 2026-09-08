import io

# ---------- types ----------
p = "src/types/files.ts"
s = io.open(p, encoding="utf-8").read()
anchor = "export interface SessionTab { path: string; active: boolean }"
assert anchor in s and "EngineReport" not in s
s = s.replace(anchor, """export interface DecoderEngine { category: string; module: string; version: string; runtime: string; formats: string[] }

export interface EngineLimit { name: string; value: number; unit: string; why: string }

export interface IsolationReport { csp: string; permissions: string[]; networkPlugins: boolean }

export interface EngineReport {
  appVersion: string;
  target: string;
  profile: string;
  tauriVersion: string;
  unsafeForbidden: boolean;
  engines: DecoderEngine[];
  limits: EngineLimit[];
  isolation: IsolationReport;
}

""" + anchor, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("types")

# ---------- api ----------
p = "src/services/tauri.ts"
s = io.open(p, encoding="utf-8").read()
old = '  recentFiles: () => command<RecentFile[]>("get_recent_files"),'
new = old + """
  clearRecentFiles: () => command<void>("clear_recent_files"),
  clearSavedSession: () => command<void>("clear_saved_session"),
  engineReport: () => command<EngineReport>("get_engine_report"),"""
assert old in s
s = s.replace(old, new, 1)
s = s.replace("  DirectoryEntry,\n", "  DirectoryEntry,\n  EngineReport,\n", 1)
assert "EngineReport,\n" in s
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("api")

# ---------- settings page ----------
p = "src/components/SettingsPage.tsx"
s = io.open(p, encoding="utf-8").read()
s = s.replace('import { toToml } from "../utils/settingsExport";',
              'import { toToml } from "../utils/settingsExport";\nimport { NativeEnginePanel } from "./NativeEnginePanel";', 1)
s = s.replace('  { id: "engine", label: "Native Engine", icon: Cpu, built: false },',
              '  { id: "engine", label: "Native Engine", icon: Cpu, built: true },', 1)

old = "          {!active.built ? ("
new = """          {active.id === "engine" ? (
            <NativeEnginePanel matches={matches} />
          ) : !active.built ? ("""
assert old in s
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("settings page")

# ---------- styles ----------
p = "src/app/styles.css"
s = io.open(p, encoding="utf-8").read()
assert ".engine-table" not in s
s = s.rstrip("\n") + """

/* Native engine panel */
.engine-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(232px, 1fr)); gap: 1px; margin: 0; padding: 13px 0; background: var(--border); border: 1px solid var(--border); border-radius: 5px; overflow: hidden; padding: 1px; }
.engine-facts > div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 8px 10px; background: var(--bg); }
.engine-facts dt { flex: none; color: var(--muted); font-size: 11px; }
.engine-facts dd { margin: 0; overflow: hidden; color: var(--text); font: 11px var(--mono); text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.engine-note { display: flex; align-items: flex-start; gap: 6px; margin: 11px 0 13px !important; padding: 9px 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); color: var(--muted); font-size: 10px !important; line-height: 1.55 !important; }
.engine-note svg { flex: none; margin-top: 2px; }
.engine-table-wrap { margin: 13px 0; overflow-x: auto; border: 1px solid var(--border); border-radius: 5px; }
.engine-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.engine-table th { padding: 7px 10px; background: var(--panel-2); color: var(--muted); font: 600 9px "Cascadia Code", Consolas, monospace; letter-spacing: .06em; text-align: left; text-transform: uppercase; white-space: nowrap; }
.engine-table td { padding: 7px 10px; border-top: 1px solid var(--border); background: var(--bg); vertical-align: top; }
.engine-module { font-family: var(--mono); }
.engine-version { color: var(--muted); font-family: var(--mono); font-variant-numeric: var(--figures); white-space: nowrap; }
.engine-formats { max-width: 260px; overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.engine-runtime { padding: 2px 6px; border-radius: 3px; font-size: 9px; white-space: nowrap; }
.engine-runtime.core { background: color-mix(in srgb, #42d392 20%, transparent); color: #42d392; }
.engine-runtime.webview { background: color-mix(in srgb, #60a5fa 20%, transparent); color: #60a5fa; }
.engine-badge { display: inline-flex; flex: none; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 4px; font-size: 11px; }
.engine-badge.ok { background: color-mix(in srgb, #42d392 18%, transparent); color: #42d392; }
.engine-block { padding: 12px 0; border-top: 1px solid var(--border); }
.engine-block h4 { margin: 0 0 7px; color: var(--muted); font-size: 10px; font-weight: 500; letter-spacing: .05em; text-transform: uppercase; }
.engine-block code { display: block; padding: 9px 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); color: var(--text); font: 10px/1.7 var(--mono); word-break: break-word; }
.engine-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.engine-chips span { padding: 3px 7px; border: 1px solid var(--border); border-radius: 3px; background: var(--bg); color: var(--muted); font: 10px var(--mono); }
.settings-card .setting-row .icon-action { flex: none; padding: 5px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel-2); color: var(--muted); font-size: 11px; white-space: nowrap; }
.settings-card .setting-row .icon-action:hover { border-color: var(--danger); color: var(--text); }
"""
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("styles")
