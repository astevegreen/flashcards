import {
  Component,
  createElement,
  lazy,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from 'react';
import { isChunkLoadError, retryImport } from './retryImport.ts';

export interface LazyWithRetryOptions<P> {
  /** Render nothing when the chunk can't load (for invisible helpers such as runtimes). */
  quiet?: boolean;
  /**
   * The component's own close callback prop (e.g. `onClose`). The inline message then gets a
   * Close button too, so a dialog that can't load doesn't leave its screen stuck "open".
   */
  closeWith?: keyof P;
}

/**
 * `React.lazy` that retries a failed import and is wrapped in `LazyErrorBoundary`, so a chunk that
 * still can't load shows a small inline message with Retry instead of blanking the app. The
 * caller's `<Suspense>` stays where it is.
 *
 * `React.lazy` remembers a rejected import forever, so the boundary's Retry (or the browser coming
 * back `online`) swaps in a fresh lazy component that imports again. The swap waits for Retry: a
 * fresh component during React's own error re-render would suspend again and loop.
 */
// Same constraint as `React.lazy`, so every existing loader keeps its inferred props.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
  options: LazyWithRetryOptions<ComponentProps<T>> = {},
): ComponentType<ComponentProps<T>> {
  type P = ComponentProps<T>;
  let failed = false;
  const createLazy = (): ComponentType<P> =>
    lazy(() =>
      retryImport(loader).catch((error: unknown) => {
        failed = true;
        throw error;
      }),
    ) as unknown as ComponentType<P>;
  let current = createLazy();
  const reset = () => {
    if (!failed) return;
    failed = false;
    current = createLazy();
  };

  function LazyWithRetry(props: P) {
    // Re-render here on Retry so the child element points at the fresh lazy component.
    const [attempt, setAttempt] = useState(0);
    const onRetry = () => {
      reset();
      setAttempt((n) => n + 1);
    };
    const close: unknown = options.closeWith === undefined ? undefined : props[options.closeWith];
    return createElement(
      LazyErrorBoundary,
      {
        quiet: options.quiet,
        onRetry,
        onClose: typeof close === 'function' ? () => (close as () => void)() : undefined,
      },
      createElement(current, { ...props, key: attempt }),
    );
  }
  return LazyWithRetry;
}

interface LazyErrorBoundaryProps {
  children?: ReactNode;
  quiet?: boolean | undefined;
  /** Called before the children render again, so a failed import can start over. */
  onRetry?: (() => void) | undefined;
  /** Shows a Close button next to Retry. */
  onClose?: (() => void) | undefined;
}

interface LazyErrorBoundaryState {
  error: unknown;
  failed: boolean;
}

const OFFLINE_MESSAGE =
  "This part of the app isn't available offline yet. Reconnect and try again.";
const BROKEN_MESSAGE = "This part of the app couldn't open. Try again.";
const BUTTON_CLASS =
  'rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-2)]';

/** Keeps a failed lazy screen, dialog or panel from taking the whole app down with it. */
export class LazyErrorBoundary extends Component<LazyErrorBoundaryProps, LazyErrorBoundaryState> {
  override state: LazyErrorBoundaryState = { error: undefined, failed: false };

  static getDerivedStateFromError(error: unknown): LazyErrorBoundaryState {
    return { error, failed: true };
  }

  override componentDidMount(): void {
    window.addEventListener('online', this.retry);
  }

  override componentWillUnmount(): void {
    window.removeEventListener('online', this.retry);
  }

  retry = (): void => {
    if (!this.state.failed) return;
    this.props.onRetry?.();
    this.setState({ error: undefined, failed: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.quiet) return null;
    const { onClose } = this.props;
    return (
      <div
        role="alert"
        className="mx-auto my-4 flex max-w-md flex-col items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm"
      >
        <p>{isChunkLoadError(this.state.error) ? OFFLINE_MESSAGE : BROKEN_MESSAGE}</p>
        <div className="flex gap-2">
          <button type="button" onClick={this.retry} className={BUTTON_CLASS}>
            Retry
          </button>
          {onClose && (
            <button type="button" onClick={onClose} className={BUTTON_CLASS}>
              Close
            </button>
          )}
        </div>
      </div>
    );
  }
}
