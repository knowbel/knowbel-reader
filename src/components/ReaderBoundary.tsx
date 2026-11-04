import { Component, type ReactNode } from "react";

// A failed lazy module or reader render must leave a way back to the
// library instead of unmounting the entire application to a blank window.
export default class ReaderBoundary extends Component<{
  title: string;
  onHome: () => void;
  children: ReactNode;
}, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <div className="reader-error" role="alert">
      <p>Couldn’t open “{this.props.title}”.</p>
      <p>{this.state.error.message}</p>
      <button type="button" onClick={this.props.onHome}>Return to library</button>
    </div>;
  }
}
