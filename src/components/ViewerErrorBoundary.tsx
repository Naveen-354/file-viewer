import { Component, type ErrorInfo, type ReactNode } from "react";

export class ViewerErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error("Viewer failed", error.name, info.componentStack);
  }

  componentDidUpdate(previous: Readonly<{ children: ReactNode; resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (this.state.error) return <div className="error-state"><h2>Preview unavailable</h2><p>{this.state.error.message}</p><button className="secondary" onClick={() => this.setState({ error: null })}>Retry</button></div>;
    return this.props.children;
  }
}
