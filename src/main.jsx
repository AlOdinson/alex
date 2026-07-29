import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

console.info('[Alex Board] 1.0.8 — Immediate Apple Pencil tool switching');

createRoot(document.getElementById('root')).render(<App />);
