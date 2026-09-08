import { Suspense, lazy, useCallback, useMemo, useRef } from "react";
import { handlerFor } from "../handlers/registry";
import { useWorkspace, type WorkspaceTab } from "../stores/workspace";
import { ViewerErrorBoundary } from "../components/ViewerErrorBoundary";

export function ViewerHost({ tab }: { tab: WorkspaceTab }) {
  const Viewer = useMemo(() => lazy(handlerFor(tab.file.handlerId).load), [tab.file.handlerId]);
  const setDirty = useWorkspace((state) => state.setDirty);
  const setStatus = useWorkspace((state) => state.setStatus);
  const previewMeasured = useRef(false);
  const handleDirtyChange = useCallback((dirty: boolean) => setDirty(tab.id, dirty), [setDirty, tab.id]);
  const handleStatusChange = useCallback((status: string) => {
    setStatus(tab.id, status);
    if (!previewMeasured.current && import.meta.env.DEV) {
      previewMeasured.current = true;
      performance.measure("time to first preview", `preview-${tab.id}`);
      const entry = performance.getEntriesByName("time to first preview").at(-1);
      if (entry) console.debug(`[perf] time to first preview: ${entry.duration.toFixed(1)}ms`);
    }
  }, [setStatus, tab.id]);

  return (
    <ViewerErrorBoundary resetKey={`${tab.id}-${tab.loadKey}`}>
      <Suspense fallback={<div className="center muted">Loading viewer…</div>}>
        <Viewer
          key={`${tab.id}-${tab.loadKey}`}
          file={tab.file}
          tabId={tab.id}
          onDirtyChange={handleDirtyChange}
          onStatusChange={handleStatusChange}
        />
      </Suspense>
    </ViewerErrorBoundary>
  );
}
