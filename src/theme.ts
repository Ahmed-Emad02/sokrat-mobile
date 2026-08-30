/**
 * Sokrat VOICE mobile theme — matches the web softphone dark palette.
 * Slate dark base + emerald accent from public/css/softphone.css.
 */
export const COLORS = {
  bg: '#0f172a',          // slate-900
  bgElevated: '#1e293b',  // slate-800
  surface: '#334155',     // slate-700
  border: '#1e293b',
  text: '#ffffff',
  textDim: '#cbd5e1',     // slate-300
  textMuted: '#94a3b8',   // slate-400
  accent: '#10b981',      // emerald-500
  accentDark: '#059669',  // emerald-600
  danger: '#ef4444',      // red-500
  dangerDark: '#dc2626',  // red-600
  warn: '#f59e0b',        // amber-500
  info: '#38bdf8',        // sky-400
};

/**
 * Set the android navigation + status bars to the Sokrat dark background.
 */
export function applySystemBars() {
  const { Platform, StatusBar } = require('react-native');
  StatusBar.setBarStyle('light-content');
  StatusBar.setBackgroundColor(COLORS.bg);
  if (Platform.OS === 'android') {
    const { NativeModules } = require('react-native');
    try {
      NativeModules.ThemedStatusBar?.setBackgroundColor?.(COLORS.bg);
    } catch (_) {}
  }
}
