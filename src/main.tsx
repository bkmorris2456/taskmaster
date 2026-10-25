import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { App } from './app/App';
import { ErrorBoundary } from './app/ErrorBoundary';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Taskmaster root element is missing.');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider
        router={createBrowserRouter([{ path: '*', element: <App /> }])}
      />
    </ErrorBoundary>
  </StrictMode>,
);
