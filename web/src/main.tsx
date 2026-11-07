import '@fontsource-variable/fredoka/wght.css';
import '@fontsource-variable/figtree/wght.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/app.css';
import './styles/map.css';
import './styles/sheet.css';
import './styles/characters.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
