import { useWorkspace } from "../stores/workspace";

export function ErrorBanner() {
  const error = useWorkspace((state) => state.error);
  const clear = useWorkspace((state) => state.clearError);
  if (!error) return null;
  return <div className="error-banner" role="alert"><span>{error}</span><button onClick={clear}>Dismiss</button></div>;
}
