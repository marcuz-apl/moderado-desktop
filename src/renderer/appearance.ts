export const FONT_FAMILIES = ['sans', 'arial', 'serif', 'new-roman'] as const;

export type FontFamily = (typeof FONT_FAMILIES)[number];

export const DEFAULT_FONT_FAMILY: FontFamily = 'sans';

/** Unknown values fall back to the system sans stack instead of an unstyled face. */
export function parseFontFamily(value: string | null | undefined): FontFamily {
  return FONT_FAMILIES.includes(value as FontFamily) ? (value as FontFamily) : DEFAULT_FONT_FAMILY;
}

export const TEXT_SIZES = ['small', 'medium', 'large'] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

export const DEFAULT_TEXT_SIZE: TextSize = 'medium';

export function parseTextSize(value: string | null | undefined): TextSize {
  return TEXT_SIZES.includes(value as TextSize) ? (value as TextSize) : DEFAULT_TEXT_SIZE;
}

export const UI_SCALES = ['medium', 'large'] as const;

export type UiScale = (typeof UI_SCALES)[number];

export const DEFAULT_UI_SCALE: UiScale = 'medium';

/**
 * Accepts the two scale names plus the percentages the retired Display size
 * control stored, so an existing preference keeps its intent.
 */
export function parseUiScale(value: string | null | undefined): UiScale {
  if (UI_SCALES.includes(value as UiScale)) return value as UiScale;
  // The retired control stored exactly these two percentages; anything else is noise.
  if (value === '125') return 'large';
  if (value === '100') return 'medium';
  return DEFAULT_UI_SCALE;
}

/** CSS zoom for the whole window; text size scales on top of it. */
export function zoomFor(scale: UiScale): string {
  return scale === 'large' ? '125%' : '100%';
}
