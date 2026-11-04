import { shouldIncrementChatUnread } from '../src/chat/unread';

describe('chat unread sender guard', () => {
  test('does not create unread state for the account\'s own echo', () => {
    expect(shouldIncrementChatUnread('111', '111')).toBe(false);
  });

  test('creates unread state for another extension', () => {
    expect(shouldIncrementChatUnread('102', '111')).toBe(true);
  });

  test('ignores an empty sender identifier', () => {
    expect(shouldIncrementChatUnread('', '111')).toBe(false);
  });
});
