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

/** The numeric value the Settings presets write into CSS --text-scale. */
export function textScaleFor(size: TextSize): number {
  if (size === 'small') return 0.9;
  if (size === 'large') return 1.15;
  return 1;
}

/** Shift + wheel changes only the conversation text, in small live steps. */
export const CONTEXT_SCALE_MIN = 0.75;
export const CONTEXT_SCALE_MAX = 1.75;
export const CONTEXT_SCALE_STEP = 0.05;
export const DEFAULT_CONTEXT_SCALE = 1;

/** Stored values snap to the step grid so a persisted scale stays predictable. */
export function parseContextScale(value: string | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONTEXT_SCALE;
  const snapped = Number((Math.round(parsed / CONTEXT_SCALE_STEP) * CONTEXT_SCALE_STEP).toFixed(2));
  return Math.min(CONTEXT_SCALE_MAX, Math.max(CONTEXT_SCALE_MIN, snapped));
}

export function stepContextScale(current: number, direction: 1 | -1): number {
  const stepped = Number((current + direction * CONTEXT_SCALE_STEP).toFixed(2));
  return Math.min(CONTEXT_SCALE_MAX, Math.max(CONTEXT_SCALE_MIN, stepped));
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
