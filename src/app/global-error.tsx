"use client"; // Error boundaries must be Client Components

/**
 * Replaces the root layout when it fails, so it brings its own <html>/<body>
 * and inline styles (globals.css is not loaded here).
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "16px",
          background: "#08090d",
          color: "#eef2f6",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        }}
      >
        <title>ClearTrace — error</title>
        <main role="alert" style={{ maxWidth: 480 }}>
          <h1 style={{ fontSize: 24, margin: "0 0 12px" }}>ClearTrace hit an error</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "#cbd5e1", margin: 0 }}>
            ClearTrace hit an error while loading. If you had just started an action, it may or may not have finished — check before trying it again.
          </p>
          {error.digest && (
            <p style={{ fontSize: 12, color: "#8b95a8", marginTop: 12 }}>
              Error reference: <code>{error.digest}</code>
            </p>
          )}
          <button
            type="button"
            onClick={() => retry()}
            style={{
              marginTop: 20,
              padding: "10px 16px",
              borderRadius: 12,
              border: "none",
              background: "#2dd4bf",
              color: "#020617",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
