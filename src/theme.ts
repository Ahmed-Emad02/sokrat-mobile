/**
 * Sokrat VOICE mobile theme.
 *
 * Dark: near-black zinc surfaces + brand red accents.
 * Light: white/soft-zinc surfaces + deeper red accents.
 * The active palette follows the system color scheme.
 */
import { Platform, StatusBar, useColorScheme } from 'react-native';

export interface ThemeColors {
  // Surfaces
  bg: string;
  surface: string;
  surfaceAlt: string;
  surfaceDeep: string;
  surfaceInput: string;
  surfaceElevated: string;
  badgeBg: string;
  toastBg: string;
  // Borders
  border: string;
  borderStrong: string;
  borderSoft: string;
  // Text
  text: string;
  textDim: string;
  textMuted: string;
  textFaint: string;
  onBrand: string;
  // Brand (red)
  brand: string;
  brandFill: string;
  brandBright: string;
  brandDeep: string;
  brandText: string;
  brandSoft: string;
  brandBorder: string;
  // Danger
  danger: string;
  dangerFill: string;
  dangerText: string;
  dangerSoft: string;
  dangerBorder: string;
  // Success
  success: string;
  successFill: string;
  successText: string;
  successSoft: string;
  successBorder: string;
  // Warning
  warning: string;
  warningFill: string;
  warningText: string;
  warningSoft: string;
  warningBorder: string;
  // Misc
  overlay: string;
  shadow: string;
  // Legacy aliases used by older screens
  bgElevated: string;
  accent: string;
  accentDark: string;
  warn: string;
  info: string;
}

export const darkColors: ThemeColors = {
  bg: '#000000',
  surface: '#18181B',
  surfaceAlt: '#27272A',
  surfaceDeep: '#09090B',
  surfaceInput: '#09090B',
  surfaceElevated: '#1F1F23',
  badgeBg: 'rgba(24,24,27,0.90)',
  toastBg: '#1E293BEE',

  border: '#27272A',
  borderStrong: '#3F3F46',
  borderSoft: '#1F1F23',

  text: '#FFFFFF',
  textDim: '#D4D4D8',
  textMuted: '#A1A1AA',
  textFaint: '#71717A',
  onBrand: '#FFFFFF',

  brand: '#EB1235',
  brandFill: '#D91E36',
  brandBright: '#FF3B5C',
  brandDeep: '#A60D24',
  brandText: '#FF8FA3',
  brandSoft: 'rgba(235,18,53,0.14)',
  brandBorder: 'rgba(235,18,53,0.35)',

  danger: '#DC2626',
  dangerFill: '#DC2626',
  dangerText: '#F87171',
  dangerSoft: 'rgba(220,38,38,0.15)',
  dangerBorder: '#450A0A',

  success: '#10B981',
  successFill: '#16A34A',
  successText: '#10B981',
  successSoft: '#064E3B',
  successBorder: '#064E3B',

  warning: '#F59E0B',
  warningFill: '#F59E0B',
  warningText: '#F59E0B',
  warningSoft: '#78350F',
  warningBorder: '#78350F',

  overlay: 'rgba(0,0,0,0.85)',
  shadow: '#000000',

  bgElevated: '#27272A',
  accent: '#EB1235',
  accentDark: '#A60D24',
  warn: '#F59E0B',
  info: '#EB1235',
};

export const lightColors: ThemeColors = {
  bg: '#F5F5F7',
  surface: '#FFFFFF',
  surfaceAlt: '#EFEFF2',
  surfaceDeep: '#E7E7EA',
  surfaceInput: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  badgeBg: 'rgba(255,255,255,0.92)',
  toastBg: '#FFFFFFF2',

  border: '#E4E4E7',
  borderStrong: '#D4D4D8',
  borderSoft: '#F1F1F3',

  text: '#111113',
  textDim: '#3F3F46',
  textMuted: '#71717A',
  textFaint: '#A1A1AA',
  onBrand: '#FFFFFF',

  brand: '#C8102E',
  brandFill: '#D91E36',
  brandBright: '#B80D2A',
  brandDeep: '#A60D24',
  brandText: '#B80D2A',
  brandSoft: 'rgba(200,16,46,0.08)',
  brandBorder: 'rgba(200,16,46,0.28)',

  danger: '#DC2626',
  dangerFill: '#DC2626',
  dangerText: '#B91C1C',
  dangerSoft: '#FEE2E2',
  dangerBorder: '#FECACA',

  success: '#16A34A',
  successFill: '#16A34A',
  successText: '#15803D',
  successSoft: '#DCFCE7',
  successBorder: '#BBF7D0',

  warning: '#F59E0B',
  warningFill: '#F59E0B',
  warningText: '#B45309',
  warningSoft: '#FEF3C7',
  warningBorder: '#FDE68A',

  overlay: 'rgba(0,0,0,0.35)',
  shadow: '#000000',

  bgElevated: '#EFEFF2',
  accent: '#C8102E',
  accentDark: '#A60D24',
  warn: '#B45309',
  info: '#C8102E',
};

/** Backwards-compatible dark palette for legacy screens that still import COLORS. */
export const COLORS = darkColors;

export function useTheme(): { colors: ThemeColors; isDark: boolean } {
  const scheme = useColorScheme();
  const isDark = scheme !== 'light';
  return { colors: isDark ? darkColors : lightColors, isDark };
}

