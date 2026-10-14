import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { installGlobalErrorLogging } from '@/services/diagnostics';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import '@/styles/globals.css';

/** Renders an extension page's root component with the shared providers. */
export function mountPage(App: ComponentType, options: { toastPlacement?: 'bottom-right' | 'bottom-center' } = {}) {
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing #root element.');
  // "editor", "recording", "popup", "settings": from the page's folder.
  const page = location.pathname.split('/').filter(Boolean).at(-2) ?? 'page';
  installGlobalErrorLogging(page);
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary area={page}>
        <ToastProvider placement={options.toastPlacement}>
          <App />
        </ToastProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}
