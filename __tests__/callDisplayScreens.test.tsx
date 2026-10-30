import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { RingingScreen } from '../src/ui/RingingScreen';
import { ActiveCallModal } from '../src/ui/ActiveCallModal';
import { RecentsTab } from '../src/ui/RecentsTab';
import { StandardPhoneScreen } from '../src/ui/StandardPhoneScreen';
import type { ActiveCall } from '../src/sip/JsSipService';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const noop = () => {};
const asyncNoop = async () => {};
const call: ActiveCall = {
  id: 'display-test', target: '*43', targetName: 'Unknown', direction: 'outbound',
  status: 'calling', isMuted: false, isHeld: false, session: {},
};
const record = { id: 'old', number: '+44 20 1234 5678', name: 'Unknown', direction: 'outbound' as const, timestamp: 1000 };
const standardProps: React.ComponentProps<typeof StandardPhoneScreen> = {
  account: null, state: 'registered', contacts: [], callsHistory: [record], activeCall: null,
  attendedTransferState: null, onCall: noop, onHangup: noop, onToggleMute: noop,
  onToggleHold: noop, onToggleSpeaker: noop, onSendDtmf: noop, onBlindTransfer: noop,
  onStartWarmTransfer: asyncNoop, onCompleteTransfer: asyncNoop,
  onCancelTransfer: asyncNoop, onSwapLines: asyncNoop, onSaveAccount: noop,
  onLogout: noop, onClearHistory: noop, onSaveContact: noop,
  onDeleteContact: noop, onToggleFavorite: noop,
};

let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }); });
afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); });
  jest.clearAllTimers();
  jest.useRealTimers();
});
async function textFrom(element: React.ReactElement): Promise<string[]> {
  await act(async () => { renderer = TestRenderer.create(element); });
  return renderer.root.findAllByType(Text).map(node => node.props.children).filter(value => typeof value === 'string');
}

test('incoming ringing screen shows a number, not the Unknown placeholder', async () => {
  const text = await textFrom(<RingingScreen callerId="204" callerName="Unknown" onAnswer={noop} onDecline={noop} />);
  expect(text).toContain('204');
  expect(text).not.toContain('Unknown');
});

test('active call modal shows an outgoing feature code when contact lookup missed', async () => {
  const text = await textFrom(<ActiveCallModal call={call} isMuted={false} isHeld={false} isSpeaker={false}
    onToggleMute={noop} onToggleHold={noop} onToggleSpeaker={noop} onSendDtmf={noop} onTransfer={noop} onHangup={noop} />);
  expect(text).toContain('*43');
  expect(text).not.toContain('Unknown');
});

test('legacy recents render the saved number instead of a persisted Unknown name', async () => {
  const text = await textFrom(<RecentsTab calls={[record]} onCallNumber={noop} onClearHistory={noop} />);
  expect(text).toContain(record.number);
  expect(text).not.toContain('Unknown');
});

test('main phone outgoing screen shows the target number', async () => {
  const text = await textFrom(<StandardPhoneScreen {...standardProps} activeCall={call} />);
  expect(text).toContain('*43');
  expect(text).not.toContain('Unknown');
});

test('main phone history displays numbers for old placeholder names', async () => {
  const text = await textFrom(<StandardPhoneScreen {...standardProps} />);
  expect(text).toContain(record.number);
  expect(text).not.toContain('Unknown');
});

test('ringing screen keeps resolved contact names alongside the number', async () => {
  const text = await textFrom(<RingingScreen callerId="204" callerName="Colleague" onAnswer={noop} onDecline={noop} />);
  expect(text).toContain('Colleague');
  expect(text).toContain('204');
});
