import { useWorkspace } from "../stores/workspace";

export function TabBar() {
  const { tabs, activeId, activate, closeTab } = useWorkspace();

  const close = (id: string) => {
    if (closeTab(id)) return;
    if (window.confirm("Discard unsaved changes?")) closeTab(id, true);
  };

  return (
    <div className="tabbar" role="tablist" aria-label="Open files">
      {tabs.map((tab) => (
        <div className={`tab ${tab.id === activeId ? "active" : ""}`} key={tab.id} role="tab" aria-selected={tab.id === activeId} tabIndex={tab.id === activeId ? 0 : -1} onClick={() => activate(tab.id)}>
          <span className="tab-name" title={tab.file.path}>{tab.file.name}</span>
          {tab.dirty && <span className="dirty" aria-label="Unsaved">●</span>}
          <button className="icon-button" aria-label={`Close ${tab.file.name}`} onClick={(event) => { event.stopPropagation(); close(tab.id); }}>×</button>
        </div>
      ))}
    </div>
  );
}
