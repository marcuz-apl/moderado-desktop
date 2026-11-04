import { en } from './en';
import { fr } from './fr';

export const LANGUAGES = ['en', 'fr'] as const;

export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'en';

/** Each name is written in its own language, so the list reads the same in every pack. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', fr: 'Français' };

const PACKS: Record<Language, Record<string, string>> = { en, fr };

let current: Language = DEFAULT_LANGUAGE;
let previous: Language = DEFAULT_LANGUAGE;

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
/** Prose, code, and live conversation keep the language they were written in. */
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
 * Recognizes values this module produced (in the language it last applied) and
 * keeps their English source; anything else is new content and becomes the source.
 */
function sourceOf(recorded: string | undefined, value: string): string {
  if (recorded === undefined) return value;
  if (value === recorded || value === lookup(previous, recorded)) return recorded;
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
  previous = current;
  current = language;
  document.documentElement.lang = language;
  translateTree(document.body);
}
