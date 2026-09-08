import { useState } from "react";
import { Keyboard, Search, Sparkles } from "lucide-react";
import {
  GLOBAL_SHORTCUTS, SCOPED_SHORTCUTS, matchesQuery, shortcutCount,
} from "../utils/shortcuts";

export function KeyBindingsPanel({ matches }: { matches: (...text: string[]) => boolean }) {
  const [query, setQuery] = useState("");

  const globals = GLOBAL_SHORTCUTS.filter((s) => matchesQuery(query, s.label, s.detail, [s.keys]));
  const groups = SCOPED_SHORTCUTS
    .map((group) => ({ ...group, rows: group.rows.filter((row) => matchesQuery(query, row.label, row.detail, row.keys)) }))
    .filter((group) => group.rows.length > 0);
  const shown = globals.length + groups.reduce((sum, group) => sum + group.rows.length, 0);

  if (!matches("key", "shortcut", "binding", "keyboard", "hotkey", "combination")) return null;

  return (
    <>
      <section className="settings-card">
        <header>
          <Keyboard size={14} />
          <div>
            <strong>Keyboard shortcuts</strong>
            <small>Every binding OneOpen responds to — {shortcutCount()} in total.</small>
          </div>
        </header>

        <div className="setting-row">
          <span><strong>Find a shortcut</strong><small>Matches the name, the description or the keys themselves.</small></span>
          <label className="doc-find">
            <Search size={12} />
            <input
              placeholder="e.g. rename, or ctrl+w"
              aria-label="Find a shortcut"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {query.trim() !== "" && (
          <p className="engine-note">{shown} of {shortcutCount()} shortcuts match.</p>
        )}

        {globals.length > 0 && (
          <div className="key-group">
            <h4>Anywhere in the app <span>{globals.length}</span></h4>
            {globals.map((shortcut) => (
              <div className="key-row" key={shortcut.id}>
                <span className="key-combo"><Combo keys={shortcut.keys} /></span>
                <span className="key-text">
                  <strong>{shortcut.label}</strong>
                  <small>{shortcut.detail}{shortcut.needsActiveTab ? " Needs a file open." : ""}</small>
                </span>
              </div>
            ))}
          </div>
        )}

        {groups.map((group) => (
          <div className="key-group" key={group.scope}>
            <h4>{group.scope} <span>{group.rows.length}</span></h4>
            <p className="key-scope-note">{group.note}</p>
            {group.rows.map((row) => (
              <div className="key-row" key={`${group.scope}-${row.label}-${row.keys[0].join("")}`}>
                <span className="key-combo">
                  {row.keys.map((combo, index) => (
                    <span key={combo.join("+")}>
                      {index > 0 && <em className="key-or">or</em>}
                      <Combo keys={combo} />
                    </span>
                  ))}
                </span>
                <span className="key-text">
                  <strong>{row.label}</strong>
                  <small>{row.detail}</small>
                </span>
                <span className="key-where" title={row.where}>{row.where}</span>
              </div>
            ))}
          </div>
        ))}

        {shown === 0 && <p className="muted">No shortcut matches “{query}”.</p>}
      </section>

      <section className="settings-card muted-card">
        <header><Sparkles size={14} /><div><strong>Remapping</strong><small>Not offered here.</small></div></header>
        <p className="muted">
          These bindings are fixed. OneOpen has no keymap editor, no preset profiles to emulate
          another editor, and no way to record or reassign a combination — so this page lists what
          the app does rather than pretending to configure it. Editor shortcuts inside the code and
          SQL views come from CodeMirror's standard keymap, which brings the usual selection and
          navigation bindings beyond the ones listed above.
        </p>
      </section>
    </>
  );
}

function Combo({ keys }: { keys: string[] }) {
  return (
    <>
      {keys.map((key, index) => (
        <span key={key}>
          {index > 0 && <i>+</i>}
          <kbd>{key}</kbd>
        </span>
      ))}
    </>
  );
}
