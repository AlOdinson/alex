import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './eraser-object-only.css';
import './floating-drawing-controls.css';
import './floating-drawing-controls-language-fix.css';
import './three-dot-drawing-controls.css';
import './ipad-system-color-palette.css';
import './floating-drawing-controls-enhancer.js';
import './ipad-system-color-palette.js';

createRoot(document.getElementById('root')).render(<App />);
