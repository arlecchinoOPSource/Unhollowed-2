import { Component, type ReactNode } from "react";
import { Link } from "react-router";

interface Props {
  children: ReactNode;
  /** Changing it (the route) clears a previous failure. */
  resetKey: string;
}

interface State {
  failed: boolean;
  resetKey: string;
}

/**
 * Keeps one page's unexpected render error from blanking the whole window.
 * The sidebar stays usable. The message is fixed text: the error itself is
 * never shown, because it could contain workspace content.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State) {
    return props.resetKey === state.resetKey
      ? null
      : { failed: false, resetKey: props.resetKey };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section role="alert" className="route-error">
        <h1>Something went wrong on this page</h1>
        <p>
          Your saved work is not affected. Text you were typing in a document is
          kept and offered back when you return to it.
        </p>
        <p>
          <button
            type="button"
            className="action"
            onClick={() => this.setState({ failed: false })}
          >
            Try again
          </button>{" "}
          <Link to="/">Go to Home</Link>
        </p>
      </section>
    );
  }
}
