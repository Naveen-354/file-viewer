import { useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  CloudOff, Cpu, FileCode2, Folders, Keyboard, Layers, Monitor, Moon, RotateCcw, Search, Shield,
  Sliders, Sun, Type, Upload, X,
} from "lucide-react";
import { api } from "../services/tauri";
import { useSettings } from "../stores/settings";
import { ACCENTS, MONO_FONTS, isFontAvailable } from "../utils/appearance";
import { toToml } from "../utils/settingsExport";
import { FormatHandlersPanel } from "./FormatHandlersPanel";
import { HardwarePanel } from "./HardwarePanel";
import { KeyBindingsPanel } from "./KeyBindingsPanel";
import { StoragePanel } from "./StoragePanel";
import { TelemetryPanel } from "./TelemetryPanel";
import { SecurityPanel } from "./SecurityPanel";
import { NativeEnginePanel } from "./NativeEnginePanel";

interface Category { id: string; label: string; icon: typeof Sliders; built: boolean }

/**
 * The full category list from the design. Only General & Interface is built;
 * the rest are listed so the shape is visible, and each says so rather than
 * showing controls that do nothing.
 */
const CATEGORIES: Category[] = [
  { id: "general", label: "General & Interface", icon: Sliders, built: true },
  { id: "engine", label: "Native Engine", icon: Cpu, built: true },
  { id: "hardware", label: "Hardware & GPU", icon: Layers, built: true },
  { id: "handlers", label: "Format Handlers", icon: FileCode2, built: true },
  { id: "security", label: "Security & Isolation", icon: Shield, built: true },
  { id: "keys", label: "Key Bindings", icon: Keyboard, built: true },
  { id: "telemetry", label: "Telemetry & Network", icon: CloudOff, built: true },
  { id: "storage", label: "Storage & Scratch", icon: Folders, built: true },
];

const THEMES = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
] as const;

const EFFECTS = [
  { id: "none", label: "Solid" },
  { id: "mica", label: "Mica" },
  { id: "tabbed", label: "Mica Alt" },
  { id: "acrylic", label: "Acrylic" },
] as const;

const DELIMITERS = [
  { id: null, label: "Detect" },
  { id: ",", label: "Comma" },
  { id: "\t", label: "Tab" },
  { id: ";", label: "Semicolon" },
  { id: "|", label: "Pipe" },
] as const;

