import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/button';
import { EmptyState } from './ui/misc';
import { AlertTriangle } from 'lucide-react';

interface State {
  hasError: boolean;
}

/** Catches render errors so one broken widget never blanks the whole app. Shows no stack traces. */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Hook a self-hosted error reporter in here. Never send question text or results.
    console.error('UI error', error.name, info.componentStack?.split('\n')[1]?.trim());
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      this.props.fallback ?? (
        <EmptyState
          icon={<AlertTriangle />}
          title="This part of the page couldn't be displayed"
          description="Try again. If it keeps happening, contact your CodeLens administrator."
          action={
            <Button variant="outline" onClick={() => this.setState({ hasError: false })}>
              Try again
            </Button>
          }
        />
      )
    );
  }
}
