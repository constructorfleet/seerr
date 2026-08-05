/**
 * Contains a panel's render failures.
 *
 * A panel is third-party code loaded at runtime, so it throwing is an expected
 * outcome rather than a bug in Seerr. Without a boundary the throw unmounts the
 * whole app tree — nav, sidebar and all — which would make one broken extension
 * look like Seerr itself had crashed.
 *
 * A class component because that is still the only way to catch a render error;
 * there is no hook equivalent.
 */
import Alert from '@app/components/Common/Alert';
import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

interface PanelErrorBoundaryProps {
  /** Named in the message, so the user can tell which extension misbehaved. */
  title: string;
  children: ReactNode;
}

interface PanelErrorBoundaryState {
  message?: string;
}

class PanelErrorBoundary extends Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  public state: PanelErrorBoundaryState = {};

  public static getDerivedStateFromError(
    error: unknown
  ): PanelErrorBoundaryState {
    return {
      message: error instanceof Error ? error.message : String(error),
    };
  }

  public componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Left in the browser console rather than reported anywhere: the failure is
    // in extension code, and its stack is only meaningful to whoever wrote it.
    // eslint-disable-next-line no-console
    console.error('[seerr] extension panel failed to render', error, info);
  }

  public render(): ReactNode {
    if (this.state.message !== undefined) {
      return (
        <Alert title={`The ${this.props.title} panel could not be shown`}>
          {this.state.message}
        </Alert>
      );
    }

    return this.props.children;
  }
}

export default PanelErrorBoundary;
