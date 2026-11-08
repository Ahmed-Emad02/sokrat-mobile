import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ActivityIndicator, Text, View } from 'react-native';
import { RingingScreen } from '../src/ui/RingingScreen';
import { ActiveCallModal } from '../src/ui/ActiveCallModal';
import { RecentsTab } from '../src/ui/RecentsTab';
import { StandardPhoneScreen } from '../src/ui/StandardPhoneScreen';
import type { ActiveCall } from '../src/sip/JsSipService';
import type { AudioDeviceState } from '../src/calls/incall';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));


function contrastRatio(foreground: string, background: string): number {
  const linear = (value: string) => {
    const channel = parseInt(value.slice(1), 16);
    const r = (channel >> 16) & 0xff;
    const g = (channel >> 8) & 0xff;
    const b = channel & 0xff;
    const convert = (component: number) => {
      const srgb = component / 255;
      return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b);
  };
  const bright = Math.max(linear(foreground), linear(background));
  const dark = Math.min(linear(foreground), linear(background));
  return (bright + 0.05) / (dark + 0.05);
}

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
  return renderer.root.findAllByType(Text).flatMap(node => {
    const children = Array.isArray(node.props.children)
      ? node.props.children.flat(Infinity)
      : [node.props.children];
    return children.filter((value: unknown): value is string => typeof value === 'string');
  });
}

test('incoming ringing screen shows Unknown as the name and the number separately', async () => {
  const text = await textFrom(<RingingScreen callerId="204" callerName="Unknown" onAnswer={noop} onDecline={noop} />);
  expect(text).toContain('204');
  expect(text).toContain('Incoming Call');
  expect(text).toContain('Unknown');
});


test('answer press immediately disables the control and shows a connecting spinner', async () => {
  const onAnswer = jest.fn();
  await act(async () => {
    renderer = TestRenderer.create(
      <RingingScreen callerId="204" callerName="Unknown" onAnswer={onAnswer} onDecline={noop} />,
    );
  });
  const answer = renderer.root.findByProps({ accessibilityLabel: 'Answer incoming call' });
  await act(async () => { answer.props.onPress(); });
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByType(ActivityIndicator).length).toBeGreaterThan(0);
  expect(renderer.root.findAllByType(Text).some(node => node.props.children === 'Connecting…')).toBe(true);
  const pending = renderer.root.findByProps({ accessibilityLabel: 'Connecting call' });
  expect(pending.props.disabled).toBe(true);
  await act(async () => { pending.props.onPress?.(); });
  expect(onAnswer).toHaveBeenCalledTimes(1);
});

test('a native answer request shows the connecting state without a press', async () => {
  await act(async () => {
    renderer = TestRenderer.create(
      <RingingScreen callerId="204" callerName="Unknown" answerRequested onAnswer={noop} onDecline={noop} />,
    );
  });
  expect(renderer.root.findAllByType(ActivityIndicator).length).toBeGreaterThan(0);
  expect(renderer.root.findByProps({ accessibilityLabel: 'Connecting call' }).props.disabled).toBe(true);
});

test('active call modal shows unknown plus the outgoing feature code when contact lookup missed', async () => {
  const text = await textFrom(<ActiveCallModal call={call} isMuted={false} isHeld={false} isSpeaker={false}
    onToggleMute={noop} onToggleHold={noop} onToggleSpeaker={noop} onSendDtmf={noop} onTransfer={noop} onHangup={noop} />);
  expect(text).toContain('*43');
  expect(text).toContain('Unknown');
}, 15000);

test('legacy recents render Unknown plus the saved number', async () => {
  const text = await textFrom(<RecentsTab calls={[record]} onCallNumber={noop} onClearHistory={noop} />);
  expect(text).toContain(record.number);
  expect(text).toContain('Unknown');
});

test('main phone outgoing screen shows Unknown plus the target number', async () => {
  const text = await textFrom(<StandardPhoneScreen {...standardProps} activeCall={call} />);
  expect(text).toContain('*43');
  expect(text).toContain('Unknown');
});

