import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * A crash in one screen should not blank the whole application. Data already
 * saved is on the server, so recovery is always just a reload.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallbackTitle: string; fallbackSub: string; reloadLabel: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ui]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-line bg-surface p-6 text-center shadow-card">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-warn" />
          <p className="text-sm font-semibold text-ink">{this.props.fallbackTitle}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{this.props.fallbackSub}</p>
          <pre className="mt-3 max-h-28 overflow-auto rounded border border-line bg-raised p-2 text-left text-[11px] text-muted">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink"
          >
            {this.props.reloadLabel}
          </button>
        </div>
      </div>
    );
  }
}
