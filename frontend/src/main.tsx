import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ServicesContext } from './services';
import { createBrowserMockServices } from './services/mock';
import { App } from './ui/App';
import './styles.css';

// The ONLY place that chooses a backend. Replace with a real implementation of `Services` later.
const services = createBrowserMockServices();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServicesContext.Provider value={services}>
      <App />
    </ServicesContext.Provider>
  </StrictMode>,
);