export function SettingsPage({ visible, close }: { visible: boolean; close: () => void }) {
  const settings = useSettings();
  const update = useSettings((state) => state.update);
  const reset = useSettings((state) => state.reset);
  const [category, setCategory] = useState("general");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fonts = useMemo(() => MONO_FONTS.map((font) => ({ ...font, available: isFontAvailable(font) })), []);

  if (!visible) return null;

  const apply = (patch: Parameters<typeof update>[0]) => {
    setError("");
    setNotice("");
    void update(patch).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const exportConfig = async () => {
    const destination = await saveDialog({
      defaultPath: "oneopen-settings.toml",
      filters: [{ name: "TOML", extensions: ["toml"] }],
    });
    if (!destination) return;
    try {
      await api.saveTextAs(null, destination, toToml(settings));
      setNotice(`Settings written to ${destination}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const resetAll = () => {
    if (!window.confirm("Put every setting back to its default?")) return;
    setError("");
    void reset().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const needle = query.trim().toLowerCase();
  const matches = (...text: string[]) => !needle || text.some((value) => value.toLowerCase().includes(needle));
  const active = CATEGORIES.find((entry) => entry.id === category)!;

  return (
    <div className="settings-page" role="dialog" aria-modal="true" aria-label="Settings">
      <nav className="settings-nav" aria-label="Settings categories">
        <div className="settings-nav-head">
          <span>ENGINE &amp; SYSTEM</span>
          <button className="icon-button" onClick={close} aria-label="Close settings"><X size={14} /></button>
        </div>
        {CATEGORIES.map((entry) => (
          <button
            key={entry.id}
            className={`settings-nav-item ${category === entry.id ? "active" : ""}`}
            aria-current={category === entry.id}
            onClick={() => setCategory(entry.id)}
          >
            <entry.icon size={13} />
            <span>{entry.label}</span>
            {!entry.built && <em>Soon</em>}
          </button>
        ))}
        <div className="settings-host">
          <h4>Host runtime</h4>
          <div><span>Shell</span><b>Tauri 2 (Rust)</b></div>
          <div><span>Renderer</span><b>{engineName()}</b></div>
          <div><span>Platform</span><b>{navigator.platform || "Unknown"}</b></div>
          <div><span>Network</span><b>No outbound calls</b></div>
        </div>
      </nav>

      <div className="settings-main">
        <header className="settings-topbar">
          <span className="settings-crumbs">
            <span>workspace</span><span>preferences</span><span className="current">{active.id}</span>
          </span>
          <span className="spacer" />
          <label className="doc-find">
            <Search size={12} />
            <input placeholder="Filter preferences" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button className="icon-action labelled" onClick={() => void exportConfig()}><Upload size={13} /> Export config.toml</button>
          <button className="icon-action labelled" onClick={resetAll}><RotateCcw size={13} /> Reset to default</button>
        </header>

        <div className="settings-scroll">
          <h1 className="settings-title">{active.label}</h1>

          {active.id === "engine" ? (
            <NativeEnginePanel matches={matches} />
          ) : active.id === "hardware" ? (
            <HardwarePanel matches={matches} />
          ) : active.id === "handlers" ? (
            <FormatHandlersPanel matches={matches} />
          ) : active.id === "security" ? (
            <SecurityPanel matches={matches} />
          ) : active.id === "keys" ? (
            <KeyBindingsPanel matches={matches} />
          ) : active.id === "telemetry" ? (
            <TelemetryPanel matches={matches} />
          ) : active.id === "storage" ? (
            <StoragePanel matches={matches} />
          ) : !active.built ? (
            <section className="settings-card">
              <p className="muted">This section is not built yet. Nothing in OneOpen reads settings from it, so it shows no controls rather than ones that would do nothing.</p>
            </section>
          ) : (
            <>
              {error && <div className="modal-error">{error}</div>}
              {notice && <div className="validation-error media-captured">{notice}</div>}

              {matches("theme", "appearance", "accent", "window", "mica", "acrylic", "colour", "color") && (
                <section className="settings-card">
                  <header><Sliders size={14} /><div><strong>Application theme</strong><small>Window appearance and the accent used across the app.</small></div></header>

                  <div className="setting-row">
                    <span><strong>Appearance mode</strong><small>System follows the desktop theme.</small></span>
                    <span className="segmented" role="group" aria-label="Appearance mode">
                      {THEMES.map((option) => (
                        <button key={option.id} className={settings.theme === option.id ? "selected" : ""} aria-pressed={settings.theme === option.id} onClick={() => apply({ theme: option.id })}>
                          <option.icon size={12} /> {option.label}
                        </button>
                      ))}
                    </span>
                  </div>

                  <div className="setting-row">
                    <span><strong>Accent palette</strong><small>Used for selection, focus rings and active controls.</small></span>
                    <span className="accent-picker" role="group" aria-label="Accent palette">
                      {ACCENTS.map((accent) => (
                        <button
                          key={accent.id}
                          className={settings.accent === accent.id ? "selected" : ""}
                          aria-pressed={settings.accent === accent.id}
                          aria-label={accent.label}
                          title={accent.label}
                          onClick={() => apply({ accent: accent.id })}
                        >
                          <i style={{ background: accent.swatch }} /> {accent.label}
                        </button>
                      ))}
                    </span>
                  </div>

                  <div className="setting-row">
                    <span><strong>Window material</strong><small>Windows 11 only. OneOpen asks the window manager for the effect and reports back if it refuses.</small></span>
                    <span className="segmented" role="group" aria-label="Window material">
                      {EFFECTS.map((effect) => (
                        <button key={effect.id} className={settings.windowEffect === effect.id ? "selected" : ""} aria-pressed={settings.windowEffect === effect.id} onClick={() => apply({ windowEffect: effect.id })}>{effect.label}</button>
                      ))}
                    </span>
                  </div>
                </section>
              )}

              {matches("workspace", "session", "startup", "tabs", "density", "restore") && (
                <section className="settings-card">
                  <header><Folders size={14} /><div><strong>Workspace &amp; session</strong><small>What OneOpen does on launch, and how densely it packs the shell.</small></div></header>

                  <div className="setting-row">
                    <span><strong>Startup behaviour</strong><small>Restoring reopens the tabs that were open when OneOpen last closed.</small></span>
                    <span className="segmented" role="group" aria-label="Startup behaviour">
                      <button className={settings.restoreSession ? "selected" : ""} aria-pressed={settings.restoreSession} onClick={() => apply({ restoreSession: true })}>Restore session</button>
                      <button className={!settings.restoreSession ? "selected" : ""} aria-pressed={!settings.restoreSession} onClick={() => apply({ restoreSession: false })}>Blank slate</button>
                    </span>
                  </div>

                  <div className="setting-row">
                    <span><strong>Tab overflow</strong><small>What happens once open files outgrow the tab strip.</small></span>
                    <span className="segmented" role="group" aria-label="Tab overflow">
                      <button className={settings.tabOverflow === "scroll" ? "selected" : ""} aria-pressed={settings.tabOverflow === "scroll"} onClick={() => apply({ tabOverflow: "scroll" })}>Scrollable strip</button>
                      <button className={settings.tabOverflow === "wrap" ? "selected" : ""} aria-pressed={settings.tabOverflow === "wrap"} onClick={() => apply({ tabOverflow: "wrap" })}>Multi-row wrap</button>
                    </span>
                  </div>

                  <label className="setting-row toggle">
                    <span><strong>Compact density</strong><small>Tightens the sidebar, tab strip and inspector panels.</small></span>
                    <input type="checkbox" aria-label="Compact density" checked={settings.compactDensity} onChange={(event) => apply({ compactDensity: event.target.checked })} />
                  </label>
                </section>
              )}

              {matches("font", "typography", "ligatures", "figures", "size", "locale", "language") && (
                <section className="settings-card">
                  <header><Type size={14} /><div><strong>Typography</strong><small>The monospace face used by every code, hex and table view.</small></div></header>

                  <div className="setting-row">
                    <span><strong>Editor font</strong><small>Faces not installed on this machine are marked; the app never downloads one.</small></span>
                    <span className="segmented wrap" role="group" aria-label="Editor font">
                      {fonts.map((font) => (
                        <button
                          key={font.id}
                          className={settings.monoFont === font.id ? "selected" : ""}
                          aria-pressed={settings.monoFont === font.id}
                          title={font.available ? font.label : `${font.label} is not installed — the next font in the stack is used`}
                          onClick={() => apply({ monoFont: font.id })}
                        >
                          {font.label}{!font.available && <em> · missing</em>}
                        </button>
                      ))}
                    </span>
                  </div>

                  <div className="setting-row">
                    <span><strong>Editor font size</strong><small>Between 10 and 24 pixels.</small></span>
                    <span className="slider-control">
                      <input
                        type="range"
                        min={10}
                        max={24}
                        step={1}
                        aria-label="Editor font size"
                        value={settings.editorFontSize}
                        onChange={(event) => apply({ editorFontSize: Number(event.target.value) })}
                      />
                      <b>{settings.editorFontSize}px</b>
                    </span>
                  </div>

                  <label className="setting-row toggle">
                    <span><strong>Ligatures</strong><small>Joins <code>=&gt;</code> and <code>!=</code> in fonts that provide them.</small></span>
                    <input type="checkbox" aria-label="Ligatures" checked={settings.ligatures} onChange={(event) => apply({ ligatures: event.target.checked })} />
                  </label>

                  <label className="setting-row toggle">
                    <span><strong>Tabular figures</strong><small>Fixes digit width so numbers line up in tables and hex views.</small></span>
                    <input type="checkbox" aria-label="Tabular figures" checked={settings.tabularFigures} onChange={(event) => apply({ tabularFigures: event.target.checked })} />
                  </label>

                  <div className="setting-row">
                    <span><strong>Locale</strong><small>Reported by the system. OneOpen has no translations yet, so this only affects date and number formatting.</small></span>
                    <span className="setting-readout">{navigator.language || "Unknown"}</span>
                  </div>
                </section>
              )}

              {matches("editing", "wrap", "csv", "delimiter") && (
                <section className="settings-card">
                  <header><FileCode2 size={14} /><div><strong>Editing defaults</strong><small>Starting values for the editors; each file can still be switched by hand.</small></div></header>

                  <label className="setting-row toggle">
                    <span><strong>Word wrap</strong><small>Wrap long lines in the code and SQL editors.</small></span>
                    <input type="checkbox" aria-label="Word wrap" checked={settings.wordWrap} onChange={(event) => apply({ wordWrap: event.target.checked })} />
                  </label>

                  <div className="setting-row">
                    <span><strong>CSV delimiter</strong><small>Detect uses the file's extension.</small></span>
                    <span className="segmented" role="group" aria-label="CSV delimiter">
                      {DELIMITERS.map((option) => (
                        <button key={option.label} className={settings.csvDelimiter === option.id ? "selected" : ""} aria-pressed={settings.csvDelimiter === option.id} onClick={() => apply({ csvDelimiter: option.id })}>{option.label}</button>
                      ))}
                    </span>
                  </div>
                </section>
              )}

              {matches("shell", "explorer", "association", "registry", "context menu") && (
                <section className="settings-card muted-card">
                  <header><Shield size={14} /><div><strong>File associations &amp; shell integration</strong><small>Not offered here.</small></div></header>
                  <p className="muted">
                    Adding OneOpen to the Explorer context menu or claiming file types means writing to the
                    Windows registry. OneOpen does not change system settings from inside the app. Set defaults
                    through Windows Settings → Apps → Default apps.
                  </p>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The renderer actually in use, read from the user agent rather than assumed. */
function engineName(): string {
  const match = /Edg\/([\d.]+)/.exec(navigator.userAgent);
  if (match) return `WebView2 ${match[1].split(".")[0]}`;
  return /WebKit/.test(navigator.userAgent) ? "WebKit" : "System WebView";
}
