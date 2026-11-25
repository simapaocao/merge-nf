import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppStateProvider } from './hooks/useAppState';
import { installMobileZoomGuard } from './lib/mobileViewport';
import './styles.css';

installMobileZoomGuard();
createRoot(document.getElementById('root')!).render(<AppStateProvider><App /></AppStateProvider>);
