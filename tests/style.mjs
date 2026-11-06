import { readFile } from 'node:fs/promises';

/**
 * Collapses a stylesheet to one rule per statement with no formatting
 * whitespace, so assertions can match `width:56px` whether the file is written
 * one declaration per line or minified. The rules themselves are untouched:
 * only insignificant whitespace and comments are dropped.
 */
export function compactCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,])\s*/g, '$1')
    .replace(/([-a-zA-Z]):\s+/g, '$1:')
    .replace(/;}/g, '}')
    .trim();
}

/** The app stylesheet, ready to match against. */
export async function readStylesheet() {
  return compactCss(await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8'));
}
