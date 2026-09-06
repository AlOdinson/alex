import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './eraser-object-only.css';
import './floating-drawing-controls.css';

createRoot(document.getElementById('root')).render(<App />);