test('main phone history displays Unknown plus numbers for old placeholder names', async () => {
  const text = await textFrom(<StandardPhoneScreen {...standardProps} />);
  const joined = text.join(' | ');
  expect(joined).toContain(record.number);
  expect(joined).toContain('Unknown');
});

test('main phone history labels incoming, outgoing and missed calls with duration', async () => {
  const records = [
    { ...record, id: 'in', direction: 'inbound' as const, timestamp: 3000, duration: 65 },
    { ...record, id: 'out', direction: 'outbound' as const, timestamp: 2000, duration: 5 },
    { ...record, id: 'missed', direction: 'missed' as const, timestamp: 1000 },
  ];
  const text = await textFrom(<StandardPhoneScreen {...standardProps} callsHistory={records} />);
  const joined = text.join(' | ');
  expect(joined).toContain('Incoming · 01:05');
  expect(joined).toContain('Outgoing · 00:05');
  expect(joined).toContain('Missed call');
});

test('ringing screen keeps resolved contact names alongside the number', async () => {
  const text = await textFrom(<RingingScreen callerId="204" callerName="Colleague" onAnswer={noop} onDecline={noop} />);
  expect(text).toContain('Colleague');
  expect(text).toContain('204');
});

test.each([
  ['light', 'light'],
  ['dark', 'dark'],
])('muted call control has readable icon contrast in %s mode', async (_label, scheme) => {
  const RN = require('react-native');
  const { StyleSheet } = RN;
  const { lightColors, darkColors } = require('../src/theme');
  const palette = scheme === 'light' ? lightColors : darkColors;
  const schemeSpy = jest.spyOn(RN, 'useColorScheme').mockReturnValue(scheme);
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <StandardPhoneScreen {...standardProps} activeCall={{ ...call, status: 'active', isMuted: true }} />,
      );
    });
    const button = renderer.root.findByProps({ accessibilityLabel: 'Unmute microphone' });
    const background = StyleSheet.flatten(button.props.style)?.backgroundColor;
    const micOffLine = renderer.root.findAllByType(View).find((node) =>
      node.props.testID === 'Line' && node.props.x1 === '2' && node.props.y1 === '2');
    const foreground = String(micOffLine?.props.stroke);
    expect(background).toBe(palette.dangerFill);
    expect(foreground.toLowerCase()).toBe(palette.onBrand.toLowerCase());
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  } finally {
    schemeSpy.mockRestore();
  }
});

test.each([
  ['light', 'light'],
  ['dark', 'dark'],
])('selected audio-route picker stays readable in %s mode', async (_label, scheme) => {
  const RN = require('react-native');
  const { StyleSheet } = RN;
  const { lightColors, darkColors } = require('../src/theme');
  const palette = scheme === 'light' ? lightColors : darkColors;
  const schemeSpy = jest.spyOn(RN, 'useColorScheme').mockReturnValue(scheme);
  const audioState: AudioDeviceState = {
    availableDevices: ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'],
    selectedDevice: 'BLUETOOTH' as const,
    hasBluetooth: true,
    bluetoothName: 'Test headset',
  };
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <StandardPhoneScreen
          {...standardProps}
          activeCall={{ ...call, status: 'active' }}
          audioDeviceState={audioState}
          onChooseAudioRoute={async () => audioState}
        />,
      );
    });
    const trigger = renderer.root.findByProps({ accessibilityLabel: 'Audio output device' });
    await act(async () => { trigger.props.onPress(); });
    const wrappers = renderer.root.findAllByType(View).filter((node) => {
      const style = StyleSheet.flatten(node.props.style) || {};
      return style.width === 40 && style.height === 40 && style.borderRadius === 20;
    });
    const selectedWrapper = wrappers.find((node) => StyleSheet.flatten(node.props.style)?.backgroundColor === palette.brandFill);
    expect(selectedWrapper).toBeTruthy();
    const selectedBackground = StyleSheet.flatten(selectedWrapper?.props.style)?.backgroundColor;
    expect(contrastRatio(palette.onBrand, selectedBackground)).toBeGreaterThanOrEqual(4.5);
  } finally {
    schemeSpy.mockRestore();
  }
});
