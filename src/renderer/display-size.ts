export const DISPLAY_SIZES = [90, 100, 110, 125, 150] as const;

export type DisplaySize = (typeof DISPLAY_SIZES)[number];

export const DEFAULT_DISPLAY_SIZE: DisplaySize = 100;

/** Unknown or out-of-range values fall back to 100% instead of scaling oddly. */
export function parseDisplaySize(value: string | null | undefined): DisplaySize {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return DISPLAY_SIZES.includes(parsed as DisplaySize) ? (parsed as DisplaySize) : DEFAULT_DISPLAY_SIZE;
}

/** CSS zoom value for the size, applied to the document root. */
export function zoomFor(size: DisplaySize): string {
  return `${size}%`;
}
