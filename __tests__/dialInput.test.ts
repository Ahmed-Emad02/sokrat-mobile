import { editDialInput } from '../src/utils/dialInput';

describe('dial input selection editing', () => {
  test('inserts keypad digits at the native caret', () => {
    expect(editDialInput('1234', { start: 2, end: 2 }, '0')).toEqual({
      text: '12034', selection: { start: 3, end: 3 },
    });
  });
  test('replaces selected text with a keypad digit', () => {
    expect(editDialInput('1234', { start: 1, end: 3 }, '#')).toEqual({
      text: '1#4', selection: { start: 2, end: 2 },
    });
  });
  test('backspace deletes selected text', () => {
    expect(editDialInput('+1234', { start: 1, end: 5 }, null)).toEqual({
      text: '+', selection: { start: 1, end: 1 },
    });
  });
  test('backspace deletes before the caret and is safe at the start', () => {
    expect(editDialInput('1234', { start: 2, end: 2 }, null).text).toBe('134');
    expect(editDialInput('1234', { start: 0, end: 0 }, null).text).toBe('1234');
  });
  test('handles empty input and stale offsets', () => {
    expect(editDialInput('', { start: 20, end: 20 }, '+')).toEqual({
      text: '+', selection: { start: 1, end: 1 },
    });
    expect(editDialInput('', { start: 0, end: 0 }, null).text).toBe('');
  });
});
