import React from 'react';
import ReactDOM from 'react-dom/client';
import './App.css'; // Ensure the stylesheet loads first
import App from './App';
import { ToastProvider } from './components/Toast';
import { initPerfTrace } from './lib/perfTrace';

// Dev-only probes (longtask / ipc / net); no-op in production builds.
initPerfTrace();

/**
 * Any uncaught render/effect error shows this recoverable screen instead of a
 * blank (or "closed") window. Clicking Restart reloads the webview in place.
 */
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[Thalamus] uncaught UI error:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            background: 'rgb(var(--tlm-bg))',
            color: 'rgb(var(--tlm-fg))',
            fontFamily: 'Segoe UI Variable, system-ui, sans-serif',
            padding: 24,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>Thalamus hit a rendering problem</div>
          <div style={{ fontSize: 11, color: 'rgb(var(--tlm-fg-muted))', maxWidth: 520 }}>
            {String(this.state.error.message || this.state.error)}
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'none',
              color: 'rgb(var(--tlm-fg))',
              padding: '8px 16px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Restart
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AppErrorBoundary>
  </React.StrictMode>
);
