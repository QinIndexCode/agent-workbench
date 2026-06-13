import { Component, type ErrorInfo, type ReactNode } from "react";

export class PanelBoundary extends Component<
  { name: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Side panel failed: ${this.props.name}`, error, info.componentStack);
  }

  componentDidUpdate(previousProps: { name: string }) {
    if (previousProps.name !== this.props.name && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <section className="panelError">
          <h2>{this.props.name}</h2>
          <p>This panel could not render because stored data is incomplete.</p>
          <pre>{this.state.error.message}</pre>
        </section>
      );
    }
    return this.props.children;
  }
}
