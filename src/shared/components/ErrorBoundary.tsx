import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon, ClipboardCopy, RotateCcw } from 'lucide-react';
import { diagnosticReport, logDiagnostic, sanitize } from '@/services/diagnostics';
import { Button } from './Button';

/**
 * Catches a rendering error in a page (or part of one) so the page shows what happened and how to
 * continue, instead of going blank. The error is logged without recording content. Recordings are
 * stored separately (IndexedDB) and are not affected by a page error.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; area: string; compact?: boolean }, { error: Error | null; copied: boolean }> {
  state = { error: null as Error | null, copied: false };

  static getDerivedStateFromError(error: Error) {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logDiagnostic(`render:${this.props.area}`, Object.assign(error, { stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}` }));
  }

  private copyReport = async () => {
    try {
      await navigator.clipboard.writeText(await diagnosticReport({ area: this.props.area }));
      this.setState({ copied: true });
    } catch {
      // Clipboard unavailable: the report is also in Settings.
    }
  };

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className={this.props.compact ? 'm-3 rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm' : 'mx-auto mt-[15vh] max-w-lg rounded-2xl border border-danger/30 bg-surface p-6 text-sm'} data-testid="error-boundary">
        <p className="flex items-center gap-2 text-base font-semibold text-danger">
          <AlertOctagon size={18} aria-hidden /> Something went wrong {this.props.compact ? 'here' : 'on this page'}
        </p>
        <p className="mt-2 text-fg-muted">{sanitize(error.message) || 'An unexpected error occurred.'}</p>
        <p className="mt-2 text-fg-muted">Your recordings are safe: they are stored separately and nothing was deleted. Edits are saved as you make them.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" icon={RotateCcw} onClick={() => window.location.reload()}>
            Reload
          </Button>
          {this.props.compact && (
            <Button icon={RotateCcw} onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          )}
          <Button icon={ClipboardCopy} onClick={() => void this.copyReport()}>
            {copied ? 'Report copied' : 'Copy diagnostic report'}
          </Button>
        </div>
        <p className="mt-3 text-xs text-fg-subtle">The report has versions, storage use and recent errors, with names and addresses removed. It is only copied to your clipboard.</p>
      </div>
    );
  }
}
