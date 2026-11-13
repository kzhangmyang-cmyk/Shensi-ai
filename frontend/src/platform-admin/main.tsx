import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { installProductTheme } from '../theme';
import '../theme.css';
import './style.css';
import '../system-reference/reference.css';

createRoot(document.getElementById('platform-root')!).render(<App/>);
const disposeTheme = installProductTheme(document);
window.addEventListener('pagehide', disposeTheme, { once: true });