export function applySystemBars(isDark: boolean) {
  const colors = isDark ? darkColors : lightColors;
  StatusBar.setBarStyle(isDark ? 'light-content' : 'dark-content', true);
  if (Platform.OS === 'android') {
    const { NativeModules } = require('react-native');
    try {
      NativeModules.ThemedStatusBar?.setBackgroundColor?.(colors.bg);
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Legacy colour transform
//
// The screens were built with hard-coded zinc/sky hex values. Instead of
// rewriting hundreds of style rules by hand, map each legacy value to a
// semantic role and resolve it against the active palette.
// ---------------------------------------------------------------------------

type ColorRole = keyof ThemeColors;

const LEGACY_ROLE_RAW: Record<string, ColorRole> = {
  '#000': 'bg',
  '#000000': 'bg',
  '#09090b': 'bg',
  '#111113': 'bg',
  '#121214': 'surface',
  '#121215': 'surface',
  '#141417': 'surface',
  '#18181b': 'surface',
  '#1f1f23': 'surfaceAlt',
  '#27272a': 'surfaceAlt',
  '#3f3f46': 'borderStrong',
  '#71717a': 'textFaint',
  '#a1a1aa': 'textMuted',
  '#94a3b8': 'textDim',
  '#cbd5e1': 'textDim',
  '#f4f4f5': 'text',
  '#ffffff': 'text',

  '#38bdf8': 'brand',
  '#93c5fd': 'brandText',
  '#0284c7': 'brandFill',
  '#0369a1': 'brandDeep',
  '#0c2738': 'brandSoft',
  '#0c2838': 'brandSoft',
  '#082f49': 'brandSoft',
  '#7c3aed': 'brand',

  '#ef4444': 'dangerText',
  '#f87171': 'dangerText',
  '#dc2626': 'danger',
  '#991b1b': 'dangerSoft',
  '#450a0a': 'dangerSoft',
  '#7f1d1d': 'dangerBorder',
  '#271b1d': 'dangerSoft',

  '#10b981': 'success',
  '#16a34a': 'successFill',
  '#064e3b': 'successSoft',
  '#065f46': 'successSoft',
  '#052016': 'successSoft',

  '#f59e0b': 'warningText',
  '#78350f': 'warningSoft',

  '#1e293be6': 'toastBg',
  'rgba(56, 189, 248, 0.08)': 'brandSoft',
  'rgba(56, 189, 248, 0.1)': 'brandSoft',
  'rgba(56, 189, 248, 0.3)': 'brandBorder',
  'rgba(24, 24, 27, 0.9)': 'badgeBg',
  'rgba(24,24,27,0.85)': 'badgeBg',
  'rgba(0,0,0,0.85)': 'overlay',
};

// Colour literals in the legacy screens differ only in whitespace.
const LEGACY_ROLE: Record<string, ColorRole> = Object.fromEntries(
  Object.entries(LEGACY_ROLE_RAW).map(([key, role]) => [
    key.toLowerCase().replace(/\s+/g, ''),
    role,
  ]),
) as Record<string, ColorRole>;

type StyleOverrides = Record<string, Partial<Record<string, ColorRole>>>;

function isFilledRole(role?: ColorRole): boolean {
  return (
    role === 'brand' ||
    role === 'brandFill' ||
    role === 'brandDeep' ||
    role === 'success' ||
    role === 'successFill' ||
    role === 'danger' ||
    role === 'dangerFill' ||
    role === 'warning' ||
    role === 'warningFill'
  );
}

function resolveRole(
  prop: string,
  role: ColorRole,
  backgroundRole: ColorRole | undefined,
  colors: ThemeColors,
): string {
  if (prop === 'backgroundColor') {
    if (role === 'brand' || role === 'brandDeep') return colors.brandFill;
    if (role === 'dangerText' || role === 'danger') return colors.dangerFill;
    if (role === 'successText' || role === 'success') return colors.successFill;
    if (role === 'warningText' || role === 'warning') return colors.warningFill;
    if (role === 'text') return colors.surface;
    return colors[role];
  }

  if (prop === 'color') {
    if (role === 'brand' || role === 'brandFill') return colors.brand;
    if (role === 'success' || role === 'successFill') return colors.successText;
    if (role === 'danger' || role === 'dangerFill') return colors.dangerText;
    if (role === 'warning' || role === 'warningFill') return colors.warningText;
    if (role === 'bg') return colors.text;
    if (role === 'text') return isFilledRole(backgroundRole) ? colors.onBrand : colors.text;
    return colors[role];
  }

  if (prop === 'shadowColor') {
    if (role === 'bg' || role === 'text') return colors.shadow;
    if (role === 'brand' || role === 'brandFill' || role === 'brandText') return colors.brand;
    return colors[role];
  }

  // borders, tintColor, etc.
  if (role === 'text') return colors.border;
  if (role === 'bg') return colors.border;
  return colors[role];
}

/** Apply the active palette to a raw style map produced by the legacy screens. */
export function themedStyles<T extends Record<string, any>>(
  raw: T,
  colors: ThemeColors,
  overrides: StyleOverrides = {},
): T {
  const result: Record<string, any> = {};
  for (const [key, rule] of Object.entries(raw)) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      result[key] = rule;
      continue;
    }
    const next: Record<string, any> = { ...(rule as Record<string, any>) };
    const rawBg = typeof (rule as any).backgroundColor === 'string'
      ? String((rule as any).backgroundColor).toLowerCase().replace(/\s+/g, '')
      : undefined;
    const bgRole = rawBg ? LEGACY_ROLE[rawBg] : undefined;
    const ruleOverrides = overrides[key] || {};

    for (const [prop, value] of Object.entries(rule as Record<string, any>)) {
      if (typeof value !== 'string') continue;
      const lower = value.toLowerCase().replace(/\s+/g, '');
      const role = ruleOverrides[prop] || LEGACY_ROLE[lower];
      if (!role) continue;
      next[prop] = resolveRole(prop, role, bgRole, colors);
    }
    result[key] = next;
  }
  return result as T;
}
