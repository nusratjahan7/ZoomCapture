import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from './components/Toast';
import '@/styles/globals.css';

/** Renders an extension page's root component with the shared providers. */
export function mountPage(App: ComponentType, options: { toastPlacement?: 'bottom-right' | 'bottom-center' } = {}) {
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing #root element.');
  createRoot(container).render(
    <StrictMode>
      <ToastProvider placement={options.toastPlacement}>
        <App />
      </ToastProvider>
    </StrictMode>,
  );
}
