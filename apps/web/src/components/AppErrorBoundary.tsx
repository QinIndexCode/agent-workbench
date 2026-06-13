import { Component, type ErrorInfo, type ReactNode } from "react";
import { getUiCopy } from "../i18n.js";

interface Props {
  children: ReactNode;
  language?: string | null;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("AppErrorBoundary caught an error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const ui = getUiCopy(this.props.language);
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "24px",
            background: "#050505",
            color: "#f4f4f5",
            fontFamily:
              'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            textAlign: "center"
          }}
        >
          <h1 style={{ fontSize: "20px", fontWeight: 680, margin: "0 0 12px" }}>
            {ui.thread.errorBoundaryTitle}
          </h1>
          <p style={{ color: "#a1a1aa", maxWidth: "480px", lineHeight: 1.5, margin: "0 0 24px" }}>
            {ui.thread.errorBoundaryDescription}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              minHeight: "36px",
              padding: "0 16px",
              color: "#09090b",
              fontSize: "13px",
              fontWeight: 600,
              background: "#f4f4f5",
              border: "1px solid #3f3f46",
              borderRadius: "8px",
              cursor: "pointer"
            }}
            type="button"
          >
            {ui.thread.errorBoundaryRefresh}
          </button>
          <pre
            style={{
              marginTop: "24px",
              padding: "12px",
              maxWidth: "640px",
              width: "100%",
              overflow: "auto",
              color: "#d4d4d8",
              fontSize: "12px",
              lineHeight: 1.45,
              background: "#111113",
              border: "1px solid #27272a",
              borderRadius: "8px",
              textAlign: "left"
            }}
          >
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
