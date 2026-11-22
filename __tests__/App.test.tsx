/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App, { teardownRootEffect } from '../App';

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});

test('does not reset gateway ownership or disconnect SIP during a live call', () => {
  const reset = jest.fn();
  const disconnect = jest.fn();
  teardownRootEffect(true, reset, disconnect);
  expect(reset).not.toHaveBeenCalled();
  expect(disconnect).not.toHaveBeenCalled();

  teardownRootEffect(false, reset, disconnect);
  expect(reset).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
});
