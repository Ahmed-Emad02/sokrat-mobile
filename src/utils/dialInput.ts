export type DialSelection = { start: number; end: number };

/** Native selection offsets are clamped after programmatic number changes. */
export function editDialInput(text: string, selection: DialSelection, insert: string | null) {
  const start = Math.max(0, Math.min(text.length, selection.start));
  const end = Math.max(start, Math.min(text.length, selection.end));
  const from = insert === null && start === end ? Math.max(0, start - 1) : start;
  const replacement = insert ?? '';
  return {
    text: text.slice(0, from) + replacement + text.slice(end),
    selection: { start: from + replacement.length, end: from + replacement.length },
  };
}
