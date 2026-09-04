import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  getDateLocale,
  getStoredLanguage,
  setStoredLanguage,
  translate,
  translateUiText,
} from '../i18n.js';

const LanguageContext = createContext(null);
const TRANSLATABLE_ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt'];
const textSources = new WeakMap();
const textOutputs = new WeakMap();
const attributeSources = new WeakMap();
const attributeOutputs = new WeakMap();

function shouldSkipNode(node) {
  const parent = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return Boolean(parent?.closest?.('[data-i18n-skip], canvas, [contenteditable="true"]'));
}

function sourceForText(node) {
  const current = node.nodeValue ?? '';
  const previousOutput = textOutputs.get(node);
  let source = textSources.get(node);
  if (source == null || current !== previousOutput) {
    source = current;
    textSources.set(node, source);
  }
  return source;
}

function sourceForAttribute(element, attribute) {
  const current = element.getAttribute(attribute);
  if (current == null) return null;
  let sources = attributeSources.get(element);
  let outputs = attributeOutputs.get(element);
  if (!sources) {
    sources = new Map();
    attributeSources.set(element, sources);
  }
  if (!outputs) {
    outputs = new Map();
    attributeOutputs.set(element, outputs);
  }
  const previousOutput = outputs.get(attribute);
  let source = sources.get(attribute);
  if (source == null || current !== previousOutput) {
    source = current;
    sources.set(attribute, source);
  }
  return { source, outputs };
}

function localizeElement(root, language) {
  if (!root || shouldSkipNode(root)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  if (root.nodeType === Node.TEXT_NODE) textNodes.unshift(root);

  textNodes.forEach((node) => {
    if (shouldSkipNode(node)) return;
    const source = sourceForText(node);
    const output = language === 'en' ? translateUiText('en', source) : source;
    textOutputs.set(node, output);
    if (node.nodeValue !== output) node.nodeValue = output;
  });

  const elements = [];
  if (root.nodeType === Node.ELEMENT_NODE) elements.push(root);
  if (root.querySelectorAll) elements.push(...root.querySelectorAll('*'));
  elements.forEach((element) => {
    if (shouldSkipNode(element)) return;
    TRANSLATABLE_ATTRIBUTES.forEach((attribute) => {
      const record = sourceForAttribute(element, attribute);
      if (!record) return;
      const output = language === 'en' ? translateUiText('en', record.source) : record.source;
      record.outputs.set(attribute, output);
      if (element.getAttribute(attribute) !== output) element.setAttribute(attribute, output);
    });
  });
}

export function LanguageProvider({ role, children }) {
  const [language, setLanguageState] = useState(() => getStoredLanguage(role));

  useEffect(() => {
    setLanguageState(getStoredLanguage(role));
  }, [role]);

  const setLanguage = useCallback((nextLanguage) => {
    setLanguageState(setStoredLanguage(role, nextLanguage));
  }, [role]);

  const t = useCallback((key, params) => translate(language, key, params), [language]);
  const ui = useCallback((value) => translateUiText(language, value), [language]);
  const formatDate = useCallback((value, options = {}) => {
    if (!value) return t('date.neverUsed');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t('date.unknown');
    return new Intl.DateTimeFormat(getDateLocale(language), {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...options,
    }).format(date);
  }, [language, t]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    document.documentElement.lang = language;
    const root = document.body;
    if (!root) return undefined;
    localizeElement(root, language);

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'characterData') localizeElement(mutation.target, language);
        mutation.addedNodes.forEach((node) => localizeElement(node, language));
        if (mutation.type === 'attributes') localizeElement(mutation.target, language);
      });
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES,
    });
    return () => observer.disconnect();
  }, [language]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const originalConfirm = window.confirm.bind(window);
    const originalPrompt = window.prompt.bind(window);
    window.confirm = (message) => originalConfirm(ui(message));
    window.prompt = (message, defaultValue) => originalPrompt(ui(message), defaultValue);
    return () => {
      window.confirm = originalConfirm;
      window.prompt = originalPrompt;
    };
  }, [ui]);

  const value = useMemo(() => ({ language, setLanguage, t, ui, formatDate, role }), [
    language,
    setLanguage,
    t,
    ui,
    formatDate,
    role,
  ]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used inside LanguageProvider');
  return context;
}
