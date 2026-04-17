import { Component } from "react";

/**
 * Minimal error boundary to contain component-level crashes. Used to wrap
 * experimental / peripheral features (e.g. Co-Pilot panel) so a render error
 * inside them doesn't blank out the entire app.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(err, info) {
    console.error("[ErrorBoundary]", err, info);
  }

  render() {
    if (this.state.err) {
      const label = this.props.label ?? "이 컴포넌트";
      return (
        <div
          style={{
            padding: 12,
            background: "#2a1a1a",
            border: "1px solid #e85050",
            borderRadius: 4,
            color: "#e85050",
            fontSize: 11,
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            overflow: "auto",
            maxHeight: 240,
          }}
        >
          <strong>⚠️ {label} 에러</strong>
          <br />
          {String(this.state.err?.message ?? this.state.err)}
          {this.state.err?.stack && (
            <>
              <br />
              <br />
              <span style={{ opacity: 0.7, fontSize: 10 }}>{this.state.err.stack.slice(0, 400)}</span>
            </>
          )}
          <br />
          <button
            type="button"
            onClick={() => this.setState({ err: null })}
            style={{
              marginTop: 8,
              padding: "3px 8px",
              background: "transparent",
              border: "1px solid #e85050",
              color: "#e85050",
              cursor: "pointer",
              fontSize: 10,
            }}
          >
            다시 시도
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
