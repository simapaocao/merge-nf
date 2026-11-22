import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppStateProvider } from './hooks/useAppState';
import './styles.css';

createRoot(document.getElementById('root')!).render(<AppStateProvider><App /></AppStateProvider>);
