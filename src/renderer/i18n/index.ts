import { en } from './en';
import { fr } from './fr';
import { zhHans } from './zh-Hans';
import { zhHant } from './zh-Hant';
import { ja } from './ja';
import { ko } from './ko';
import { es } from './es';
import { de } from './de';
import { ru } from './ru';

export const LANGUAGES = ['en', 'fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'de', 'ru'] as const;

export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'en';

/** Each name is written in its own language, so the list reads the same in every pack. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  fr: 'Français',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  de: 'Deutsch',
  ru: 'Русский',
};

const PACKS: Record<Language, Record<string, string>> = { en, fr, 'zh-Hans': zhHans, 'zh-Hant': zhHant, ja, ko, es, de, ru };

let current: Language = DEFAULT_LANGUAGE;

export function parseLanguage(value: string | null | undefined): Language {
  return LANGUAGES.includes(value as Language) ? (value as Language) : DEFAULT_LANGUAGE;
}

export function activeLanguage(): Language {
  return current;
}

function lookup(language: Language, phrase: string): string {
  return PACKS[language][phrase] ?? phrase;
}

/** Translates one phrase for the active language; unknown phrases stay as written. */
export function t(phrase: string): string {
  return lookup(current, phrase);
}

// Each translated node remembers the English source it came from, so switching
// language twice never translates a translation. The record is also refreshed
// when render code replaces the text with new English.
const textSources = new Map<Text, string>();
const attributeSources = new Map<Element, Map<string, string>>();

const ATTRIBUTES = ['title', 'aria-label', 'placeholder'] as const;
/** Prose, code, and live conversation keep the language they were written in.
 * Elements whose copy is written with t() by render code also carry
 * data-no-i18n: their text is already translated, so recording it as an
 * English source would strand it when the language changes again. */
const OPAQUE = 'script,style,code,pre,textarea,.message,.markdown-body,.terminal-host,.mention-menu,[data-no-i18n]';
/** A textarea's own placeholder is interface copy; only its contents are opaque. */
const OPAQUE_ATTRIBUTES = 'script,style,code,pre,.message,.markdown-body,.terminal-host,.mention-menu,[data-no-i18n]';
/** Lists rebuild from data, so their English labels are set by the render code. */
const USER_CONTENT = '#library-list,#project-tree,#source-changes,#commit-history,#checkpoint-list,#schedule-list,.monitor-list,#attachment-chips,#selected-model,#model-usage,#workspace-context';
const KEEP = `${OPAQUE},${USER_CONTENT}`;
const KEEP_ATTRIBUTES = `${OPAQUE_ATTRIBUTES},${USER_CONTENT}`;

function inside(node: Node, selector: string): boolean {
  const parent = node.parentElement;
  return !parent || Boolean(parent.closest(selector));
}

/**
 * Recognizes values this module produced and keeps their English source;
 * anything else is new content and becomes the source. Two details matter:
 * text nodes keep their surrounding whitespace ("API key " before a nested
 * span) while pack keys are trimmed, so the comparison uses the trimmed core;
 * and the tree is translated twice per switch (once by applyLanguage, once over
 * what the render code rebuilt), while a switch can arrive from *any* of the
 * nine languages. Matching only the last two languages let a translation be
 * mistaken for fresh English and left behind permanently.
 */
function sourceOf(recorded: string | undefined, value: string): string {
  if (recorded === undefined) return value;
  const source = recorded.trim();
  const content = value.trim();
  if (content === source) return recorded;
  if (LANGUAGES.some((language) => lookup(language, source) === content)) return recorded;
  return value;
}

function translateTextNode(node: Text): void {
  if (!node.data.trim()) return;
  const source = sourceOf(textSources.get(node), node.data);
  textSources.set(node, source);
  const core = source.trim();
  const translated = lookup(current, core);
  node.data = translated === core ? source : source.replace(core, translated);
}

function translateAttributes(element: Element): void {
  for (const name of ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (!value?.trim()) continue;
    const records = attributeSources.get(element) ?? new Map<string, string>();
    attributeSources.set(element, records);
    const source = sourceOf(records.get(name), value);
    records.set(name, source);
    element.setAttribute(name, lookup(current, source.trim()));
  }
}

/** Translates static shell text and labels under one root. */
export function translateTree(root: ParentNode): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text && !inside(node, KEEP)) translateTextNode(node);
  }
  if (root instanceof Element) translateAttributes(root);
  const attributes = Array.from(ATTRIBUTES, (name) => `[${name}]`).join(',');
  root.querySelectorAll(attributes).forEach((element) => {
    if (!inside(element, KEEP_ATTRIBUTES)) translateAttributes(element);
  });
}

/** Applies one language to the whole document and records it for persistence. */
export function applyLanguage(language: Language): void {
  current = language;
  document.documentElement.lang = language;
  translateTree(document.body);
}
