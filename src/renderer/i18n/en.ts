/**
 * English is the source language: every key in the other packs is an English
 * phrase, and a missing key stays as written. The empty pack makes that
 * fallback explicit instead of hiding it in the lookup.
 */
export const en: Record<string, string> = {};
