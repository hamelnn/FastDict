import React from 'react';
import ReactDOM from 'react-dom/client';
import BootErrorBoundary, { BootMounted } from './BootErrorBoundary';
import './styles.css';

// Keep the preloaded capture WebView independent of the translation workspace.
const captureRoute = new URLSearchParams(location.search).has('capture');
void (captureRoute ? import('./components/CaptureOverlay') : import('./App')).then(({ default: Screen }) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><BootErrorBoundary><BootMounted><Screen /></BootMounted></BootErrorBoundary></React.StrictMode>);
}).catch(() => {
  window.__FASTD_BOOT__?.fail('bootstrap-import-failed');
});
