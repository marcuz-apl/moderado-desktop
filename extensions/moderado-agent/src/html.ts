/**
 * HTML escaping shared by the chat and settings renderers.
 *
 * Kept in its own module so `chat-view.ts` and `settings-view.ts` can both use it
 * without importing each other.
 */

/** Escapes untrusted transcript, model, or provider text before it becomes HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}