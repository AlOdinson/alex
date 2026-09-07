import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './eraser-object-only.css';
import './floating-drawing-controls.css';
import './floating-drawing-controls-language-fix.css';
import './three-dot-drawing-controls.css';
import './ipad-system-color-palette.css';
import './ipad-system-color-palette-scale.css';
import './floating-drawing-controls-enhancer.js';
import './ipad-system-color-palette.js';
import './dock-style-accessories.css';
import './dock-style-accessories.js';
import './dock-style-presets-gear.js';

createRoot(document.getElementById('root')).render(<App />);
