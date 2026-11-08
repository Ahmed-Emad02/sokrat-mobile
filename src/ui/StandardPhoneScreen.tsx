import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, createContext, useContext } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Easing,
  FlatList,
  I18nManager,
  LayoutAnimation,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  PanResponder,
  Pressable,
} from 'react-native';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, themedStyles } from '../theme';
import { useI18n, setLanguage, Language, t } from '../i18n';
import { getPushGateway } from '../config';

const ScreenStylesContext = createContext<Record<string, any> | null>(null);
const useScreenStyles = (): Record<string, any> => {
  const styles = useContext(ScreenStylesContext);
  if (!styles) throw new Error('ScreenStylesContext missing');
  return styles;
};

// Text that sits on a filled brand/danger/success control must stay white in
// both themes, even though the same literal is used for body text elsewhere.
const SCREEN_OVERRIDES = {
  callPillText: { color: 'onBrand' as const },
  transferManualText: { color: 'onBrand' as const },
  transferActionText: { color: 'onBrand' as const },
  transferModeBtnTextActive: { color: 'onBrand' as const },
  dialogSubmitText: { color: 'onBrand' as const },
  settingsSaveText: { color: 'onBrand' as const },
  consultActionBtnText: { color: 'onBrand' as const },
  consultBadgeText: { color: 'onBrand' as const },
  volumeDoneBtnText: { color: 'onBrand' as const },
  volThumb: { borderColor: 'onBrand' as const },
  inCallAudioRouteTextActive: { color: 'onBrand' as const },
  inCallBtnMutedActive: { backgroundColor: 'dangerFill' as const },
  contactCallBtn: { backgroundColor: 'brandSoft' as const },
  settingsSaveBtn: { backgroundColor: 'brandFill' as const },
};
import { CallRecord, Contact, SavedAccount, SpeedDialMap, StorageService, CodecPreference, DEFAULT_WHATSAPP_PREFS, WhatsAppPrefs } from '../storage/store';
import { SipState, ActiveCall, AttendedTransferState } from '../sip/JsSipService';
import { sanitizeCountryCode } from '../utils/whatsapp';
import { CallerProfileModal } from './CallerProfileModal';
import {
  CloseIcon,
  PhoneDeclineIcon,
  PhoneIcon,
  ContactsIcon,
  StarIcon,
  BookmarkIcon,
  BluetoothIcon,
  HeadphoneIcon,
  EarpieceIcon,
  SettingsIcon,
  MenuDotsIcon,
  KeypadIcon,
  BackspaceIcon,
  TrashIcon,
  PlusIcon,
  LogoutIcon,
  MicIcon,
  MicOffIcon,
  SpeakerIcon,
  PauseIcon,
  PlayIcon,
  TransferIcon,
  InfoIcon,
  VoicemailIcon,
  UserIcon,
  RedialIcon,
  UserPlusIcon,
  ChevronDownIcon,
  SlidersIcon,
} from './Icons';
import { AudioDeviceState, AudioRouteType } from '../calls/incall';
import { canUseFullScreenIntent, fetchDeviceContacts, getNativeSpeakerVolume, openFullScreenIntentSettings, SpeakerVolumeState } from '../calls/nativeCallNotification';
import {
  MIC_MAX_PERCENT,
  micPercentToDb,
  speakerGainToDb,
  speakerPercentToGain,
  SPEAKER_MAX_PERCENT,
} from '../calls/audioLevels';
import { searchContacts } from '../utils/dialSearch';
import { nameCallRecords } from '../utils/callLog';
import { callDisplayName } from '../calls/callerName';
import { orderContactsForList } from '../contacts/order';
import { editDialInput, type DialSelection } from '../utils/dialInput';
import type { ChatClient } from '../chat/client';
import type { ChatCache } from '../chat/cache';
import type { ChatConversation, UnreadSummary } from '../chat/types';
import type { ChatSocket } from '../chat/socket';
import { ChatTab } from '../chat/ChatTab';
import { ChatThreadScreen } from '../chat/ChatThreadScreen';
import { ChatIcon } from './Icons';

function VolumeSlider({
  label,
  value,
  onChange,
  icon,
  description,
  max = 100,
  presets = [25, 50, 75, 100],
}: {
  label: string;
  value: number;
  onChange: (val: number) => void;
  icon: React.ReactNode;
  description: string;
  max?: number;
  presets?: number[];
}) {
  const styles = useScreenStyles();
  const [trackWidth, setTrackWidth] = useState(250);
  const trackWidthRef = useRef(trackWidth);
  const valueRef = useRef(value);
  const gestureStartValueRef = useRef(value);
  trackWidthRef.current = trackWidth;
  valueRef.current = value;

  const valueFromLocalX = useCallback((localX: number): number => {
    const width = trackWidthRef.current > 0 ? trackWidthRef.current : 200;
    return Math.round(Math.max(0, Math.min(max, (localX / width) * max)));
  }, [max]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event) => {
          const localX = event.nativeEvent.locationX;
          const next = typeof localX === 'number'
            ? valueFromLocalX(localX)
            : valueRef.current;
          gestureStartValueRef.current = next;
          if (next !== valueRef.current) onChange(next);
        },
        onPanResponderMove: (_event, gestureState) => {
          const width = trackWidthRef.current > 0 ? trackWidthRef.current : 200;
          const next = Math.round(
            Math.max(0, Math.min(max, gestureStartValueRef.current + (gestureState.dx / width) * max)),
          );
          if (next !== valueRef.current) onChange(next);
        },
      }),
    [max, onChange, valueFromLocalX]
  );

  return (
    <View style={styles.volSliderContainer}>
      <View style={styles.volSliderHeader}>
        <View style={styles.volSliderTitleRow}>
          {icon}
          <Text style={styles.volSliderLabel}>{label}</Text>
        </View>
        <View style={styles.volSliderValueBadge}>
          <Text style={styles.volSliderValueText}>{value}%</Text>
        </View>
      </View>

      <Text style={styles.volSliderSub}>{description}</Text>

      {/* Interactive Slider Track with +/- Steppers */}
      <View style={styles.volSliderControlsRow}>
        <TouchableOpacity
          style={styles.volStepBtn}
          onPress={() => onChange(Math.max(0, value - 5))}
          activeOpacity={0.6}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.volStepBtnText}>−</Text>
        </TouchableOpacity>

        <View
          style={styles.volTrackTouchArea}
          onLayout={(e) => {
            const w = e.nativeEvent.layout.width;
            if (w > 0) setTrackWidth(w);
          }}
          {...panResponder.panHandlers}
        >
          <View style={styles.volTrackBg} pointerEvents="none">
            <View style={[styles.volTrackFill, { width: `${(value / max) * 100}%` }]} pointerEvents="none" />
          </View>
          <View
            style={[
              styles.volThumb,
              { left: `${Math.max(0, Math.min(94, (value / max) * 100 - 3))}%` },
            ]}
            pointerEvents="none"
          />
        </View>
        <TouchableOpacity
          style={styles.volStepBtn}
          onPress={() => onChange(Math.min(max, value + 5))}
          activeOpacity={0.6}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.volStepBtnText}>+</Text>
        </TouchableOpacity>
      </View>

      {/* Preset Pills */}
      <View style={styles.volPresetRow}>
        {presets.map((p) => {
          const isSelected = value === p;
          return (
            <TouchableOpacity
              key={p}
              style={[styles.volPresetPill, isSelected && styles.volPresetPillActive]}
              onPress={() => onChange(p)}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.volPresetText,
                  isSelected && styles.volPresetTextActive,
                ]}
              >
                {p}%
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function UnifiedAudioControls({
  speakerVolume,
  micVolume,
  speakerStep,
  isSpeakerOn,
  onChangeSpeaker,
  onChangeMic,
  onToggleSpeaker,
  audioDeviceState,
  onChooseAudioRoute,
  showRouteControls = true,
}: {
  speakerVolume: number;
  micVolume: number;
  speakerStep: { current: number; max: number };
  isSpeakerOn?: boolean;
  onChangeSpeaker: (val: number) => void;
  onChangeMic: (val: number) => void;
  onToggleSpeaker?: () => void;
  audioDeviceState?: AudioDeviceState;
  onChooseAudioRoute?: (route: AudioRouteType) => Promise<AudioDeviceState>;
  showRouteControls?: boolean;
}) {
  const styles = useScreenStyles();
  const { colors } = useTheme();
  const { t } = useI18n();
  const micDb = micPercentToDb(micVolume);
  const micDbLabel = micDb === 0 ? '0 dB • Calibrated' : `${micDb > 0 ? '+' : ''}${micDb} dB`;
  const micDescription =
    `Microphone capture gain (${micDbLabel}). Applied directly to live calls.` +
    (micDb > 12 ? ' High boost may clip loud speech.' : '');
  const speakerGain = speakerPercentToGain(speakerVolume);
  const speakerBoostDb = speakerGainToDb(speakerGain);
  const speakerBoostLabel =
    speakerGain > 1 ? `+${speakerBoostDb.toFixed(1)} dB software boost` : 'no software boost';
  const speakerDescription =
    speakerVolume > 100
      ? `Device at max (${speakerStep.current}/${speakerStep.max} steps), plus ${speakerBoostLabel}.`
      : `Device volume ${speakerStep.current}/${speakerStep.max} steps. 100% reaches device max; above 100% adds software boost.`;

  return (
    <View style={styles.unifiedAudioContainer}>
      <VolumeSlider
        label={t('Speaker Output Volume')}
        value={speakerVolume}
        onChange={onChangeSpeaker}
        icon={<SpeakerIcon size={18} color={colors.brand} />}
        description={speakerDescription}
        max={SPEAKER_MAX_PERCENT}
        presets={[50, 100, 125, 150, 195]}
      />

      <VolumeSlider
        label={t('Microphone Sensitivity')}
        value={micVolume}
        onChange={onChangeMic}
        icon={<MicIcon size={18} color={colors.brand} />}
        description={micDescription}
        max={MIC_MAX_PERCENT}
        presets={[0, 25, 50, 100, 150]}
      />

      {showRouteControls !== false && (
      <View style={styles.inCallAudioRouteRow}>
        {audioDeviceState?.hasBluetooth && (
          <TouchableOpacity
            style={[
              styles.inCallAudioRouteBtn,
              audioDeviceState.selectedDevice === 'BLUETOOTH' && styles.inCallAudioRouteBtnActive,
            ]}
            onPress={() => onChooseAudioRoute?.('BLUETOOTH')}
          >
            <BluetoothIcon size={14} color={audioDeviceState.selectedDevice === 'BLUETOOTH' ? colors.onBrand : colors.textMuted} />
            <Text style={[styles.inCallAudioRouteText, audioDeviceState.selectedDevice === 'BLUETOOTH' && styles.inCallAudioRouteTextActive]}>
              {audioDeviceState?.bluetoothName || t('Bluetooth')}
            </Text>
          </TouchableOpacity>
        )}
        {audioDeviceState?.availableDevices?.includes('WIRED_HEADSET') && (
          <TouchableOpacity
            style={[
              styles.inCallAudioRouteBtn,
              audioDeviceState.selectedDevice === 'WIRED_HEADSET' && styles.inCallAudioRouteBtnActive,
            ]}
            onPress={() => onChooseAudioRoute?.('WIRED_HEADSET')}
          >
            <HeadphoneIcon size={14} color={audioDeviceState.selectedDevice === 'WIRED_HEADSET' ? colors.onBrand : colors.textMuted} />
            <Text style={[styles.inCallAudioRouteText, audioDeviceState.selectedDevice === 'WIRED_HEADSET' && styles.inCallAudioRouteTextActive]}>
              Headset
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[
            styles.inCallAudioRouteBtn,
            (audioDeviceState ? audioDeviceState.selectedDevice === 'EARPIECE' : !isSpeakerOn) && styles.inCallAudioRouteBtnActive,
          ]}
          onPress={() => {
            if (onChooseAudioRoute) {
              void onChooseAudioRoute('EARPIECE');
            } else if (isSpeakerOn && onToggleSpeaker) {
              onToggleSpeaker();
            }
          }}
        >
          <EarpieceIcon size={14} color={(audioDeviceState ? audioDeviceState.selectedDevice === 'EARPIECE' : !isSpeakerOn) ? colors.onBrand : colors.textMuted} />
          <Text style={[styles.inCallAudioRouteText, (audioDeviceState ? audioDeviceState.selectedDevice === 'EARPIECE' : !isSpeakerOn) && styles.inCallAudioRouteTextActive]}>
            {t('Handset')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.inCallAudioRouteBtn,
            (audioDeviceState ? audioDeviceState.selectedDevice === 'SPEAKER_PHONE' : isSpeakerOn) && styles.inCallAudioRouteBtnActive,
          ]}
          onPress={() => {
            if (onChooseAudioRoute) {
              void onChooseAudioRoute('SPEAKER_PHONE');
            } else if (!isSpeakerOn && onToggleSpeaker) {
              onToggleSpeaker();
            }
          }}
        >
          <SpeakerIcon size={14} color={(audioDeviceState ? audioDeviceState.selectedDevice === 'SPEAKER_PHONE' : isSpeakerOn) ? colors.onBrand : colors.textMuted} />
          <Text style={[styles.inCallAudioRouteText, (audioDeviceState ? audioDeviceState.selectedDevice === 'SPEAKER_PHONE' : isSpeakerOn) && styles.inCallAudioRouteTextActive]}>
            {t('Speaker')}
          </Text>
        </TouchableOpacity>
      </View>
      )}
    </View>
  );
}

function formatCallDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

const InCallTimerDisplay = React.memo(function InCallTimerDisplay({
  startTime,
  status,
}: {
  startTime?: number;
  status?: string;
}) {
  const styles = useScreenStyles();
  const isConnected = status === 'active' || status === 'held';
  const isRinging = status === 'ringing';
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status !== 'active' && status !== 'held') {
      setElapsed(0);
      return;
    }
    const tick = () => {
      const start = startTime || Date.now();
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status, startTime]);

  const label = isConnected
    ? formatCallDuration(elapsed)
    : isRinging
    ? 'Ringing…'
    : 'Dialing…';

  return (
    <Text style={[styles.inCallTimer, !isConnected && styles.inCallTimerPreConnect]}>
      {label}
    </Text>
  );
});

type Props = {
  account: SavedAccount | null;
  state: SipState;
  callsHistory: CallRecord[];
  contacts: Contact[];
  activeCall: ActiveCall | null;
  isSpeakerOn?: boolean;
  onCall: (number: string) => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onToggleHold: () => void;
  onToggleSpeaker: () => void;
  onSendDtmf: (digit: string) => void;
  onBlindTransfer: (target: string) => void;
  attendedTransferState: AttendedTransferState | null;
  onStartWarmTransfer: (target: string) => Promise<void>;
  onCompleteTransfer: () => Promise<void>;
  onCancelTransfer: () => Promise<void>;
  onSwapLines: () => Promise<void>;
  onSaveAccount: (account: SavedAccount) => void;
  onRepairPush?: () => Promise<boolean>;
  onLogout: () => void;
  onClearHistory: () => void;
  onSaveContact: (contact: Contact) => void;
  onSaveContactsBatch?: (contacts: Contact[]) => void;
  onDeleteContact: (id: string) => void;
  onDeleteCallRecord?: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onUpdateVolume?: (type: 'mic' | 'speaker', value: number) => void;
  audioDeviceState?: AudioDeviceState;
  onChooseAudioRoute?: (route: AudioRouteType) => Promise<AudioDeviceState>;
  // Chat
  chatClient?: ChatClient | null;
  chatCache?: ChatCache | null;
  chatConversations?: ChatConversation[];
  chatUnread?: UnreadSummary;
  chatSocket?: ChatSocket | null;
  onChatRefresh?: () => Promise<void>;
  onChatRead?: (conversationId?: string) => void;
};

type BottomTab = 'phone' | 'contacts' | 'chat';

const DIALPAD_KEYS = [
  { digit: '1', sub: 'VM', isVm: true },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '(P)' },
  { digit: '0', sub: '+' },
  { digit: '#', sub: '(W)' },
];

function formatTimeAgo(ts: number): string {
  const elapsed = Math.floor((Date.now() - ts) / 1000);
  if (elapsed < 60) return t('Just now');
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)} ${t('min ago')}`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)} ${t('hr ago')}`;
  return t('Yesterday');
}

const RecentCallRow = React.memo(function RecentCallRow({
  item,
  onCall,
  onOpenDetails,
}: {
  item: CallRecord;
  onCall: (number: string) => void;
  onOpenDetails: (record: CallRecord) => void;
}) {
  const styles = useScreenStyles();
  const { colors } = useTheme();
  const { t } = useI18n();
  const directionLabel =
    item.direction === 'inbound'
      ? t('Incoming')
      : item.direction === 'outbound'
      ? t('Outgoing')
      : t('Missed call');
  const duration = item.duration ? formatCallDuration(item.duration) : '';
  const displayName = callDisplayName(item.number, item.name);
  const number = String(item.number || '').trim();
  const metaLine = [number, directionLabel, duration].filter(Boolean).join(' · ');
  return (
    <View style={styles.recentItem}>
      <TouchableOpacity
        style={styles.recentMainCol}
        onPress={() => onCall(item.number)}
        activeOpacity={0.7}
        delayPressIn={0}
      >
        <View style={styles.avatarMini}>
          <UserIcon size={20} color={colors.textMuted} />
        </View>

        <View style={styles.recentInfo}>
          <Text
            style={[
              styles.recentName,
              item.direction === 'missed' && styles.recentNameMissed,
            ]}
            numberOfLines={1}
          >
            {displayName}
          </Text>
          <Text
            style={[
              styles.recentSub,
              item.direction === 'missed' && styles.recentSubMissed,
            ]}
            numberOfLines={1}
          >
            {metaLine}
          </Text>
        </View>

        <Text style={styles.recentTime}>{formatTimeAgo(item.timestamp)}</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.infoCircleBtn}
        onPress={() => onOpenDetails(item)}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        activeOpacity={0.6}
        delayPressIn={0}
        accessibilityRole="button"
        accessibilityLabel={`View profile for ${displayName}${number && number !== displayName ? ` ${number}` : ''}`}
      >
        <InfoIcon size={20} color={colors.brand} />
      </TouchableOpacity>
    </View>
  );
});

const ContactRow = React.memo(function ContactRow({
  item,
  onToggleFavorite,
  onCall,
  onOpenProfile,
}: {
  item: Contact;
  onToggleFavorite: (id: string) => void;
  onCall: (extension: string) => void;
  onOpenProfile: (contact: Contact) => void;
}) {
  const styles = useScreenStyles();
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <View style={styles.contactRow}>
      <TouchableOpacity style={styles.favStarBtn} onPress={() => onToggleFavorite(item.id)} delayPressIn={0}>
        <BookmarkIcon size={22} color={item.favorite ? colors.brand : colors.textFaint} fill={item.favorite ? colors.brand : 'none'} />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.contactDetailCol}
        onPress={() => onOpenProfile(item)}
        delayPressIn={0}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${item.extension}`}
      >
        <Text style={styles.contactRowName}>{item.name}</Text>
        <Text style={styles.contactRowExt}>{item.extension}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.contactCallBtn} onPress={() => onCall(item.extension)} delayPressIn={0}>
        <PhoneIcon size={16} color={colors.brand} />
      </TouchableOpacity>
    </View>
  );
});

const AnimatedDialpadKey = React.memo(function AnimatedDialpadKey({
  k,
  isConfigured,
  speedTarget,
  onPress,
  onLongPress,
}: {
  k: { digit: string; sub?: string };
  isConfigured: boolean;
  speedTarget?: string;
  onPress: (digit: string) => void;
  onLongPress: (digit: string) => void;
}) {
  const styles = useScreenStyles();
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scale, {
      toValue: 0.88,
      speed: 80,
      bounciness: 2,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scale, {
      toValue: 1.0,
      speed: 55,
      bounciness: 4,
      useNativeDriver: true,
    }).start();
  };

  return (
    <View style={styles.keyCol}>
      <Animated.View style={[styles.keyAnimatedWrap, { transform: [{ scale }] }]}>
        <TouchableOpacity
          style={styles.keyBtn}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          onPress={() => onPress(k.digit)}
          onLongPress={() => onLongPress(k.digit)}
          delayPressIn={0}
          delayLongPress={400}
          activeOpacity={0.65}
          accessibilityRole="button"
          accessibilityLabel={
            isConfigured
              ? `Digit ${k.digit}, hold to speed dial ${speedTarget}`
              : `Digit ${k.digit}`
          }
        >
          <Text style={styles.keyNumber}>{k.digit}</Text>
          <View style={styles.keySubRow}>
            {k.digit === '1' ? (
              <VoicemailIcon
                size={14}
                color={isConfigured ? colors.brand : colors.textMuted}
              />
            ) : k.sub ? (
              <Text
                style={[
                  styles.keyLetters,
                  isConfigured && styles.keyLettersActive,
                ]}
              >
                {k.sub}
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
});

function StandardPhoneScreenInner({
  account,
  state,
  callsHistory,
  contacts,
  activeCall,
  isSpeakerOn = false,
  onCall,
  onHangup,
  onToggleMute,
  onToggleHold,
  onToggleSpeaker,
  audioDeviceState,
  onChooseAudioRoute,
  onSendDtmf,
  onBlindTransfer,
  attendedTransferState,
  onStartWarmTransfer,
  onCompleteTransfer,
  onCancelTransfer,
  onSwapLines,
  onSaveAccount,
  onSaveContactsBatch,
  onRepairPush,
  onLogout,
  onClearHistory,
  onSaveContact,
  onDeleteContact,
  onDeleteCallRecord,
  onToggleFavorite,
  onUpdateVolume,
  chatClient,
  chatCache,
  chatConversations = [],
  chatUnread = { total: 0, per_conversation: {} },
  chatSocket = null,
  onChatRefresh,
  onChatRead,
}: Props) {
  const styles = useScreenStyles();
  const { colors } = useTheme();
  const { t, lang } = useI18n();
  const changeLanguage = async (next: Language) => {
    if (next === lang) return;
    await setLanguage(next);
    Alert.alert(
      t('Language'),
      t('Restart the app to apply the new layout direction.'),
    );
  };
  // Navigation & UI States
  const [activeTab, setActiveTab] = useState<BottomTab>('phone');
  const [openThread, setOpenThread] = useState<ChatConversation | null>(null);
  const [digits, setDigits] = useState('');
  const [dialSelection, setDialSelection] = useState<DialSelection>({ start: 0, end: 0 });
  const setCursorIndex = (index: number) => setDialSelection({ start: index, end: index });
  const [showMenu, setShowMenu] = useState(false);
  const menuAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (showMenu) {
      menuAnim.setValue(0);
      Animated.timing(menuAnim, {
        toValue: 1,
        duration: 160,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [showMenu, menuAnim]);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [fullScreenCallsAllowed, setFullScreenCallsAllowed] = useState(true);
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [contactSearch, setContactSearch] = useState('');

  const [profileNumber, setProfileNumber] = useState<string | null>(null);
  const [whatsappPrefs, setWhatsappPrefs] = useState<WhatsAppPrefs>({ ...DEFAULT_WHATSAPP_PREFS });
  const [editWhatsAppCountryCode, setEditWhatsAppCountryCode] = useState('');
  const [editWhatsAppPrompt, setEditWhatsAppPrompt] = useState(true);

  // Settings State Form
  const [editExt, setEditExt] = useState(account?.extension || '');
  const [editPass, setEditPass] = useState(account?.password || '');
  const [editHost, setEditHost] = useState(account?.serverHost || '');
  const [editFallbackHost, setEditFallbackHost] = useState(account?.fallbackHost || '');
  const [editTls, setEditTls] = useState(account?.useTls ?? false);
  const [editDnd, setEditDnd] = useState(account?.dnd || false);
  const [editAuto, setEditAuto] = useState(account?.autoAnswer || false);
  const [editCodec, setEditCodec] = useState<CodecPreference>(account?.preferredCodec || 'pcmu');
  const [editMicVol, setEditMicVol] = useState(account?.micVolume ?? 50);
  const [editSpeakerVol, setEditSpeakerVol] = useState(account?.speakerVolume ?? 85);
  const [showInCallVolumeModal, setShowInCallVolumeModal] = useState(false);
  const [inCallSpeakerStep, setInCallSpeakerStep] = useState<{ current: number; max: number }>({ current: 12, max: 15 });
  // Coalesce native volume writes while the speaker slider is dragged.
  const speakerNativeTimerRef = useRef<number | null>(null);
  const speakerPendingRef = useRef<number | null>(null);
  const speakerSendSeqRef = useRef(0);

  useEffect(() => () => {
    if (speakerNativeTimerRef.current != null) {
      clearTimeout(speakerNativeTimerRef.current);
      speakerNativeTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (activeCall || showInCallVolumeModal || showSettingsModal) {
      void getNativeSpeakerVolume().then((res) => {
        if (res) {
          setInCallSpeakerStep({ current: res.currentStep, max: res.maxStep });
        }
      });
    }
  }, [activeCall, showInCallVolumeModal, showSettingsModal]);
  // Speed Dial Configuration (Keys 1 to 9)
  const [speedDial, setSpeedDial] = useState<SpeedDialMap>({ '1': '*97' });
  const [editSpeedDial, setEditSpeedDial] = useState<SpeedDialMap>({ '1': '*97' });

  // Dialpad Collapse / Expand Toggle
  const [isDialpadVisible, setIsDialpadVisible] = useState(true);
  const dialpadAnim = useRef(new Animated.Value(1)).current;
  const [dialpadKeysHeight, setDialpadKeysHeight] = useState(420);

  const toggleDialpad = () => {
    if (isDialpadVisible) {
      Animated.timing(dialpadAnim, {
        toValue: 0,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => setIsDialpadVisible(false));
    } else {
      setIsDialpadVisible(true);
      Animated.timing(dialpadAnim, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  };
  // Recents History Filter (All vs Missed)
  const [historyFilter, setHistoryFilter] = useState<'all' | 'missed'>('all');
  const [showAudioRouteModal, setShowAudioRouteModal] = useState(false);
  const tabPagerRef = useRef<any>(null);
  const tabIndicatorAnim = useRef(new Animated.Value(0)).current;
  const pageOpacity = useRef(new Animated.Value(1)).current;
  const pageTranslateX = useRef(new Animated.Value(0)).current;
  const tabSwitchingRef = useRef(false);
  const pendingTabEntranceRef = useRef<number | null>(null);

  const handleTabPress = useCallback((tab: BottomTab) => {
    if (tab === activeTab || tabSwitchingRef.current) return;
    const order: BottomTab[] = ['phone', 'contacts', 'chat'];
    const fromIndex = order.indexOf(activeTab);
    const toIndex = order.indexOf(tab);
    const forward = toIndex > fromIndex;
    const enterFrom = forward
      ? (I18nManager.isRTL ? -1 : 1)
      : (I18nManager.isRTL ? 1 : -1);

    tabSwitchingRef.current = true;
    Animated.spring(tabIndicatorAnim, {
      toValue: toIndex,
      speed: 25,
      bounciness: 4,
      useNativeDriver: true,
    }).start();

    Animated.parallel([
      Animated.timing(pageOpacity, {
        toValue: 0,
        duration: 100,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(pageTranslateX, {
        toValue: -enterFrom * 24,
        duration: 100,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      // Mark the direction and swap the content. The entrance animation is
      // started from useLayoutEffect below, only after the new tab has been
      // committed — otherwise the opacity ramp can reveal the old tab again
      // for a frame (the "old tab flash").
      pendingTabEntranceRef.current = enterFrom;
      setActiveTab(tab);
    });
  }, [activeTab, pageOpacity, pageTranslateX, tabIndicatorAnim]);

  useLayoutEffect(() => {
    const enterFrom = pendingTabEntranceRef.current;
    if (enterFrom === null) return;
    pendingTabEntranceRef.current = null;
    pageTranslateX.setValue(enterFrom * 36);
    // Wait one frame after the new tab commits before raising the opacity, so
    // even a delayed native mount can never reveal the previous tab content.
    const frame = requestAnimationFrame(() => {
      Animated.parallel([
        Animated.timing(pageOpacity, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(pageTranslateX, {
          toValue: 0,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => {
        tabSwitchingRef.current = false;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, pageOpacity, pageTranslateX]);

  const tabSwipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gesture) =>
          Math.abs(gesture.dx) > 30 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onMoveShouldSetPanResponderCapture: (_evt, gesture) =>
          Math.abs(gesture.dx) > 30 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderRelease: (_evt, gesture) => {
          if (Math.abs(gesture.dx) < 70) return;
          const order: BottomTab[] = ['phone', 'contacts', 'chat'];
          const index = order.indexOf(activeTab);
          const forward = I18nManager.isRTL ? gesture.dx > 0 : gesture.dx < 0;
          const nextIndex = Math.min(2, Math.max(0, index + (forward ? 1 : -1)));
          if (nextIndex !== index) handleTabPress(order[nextIndex]);
        },
      }),
    [activeTab, handleTabPress],
  );

  const handleScrollEnd = (e: { nativeEvent: { contentOffset: { x: number } } }) => {
    const offsetX = e.nativeEvent.contentOffset.x;
    const idx = Math.round(offsetX / SCREEN_WIDTH);
    const tabOrder: BottomTab[] = ['phone', 'contacts', 'chat'];
    if (tabOrder[idx] && tabOrder[idx] !== activeTab) {
      setActiveTab(tabOrder[idx]);
      Animated.spring(tabIndicatorAnim, {
        toValue: idx,
        speed: 25,
        bounciness: 4,
        useNativeDriver: true,
      }).start();
    }
  };
  const handleSpeakerChange = (val: number) => {
    setEditSpeakerVol(val);
    speakerPendingRef.current = val;
    if (speakerNativeTimerRef.current != null) return;

    // Apply at most one native stream-volume write every 50 ms. The thumb and
    // badge still follow every drag event, so the UI stays responsive.
    speakerNativeTimerRef.current = setTimeout(() => {
      speakerNativeTimerRef.current = null;
      const pending = speakerPendingRef.current;
      speakerPendingRef.current = null;
      if (pending == null) return;
      const seq = ++speakerSendSeqRef.current;
      const p = onUpdateVolume?.('speaker', pending);
      if (p && typeof p === 'object' && 'then' in p) {
        void (p as Promise<SpeakerVolumeState | null>).then((res) => {
          // Ignore a response that belongs to an older drag position.
          if (!res || seq !== speakerSendSeqRef.current) return;
          setInCallSpeakerStep({ current: res.currentStep, max: res.maxStep });
          setEditSpeakerVol(pending > 100 ? pending : res.percent);
        });
      }
    }, 50) as unknown as number;
  };

  const handleMicChange = (val: number) => {
    setEditMicVol(val);
    void onUpdateVolume?.('mic', val);
  };

  const displayedCalls = useMemo(() => {
    const namedCalls = nameCallRecords(callsHistory, contacts);
    if (historyFilter === 'missed') {
      return namedCalls.filter((item) => item.direction === 'missed');
    }
    return namedCalls;
  }, [callsHistory, contacts, historyFilter]);

  const filteredContacts = useMemo(() => {
    const ordered = orderContactsForList(contacts);
    const q = contactSearch.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((c) =>
      c.name.toLowerCase().includes(q) || c.extension.includes(q)
    );
  }, [contacts, contactSearch]);

  const favoriteContacts = useMemo(() => {
    return contacts.filter((c) => c.favorite);
  }, [contacts]);

  // Live PBX Extensions (for 1-click transfer)
  const [serverExtensions, setServerExtensions] = useState<Array<{ extension: string; name: string }>>([]);

  // New Contact Form
  const [newContactName, setNewContactName] = useState('');
  const [newContactNumber, setNewContactNumber] = useState('');

  // In-Call DTMF & Transfer Overlay
  const [showInCallDtmf, setShowInCallDtmf] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferTarget, setTransferTarget] = useState('');
  // 'blind' = REFER-and-drop, 'warm' = attended/consultative
  const [transferMode, setTransferMode] = useState<'blind' | 'warm'>('blind');
  // Pending guards for warm transfer action buttons
  const [pendingTransferAction, setPendingTransferAction] = useState<
    'start' | 'swap' | 'complete' | 'cancel' | null
  >(null);
  useEffect(() => {
    StorageService.getSpeedDial().then((sd) => {
      const initial = { '1': '*97', ...sd };
      setSpeedDial(initial);
      setEditSpeedDial(initial);
    });
  }, []);

  const chatConversationsWithNames = useMemo(() => {
    return chatConversations.map((conversation) => {
      const extension = conversation.extension.trim();
      const contact = contacts.find((item) => item.extension.trim() === extension);
      const server = serverExtensions.find((item) => item.extension.trim() === extension);
      const resolved = contact?.name?.trim() || server?.name?.trim();
      if (!resolved || resolved === conversation.extension) return conversation;
      return { ...conversation, name: resolved };
    });
  }, [chatConversations, contacts, serverExtensions]);

  const fetchExtensions = useCallback(async () => {
    try {
      const host = account?.serverHost;
      if (!host) return;
      let res = await fetch(`${getPushGateway(host)}/api/push/extensions`).catch(() => null);
      if (!res || !res.ok) {
        res = await fetch(`http://${host}:8080/api/federation/v1/extensions`).catch(() => null);
      }
      if (res && res.ok) {
        const json = await res.json();
        if (json.success && Array.isArray(json.extensions) && json.extensions.length > 0) {
          setServerExtensions(json.extensions);
        }
      }
    } catch {}
  }, [account?.serverHost]);

  useEffect(() => {
    if (account) {
      setEditExt(account.extension);
      setEditPass(account.password);
      setEditHost(account.serverHost);
      setEditTls(account.useTls);
      setEditDnd(account.dnd);
      setEditAuto(account.autoAnswer);
      setEditCodec(account.preferredCodec || 'pcmu');
      setEditMicVol(account.micVolume ?? 50);
      setEditSpeakerVol(account.speakerVolume ?? 85);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.extension, account?.serverHost, account?.password]);

  useEffect(() => {
    let cancelled = false;
    void StorageService.getWhatsAppPrefs().then((prefs) => {
      if (cancelled) return;
      setWhatsappPrefs(prefs);
      setEditWhatsAppCountryCode(prefs.countryCode);
      setEditWhatsAppPrompt(prefs.promptEnabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void fetchExtensions();
  }, [fetchExtensions]);

  const handleKeyLongPress = useCallback((digit: string) => {
    const target = speedDial[digit]?.trim();
    if (target) {
      setDigits('');
      onCall(target);
    } else if (digit === '0') {
      setDigits((prev) => prev + '+');
    }
  }, [speedDial, onCall]);

  const filteredTransferExtensions = useMemo(() => {
    const q = transferTarget.trim().toLowerCase();
    return serverExtensions
      .filter((e) => e.extension !== account?.extension)
      .filter((e) => {
        if (!q) return true;
        return (
          e.extension.toLowerCase().includes(q) ||
          (e.name || '').toLowerCase().includes(q)
        );
      });
  }, [serverExtensions, account?.extension, transferTarget]);

  const handleOpenProfile = useCallback((record: CallRecord) => {
    setProfileNumber(record.number);
  }, []);

  const handleOpenContactProfile = useCallback((contact: Contact) => {
    setProfileNumber(contact.extension);
  }, []);

  // Stable list renderers keep visible rows from re-rendering on every
  // dialpad keystroke or transient screen state change.
  const recentCalls = displayedCalls;
  const dialSearchMatches = useMemo(() => searchContacts(contacts, digits), [contacts, digits]);
  const showDialSearch = digits.replace(/\D/g, '').length > 0;
  const recentKeyExtractor = useCallback((item: CallRecord) => item.id, []);
  const contactKeyExtractor = useCallback((item: Contact) => item.id, []);
  const renderRecentCall = useCallback(
    ({ item }: { item: CallRecord }) => (
      <RecentCallRow item={item} onCall={onCall} onOpenDetails={handleOpenProfile} />
    ),
    [onCall, handleOpenProfile],
  );
  const renderContact = useCallback(
    ({ item }: { item: Contact }) => (
      <ContactRow
        item={item}
        onToggleFavorite={onToggleFavorite}
        onCall={onCall}
        onOpenProfile={handleOpenContactProfile}
      />
    ),
    [handleOpenContactProfile, onCall, onToggleFavorite],
  );
  const [isSyncingContacts, setIsSyncingContacts] = useState(false);

  const handleSyncContacts = async () => {
    if (isSyncingContacts) return;
    setIsSyncingContacts(true);
    try {
      const deviceContacts = await fetchDeviceContacts();
      if (!deviceContacts || deviceContacts.length === 0) {
        Alert.alert(
          'No Contacts Found',
          'No contacts were found or permission was denied. Please ensure Contacts permission is enabled in device settings.',
        );
        return;
      }

      const newToSave = deviceContacts.filter(
        (dev) => !contacts.some((c) => c.extension === dev.extension)
      );

      if (onSaveContactsBatch) {
        onSaveContactsBatch(deviceContacts);
      } else {
        newToSave.forEach((c) => onSaveContact(c));
      }

      Alert.alert(
        'Contacts Synced',
        newToSave.length > 0
          ? `Successfully imported ${newToSave.length} new contact${newToSave.length > 1 ? 's' : ''} from your phone.`
          : `All ${deviceContacts.length} contacts are already synchronized in your dialer.`,
      );
    } catch (err) {
      console.warn('[contacts] sync error:', err);
      Alert.alert('Sync Error', 'Failed to import contacts from phone.');
    } finally {
      setIsSyncingContacts(false);
    }
  };

  const handleDigitPress = useCallback((d: string) => {
    const next = editDialInput(digits, dialSelection, d);
    setDigits(next.text);
    setDialSelection(next.selection);
  }, [digits, dialSelection]);

  const handleBackspace = useCallback(() => {
    const next = editDialInput(digits, dialSelection, null);
    setDigits(next.text);
    setDialSelection(next.selection);
  }, [digits, dialSelection]);

  const hasDigits = digits.trim().length > 0;
  const lastCallNumber =
    callsHistory.length > 0 ? (callsHistory[0]?.number || '').trim() : '';
  const hasRedial = lastCallNumber.length > 0;

  const handleAuxAction = () => {
    if (hasDigits) {
      setEditingContact(null);
      setNewContactName('');
      setNewContactNumber(digits.trim());
      setShowAddContactModal(true);
    } else if (hasRedial) {
      setDigits(lastCallNumber);
      setCursorIndex(lastCallNumber.length);
      onCall(lastCallNumber);
    }
  };

  const handleDial = () => {
    if (!digits.trim()) return;
    onCall(digits.trim());
    setDigits('');
    setCursorIndex(0);
  };

  const handleSaveWhatsAppCountryCode = useCallback((code: string) => {
    const clean = sanitizeCountryCode(code);
    setWhatsappPrefs((prev) => {
      const next = { ...prev, countryCode: clean };
      void StorageService.saveWhatsAppPrefs(next);
      return next;
    });
    setEditWhatsAppCountryCode(clean);
  }, []);

  useEffect(() => {
    if (!showSettingsModal) return;
    let cancelled = false;
    void canUseFullScreenIntent().then(allowed => {
      if (!cancelled) setFullScreenCallsAllowed(allowed);
    });
    return () => { cancelled = true; };
  }, [showSettingsModal]);

  const openSettings = useCallback(() => {
    setEditWhatsAppCountryCode(whatsappPrefs.countryCode);
    setEditWhatsAppPrompt(whatsappPrefs.promptEnabled);
    setShowSettingsModal(true);
  }, [whatsappPrefs.countryCode, whatsappPrefs.promptEnabled]);

  const handleSaveSettings = () => {
    if (!editExt.trim() || !editPass.trim() || !editHost.trim()) return;
    onSaveAccount({
      extension: editExt.trim(),
      password: editPass.trim(),
      serverHost: editHost.trim(),
      fallbackHost: editFallbackHost.trim() || undefined,
      useTls: editTls,
      dnd: editDnd,
      autoAnswer: editAuto,
      preferredCodec: editCodec,
      micVolume: editMicVol,
      speakerVolume: editSpeakerVol,
    });
    const newSpeedDial: SpeedDialMap = {};
    for (let d = 1; d <= 9; d++) {
      const key = String(d);
      const val = (editSpeedDial[key] || '').trim();
      if (key === '1') {
        newSpeedDial[key] = val || '*97';
      } else if (val) {
        newSpeedDial[key] = val;
      }
    }
    setSpeedDial(newSpeedDial);
    StorageService.saveSpeedDial(newSpeedDial);

    const nextWhatsAppPrefs: WhatsAppPrefs = {
      countryCode: sanitizeCountryCode(editWhatsAppCountryCode),
      promptEnabled: editWhatsAppPrompt,
    };
    setWhatsappPrefs(nextWhatsAppPrefs);
    void StorageService.saveWhatsAppPrefs(nextWhatsAppPrefs);

    setShowSettingsModal(false);
  };

  const closeContactModal = useCallback(() => {
    setShowAddContactModal(false);
    setEditingContact(null);
    setNewContactName('');
    setNewContactNumber('');
  }, []);

  const handleCreateContact = () => {
    const name = newContactName.trim();
    const extension = newContactNumber.trim();
    if (!name || !extension) return;
    if (editingContact) {
      onSaveContact({
        ...editingContact,
        name,
        extension,
      });
    } else {
      onSaveContact({
        id: 'c_' + Date.now(),
        name,
        extension,
        favorite: false,
      });
    }
    closeContactModal();
  };

  const handleSignOutClick = () => {
    setShowMenu(false);
    onLogout();
    setShowSettingsModal(false);
  };
  const renderVolumeModal = () => (
    <Modal
      visible={showInCallVolumeModal}
      transparent
      animationType="fade"
      onRequestClose={() => setShowInCallVolumeModal(false)}
    >
      <TouchableWithoutFeedback onPress={() => setShowInCallVolumeModal(false)}>
        <View style={styles.modalBackdrop}>
          <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
            <View style={styles.volumeDialogCard}>
              <View style={styles.transferHeaderRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.dialogTitle}>{t('Audio & Volume Controls')}</Text>
                  <Text style={styles.transferSubTitle}>
                    {activeCall
                      ? 'Adjust speaker loudness and microphone sensitivity mid-call:'
                      : 'Adjust default in-call speaker loudness and microphone sensitivity:'}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => setShowInCallVolumeModal(false)}
                  style={styles.transferDismissBtn}
                >
                  <CloseIcon size={18} color={colors.textDim} />
                </TouchableOpacity>
              </View>
              <UnifiedAudioControls
                speakerVolume={editSpeakerVol}
                micVolume={editMicVol}
                speakerStep={inCallSpeakerStep}
                isSpeakerOn={isSpeakerOn}
                onChangeSpeaker={handleSpeakerChange}
                onChangeMic={handleMicChange}
                onToggleSpeaker={onToggleSpeaker}
                audioDeviceState={audioDeviceState}
                onChooseAudioRoute={onChooseAudioRoute}
              />
              <TouchableOpacity
                style={styles.volumeDoneBtn}
                onPress={() => setShowInCallVolumeModal(false)}
              >
                <Text style={styles.volumeDoneBtnText}>{t('Done')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );

  const renderAudioRouteModal = () => (
    <Modal
      visible={showAudioRouteModal}
      transparent
      animationType="fade"
      onRequestClose={() => setShowAudioRouteModal(false)}
    >
      <TouchableWithoutFeedback onPress={() => setShowAudioRouteModal(false)}>
        <View style={styles.modalBackdrop}>
          <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
            <View style={styles.audioRouteCard}>
              <View style={styles.audioRouteHeader}>
                <Text style={styles.audioRouteTitle}>{t('Audio Output & Input')}</Text>
                <TouchableOpacity onPress={() => setShowAudioRouteModal(false)} style={styles.transferDismissBtn}>
                  <CloseIcon size={18} color={colors.textDim} />
                </TouchableOpacity>
              </View>
              <Text style={styles.audioRouteSub}>
                {t('Select active device for microphone and speaker:')}
              </Text>
              {audioDeviceState?.hasBluetooth && (
                <TouchableOpacity
                  style={[
                    styles.audioRouteOption,
                    audioDeviceState.selectedDevice === 'BLUETOOTH' && styles.audioRouteOptionActive,
                  ]}
                  onPress={async () => {
                    await onChooseAudioRoute?.('BLUETOOTH');
                    setShowAudioRouteModal(false);
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.audioRouteIconWrap, audioDeviceState.selectedDevice === 'BLUETOOTH' && styles.audioRouteIconWrapActive]}>
                    <BluetoothIcon size={22} color={audioDeviceState.selectedDevice === 'BLUETOOTH' ? colors.onBrand : colors.text} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.audioRouteOptionText, audioDeviceState.selectedDevice === 'BLUETOOTH' && styles.audioRouteOptionTextActive]}>
                      {audioDeviceState?.bluetoothName || 'Bluetooth Headset'}
                    </Text>
                    <Text style={styles.audioRouteOptionSub}>{t('Wireless connected audio')}</Text>
                  </View>
                  {audioDeviceState.selectedDevice === 'BLUETOOTH' && <View style={styles.audioRouteActiveDot} />}
                </TouchableOpacity>
              )}
              {audioDeviceState?.availableDevices?.includes('WIRED_HEADSET') && (
                <TouchableOpacity
                  style={[
                    styles.audioRouteOption,
                    audioDeviceState.selectedDevice === 'WIRED_HEADSET' && styles.audioRouteOptionActive,
                  ]}
                  onPress={async () => {
                    await onChooseAudioRoute?.('WIRED_HEADSET');
                    setShowAudioRouteModal(false);
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.audioRouteIconWrap, audioDeviceState.selectedDevice === 'WIRED_HEADSET' && styles.audioRouteIconWrapActive]}>
                    <HeadphoneIcon size={22} color={audioDeviceState.selectedDevice === 'WIRED_HEADSET' ? colors.onBrand : colors.text} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.audioRouteOptionText, audioDeviceState.selectedDevice === 'WIRED_HEADSET' && styles.audioRouteOptionTextActive]}>
                      {t('Wired Headset')}
                    </Text>
                    <Text style={styles.audioRouteOptionSub}>{t('3.5 mm or USB audio')}</Text>
                  </View>
                  {audioDeviceState.selectedDevice === 'WIRED_HEADSET' && <View style={styles.audioRouteActiveDot} />}
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[
                  styles.audioRouteOption,
                  (audioDeviceState ? audioDeviceState.selectedDevice === 'EARPIECE' : !isSpeakerOn) && styles.audioRouteOptionActive,
                ]}
                onPress={async () => {
                  if (onChooseAudioRoute) {
                    await onChooseAudioRoute('EARPIECE');
                  } else if (isSpeakerOn && onToggleSpeaker) {
                    onToggleSpeaker();
                  }
                  setShowAudioRouteModal(false);
                }}
                activeOpacity={0.7}
              >
                <View style={[styles.audioRouteIconWrap, (audioDeviceState ? audioDeviceState.selectedDevice === 'EARPIECE' : !isSpeakerOn) && styles.audioRouteIconWrapActive]}>
                  <EarpieceIcon size={22} color={(audioDeviceState ? audioDeviceState.selectedDevice === 'EARPIECE' : !isSpeakerOn) ? colors.onBrand : colors.text} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.audioRouteOptionText, (audioDeviceState ? audioDeviceState.selectedDevice === 'EARPIECE' : !isSpeakerOn) && styles.audioRouteOptionTextActive]}>
                    {t('Phone Earpiece')}
                  </Text>
                  <Text style={styles.audioRouteOptionSub}>{t('Handset speaker & microphone')}</Text>
                </View>
                {(audioDeviceState ? audioDeviceState.selectedDevice === 'EARPIECE' : !isSpeakerOn) && <View style={styles.audioRouteActiveDot} />}
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.audioRouteOption,
                  (audioDeviceState ? audioDeviceState.selectedDevice === 'SPEAKER_PHONE' : isSpeakerOn) && styles.audioRouteOptionActive,
                ]}
                onPress={async () => {
                  if (onChooseAudioRoute) {
                    await onChooseAudioRoute('SPEAKER_PHONE');
                  } else if (!isSpeakerOn && onToggleSpeaker) {
                    onToggleSpeaker();
                  }
                  setShowAudioRouteModal(false);
                }}
                activeOpacity={0.7}
              >
                <View style={[styles.audioRouteIconWrap, (audioDeviceState ? audioDeviceState.selectedDevice === 'SPEAKER_PHONE' : isSpeakerOn) && styles.audioRouteIconWrapActive]}>
                  <SpeakerIcon size={22} color={(audioDeviceState ? audioDeviceState.selectedDevice === 'SPEAKER_PHONE' : isSpeakerOn) ? colors.onBrand : colors.text} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.audioRouteOptionText, (audioDeviceState ? audioDeviceState.selectedDevice === 'SPEAKER_PHONE' : isSpeakerOn) && styles.audioRouteOptionTextActive]}>
                    {t('Loudspeaker')}
                  </Text>
                  <Text style={styles.audioRouteOptionSub}>{t('Hands-free speakerphone')}</Text>
                </View>
                {(audioDeviceState ? audioDeviceState.selectedDevice === 'SPEAKER_PHONE' : isSpeakerOn) && <View style={styles.audioRouteActiveDot} />}
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );

  // --- Active In-Call View ---
  if (activeCall) {
    const displayName = callDisplayName(activeCall.target, activeCall.targetName);
    const isCallingState = activeCall.status === 'calling';
    const isRingingState = activeCall.status === 'ringing';
    const isHeldState = activeCall.isHeld;
    const isConnectedState = activeCall.status === 'active' && !isHeldState;

    const callStatusBadgeText = activeCall.isGsmInterrupted
      ? 'PAUSED (CELLULAR CALL ACTIVE)'
      : isHeldState
      ? 'CALL ON HOLD'
      : isConnectedState
      ? t('CONNECTED • HD AUDIO')
      : isRingingState
      ? t('RINGING…')
      : t('DIALING…');


    return (
      <SafeAreaView style={styles.inCallContainer}>
        {/* Top Status & Hero Info */}
        <View style={styles.inCallTop}>
          {(activeCall.isGsmInterrupted || isHeldState) && (
            <View style={styles.inCallBadgePill}>
              <View
                style={[
                  styles.inCallBadgeDot,
                  (isCallingState || isRingingState) && styles.inCallBadgeDotCalling,
                  isHeldState && styles.inCallBadgeDotHeld,
                ]}
              />
              <Text style={styles.inCallBadgeText}>
                {callStatusBadgeText}
              </Text>
            </View>
          )}

          <InCallTimerDisplay startTime={activeCall.startTime} status={activeCall.status} />

          <Text style={styles.inCallName} numberOfLines={1}>
            {displayName}
          </Text>
          <View style={styles.inCallNumberBadge}>
            <PhoneIcon size={12} color={colors.brand} />
            <Text style={styles.inCallNumber}>{activeCall.target || account?.extension || ''}</Text>
          </View>
        </View>

        {/* DTMF Dialpad or 6-Button Glass Control Grid */}
        {showInCallDtmf ? (
          <View style={styles.dtmfGridContainer}>
            <View style={styles.dtmfGrid}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => (
                <TouchableOpacity key={k} style={styles.dtmfKey} onPress={() => onSendDtmf(k)} delayPressIn={0}>
                  <Text style={styles.dtmfKeyText}>{k}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={styles.dtmfCloseBtn} onPress={() => setShowInCallDtmf(false)} delayPressIn={0}>
              <Text style={styles.dtmfCloseText}>Hide Keypad</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.inCallControlsCard}>
            <View style={styles.inCallRow}>
              {/* Mute Button */}
              <View style={styles.inCallBtnCol}>
                <TouchableOpacity
                  style={[styles.inCallBtn, activeCall.isMuted && styles.inCallBtnMutedActive]}
                  onPress={onToggleMute}
                  delayPressIn={0}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={activeCall.isMuted ? 'Unmute microphone' : 'Mute microphone'}
                >
                  {activeCall.isMuted ? <MicOffIcon size={26} color={colors.onBrand} /> : <MicIcon size={26} color={colors.text} />}
                </TouchableOpacity>
                <Text style={[styles.inCallBtnLabel, activeCall.isMuted && { color: colors.dangerText }]}>
                  {activeCall.isMuted ? t('Unmute') : t('Mute')}
                </Text>
              </View>

              {/* Keypad DTMF Button */}
              <View style={styles.inCallBtnCol}>
                <TouchableOpacity
                  style={styles.inCallBtn}
                  onPress={() => setShowInCallDtmf(true)}
                  delayPressIn={0}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Show dialpad"
                >
                  <KeypadIcon size={26} color={colors.text} />
                </TouchableOpacity>
                <Text style={styles.inCallBtnLabel}>{t('Keypad')}</Text>
              </View>

              {/* Speaker / Bluetooth Audio Output Button */}
              <View style={styles.inCallBtnCol}>
                <TouchableOpacity
                  style={[
                    styles.inCallBtn,
                    (audioDeviceState?.selectedDevice === 'BLUETOOTH' || audioDeviceState?.selectedDevice === 'SPEAKER_PHONE' || isSpeakerOn) && styles.inCallBtnSpeakerActive,
                  ]}
                  onPress={() => {
                    if (audioDeviceState?.hasBluetooth || (audioDeviceState?.availableDevices?.length ?? 0) > 2) {
                      setShowAudioRouteModal(true);
                    } else if (onToggleSpeaker) {
                      onToggleSpeaker();
                    }
                  }}
                  onLongPress={() => {
                    if (onToggleSpeaker) {
                      onToggleSpeaker();
                    }
                  }}
                  delayPressIn={0}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Audio output device"
                >
                  {audioDeviceState?.selectedDevice === 'BLUETOOTH' ? (
                    <BluetoothIcon size={26} color={colors.onBrand} />
                  ) : audioDeviceState?.selectedDevice === 'SPEAKER_PHONE' || isSpeakerOn ? (
                    <SpeakerIcon size={26} color={colors.onBrand} />
                  ) : (
                    <SpeakerIcon size={26} color={colors.text} />
                  )}
                </TouchableOpacity>
                <Text
                  style={[
                    styles.inCallBtnLabel,
                    (audioDeviceState?.selectedDevice === 'BLUETOOTH' || audioDeviceState?.selectedDevice === 'SPEAKER_PHONE' || isSpeakerOn) && { color: colors.brand },
                  ]}
                >
                  {audioDeviceState?.selectedDevice === 'BLUETOOTH'
                    ? t('Bluetooth')
                    : audioDeviceState?.selectedDevice === 'SPEAKER_PHONE' || isSpeakerOn
                    ? t('Speaker')
                    : t('Earpiece')}
                </Text>
              </View>
            </View>

            <View style={styles.inCallRow}>
              {/* Hold / Resume Button */}
              <View style={styles.inCallBtnCol}>
                <TouchableOpacity
                  style={[styles.inCallBtn, activeCall.isHeld && styles.inCallBtnHoldActive]}
                  onPress={onToggleHold}
                  delayPressIn={0}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={activeCall.isHeld ? 'Resume call' : 'Hold call'}
                >
                  {activeCall.isHeld ? <PlayIcon size={26} color={colors.warning} /> : <PauseIcon size={26} color={colors.text} />}
                </TouchableOpacity>
                <Text style={[styles.inCallBtnLabel, activeCall.isHeld && { color: colors.warningText }]}>
                  {activeCall.isHeld ? t('Resume') : t('Hold')}
                </Text>
              </View>

              {/* Transfer Button */}
              <View style={styles.inCallBtnCol}>
                <TouchableOpacity
                  style={styles.inCallBtn}
                  onPress={() => setShowTransferModal(true)}
                  delayPressIn={0}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Transfer call"
                >
                  <TransferIcon size={26} color={colors.text} />
                </TouchableOpacity>
                <Text style={styles.inCallBtnLabel}>{t('Transfer')}</Text>
              </View>

              {/* Volume Adjustment Button */}
              <View style={styles.inCallBtnCol}>
                <TouchableOpacity
                  style={[styles.inCallBtn, showInCallVolumeModal && styles.inCallBtnActive]}
                  onPress={() => setShowInCallVolumeModal(true)}
                  delayPressIn={0}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="In-call volume"
                >
                  <SlidersIcon size={26} color={showInCallVolumeModal ? colors.brand : colors.text} />
                </TouchableOpacity>
                <Text style={[styles.inCallBtnLabel, showInCallVolumeModal && { color: colors.brand }]}>
                  {t('Volume')}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Warm Transfer Consultation Card */}
        {attendedTransferState && (() => {
          const xfer = attendedTransferState;
          const isGsmBlocked = activeCall.isGsmInterrupted === true;
          const canSwap =
            !isGsmBlocked &&
            pendingTransferAction === null &&
            (xfer.status === 'connected' || xfer.status === 'holding');
          const canComplete =
            !isGsmBlocked &&
            pendingTransferAction === null &&
            xfer.status === 'connected';
          const canCancel =
            pendingTransferAction === null &&
            xfer.status !== 'transferring' &&
            xfer.status !== 'recovering';

          const statusLabel: Record<typeof xfer.status, string> = {
            holding: 'Original on hold',
            dialing: 'Dialling consult…',
            ringing: 'Consult ringing…',
            connected: 'Consult connected',
            swapping: 'Swapping lines…',
            transferring: 'Completing transfer…',
            recovering: 'Recovering original…',
          };

          return (
            <View style={styles.consultCard}>
              <View style={styles.consultHeaderRow}>
                <View style={styles.consultBadge}>
                  <Text style={styles.consultBadgeText}>WARM TRANSFER</Text>
                </View>
                <Text style={styles.consultStatusText}>{statusLabel[xfer.status]}</Text>
              </View>

              <View style={styles.consultLinesRow}>
                <View style={[styles.consultLine, xfer.activeLine === 'original' && styles.consultLineActive]}>
                  <Text style={styles.consultLineLabel}>Original</Text>
                  <Text style={styles.consultLineTarget} numberOfLines={1}>{xfer.originalTarget}</Text>
                  {xfer.activeLine === 'original' && (
                    <Text style={styles.consultLineIndicator}>● ACTIVE</Text>
                  )}
                </View>
                <View style={styles.consultLineSep} />
                <View style={[styles.consultLine, xfer.activeLine === 'consult' && styles.consultLineActive]}>
                  <Text style={styles.consultLineLabel}>Consult</Text>
                  <Text style={styles.consultLineTarget} numberOfLines={1}>{xfer.consultTarget}</Text>
                  {xfer.activeLine === 'consult' && (
                    <Text style={styles.consultLineIndicator}>● ACTIVE</Text>
                  )}
                </View>
              </View>

              {xfer.error ? (
                <Text style={styles.consultErrorText}>{xfer.error}</Text>
              ) : null}

              {isGsmBlocked ? (
                <Text style={styles.consultGsmWarning}>Transfer actions disabled — cellular call active</Text>
              ) : null}

              <View style={styles.consultActionsRow}>
                <TouchableOpacity
                  style={[styles.consultActionBtn, styles.consultSwapBtn, !canSwap && styles.consultBtnDisabled]}
                  disabled={!canSwap}
                  activeOpacity={0.75}
                  onPress={() => {
                    if (!canSwap) return;
                    setPendingTransferAction('swap');
                    onSwapLines().catch(() => {/* error surfaced via onTransferError toast */}).finally(() => {
                      setPendingTransferAction(null);
                    });
                  }}
                >
                  <Text style={styles.consultActionBtnText}>
                    {pendingTransferAction === 'swap' ? 'Swapping…' : 'Swap'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.consultActionBtn, styles.consultCompleteBtn, !canComplete && styles.consultBtnDisabled]}
                  disabled={!canComplete}
                  activeOpacity={0.75}
                  onPress={() => {
                    if (!canComplete) return;
                    setPendingTransferAction('complete');
                    onCompleteTransfer().catch(() => {}).finally(() => {
                      setPendingTransferAction(null);
                    });
                  }}
                >
                  <Text style={styles.consultActionBtnText}>
                    {pendingTransferAction === 'complete' ? 'Transferring…' : 'Complete'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.consultActionBtn, styles.consultCancelBtn, !canCancel && styles.consultBtnDisabled]}
                  disabled={!canCancel}
                  activeOpacity={0.75}
                  onPress={() => {
                    if (!canCancel) return;
                    setPendingTransferAction('cancel');
                    onCancelTransfer().catch(() => {}).finally(() => {
                      setPendingTransferAction(null);
                    });
                  }}
                >
                  <Text style={[styles.consultActionBtnText, { color: colors.text }]}>
                    {pendingTransferAction === 'cancel' ? 'Cancelling…' : 'Cancel'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })()}


        {/* End Call Floating Action */}
        <View style={styles.hangupRow}>
          <TouchableOpacity
            style={styles.hangupBtn}
            onPress={onHangup}
            delayPressIn={0}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Hang up call"
          >
            <PhoneDeclineIcon size={34} color={colors.onBrand} />
          </TouchableOpacity>
        </View>

        {/* Transfer Dialog — Blind or Warm */}
        {showTransferModal && (
        <Modal
          visible={showTransferModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowTransferModal(false)}
        >
          <TouchableWithoutFeedback onPress={() => setShowTransferModal(false)}>
            <View style={styles.modalBackdrop}>
              <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
                <View style={styles.transferDialogCard}>
                  <View style={styles.transferHeaderRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.dialogTitle}>Transfer Call</Text>
                      <Text style={styles.transferSubTitle}>
                        {transferMode === 'blind'
                          ? 'Blind: send call immediately, no consultation.'
                          : 'Warm: put original on hold, call consult first.'}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => setShowTransferModal(false)}
                      style={styles.transferDismissBtn}
                    >
                      <CloseIcon size={18} color={colors.textDim} />
                    </TouchableOpacity>
                  </View>

                  {/* Mode Selector */}
                  <View style={styles.transferModeRow}>
                    <TouchableOpacity
                      style={[
                        styles.transferModeBtn,
                        transferMode === 'blind' && styles.transferModeBtnActive,
                      ]}
                      activeOpacity={0.75}
                      onPress={() => setTransferMode('blind')}
                    >
                      <Text style={[
                        styles.transferModeBtnText,
                        transferMode === 'blind' && styles.transferModeBtnTextActive,
                      ]}>Blind</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.transferModeBtn,
                        transferMode === 'warm' && styles.transferModeBtnActive,
                      ]}
                      activeOpacity={0.75}
                      onPress={() => setTransferMode('warm')}
                    >
                      <Text style={[
                        styles.transferModeBtnText,
                        transferMode === 'warm' && styles.transferModeBtnTextActive,
                      ]}>Warm</Text>
                    </TouchableOpacity>
                  </View>

                  <TextInput
                    style={styles.transferSearchInput}
                    value={transferTarget}
                    onChangeText={setTransferTarget}
                    placeholder="Filter or enter custom extension…"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="phone-pad"
                  />

                  {/* 1-Click Server Extensions List */}
                  <ScrollView
                    style={styles.transferListScroll}
                    contentContainerStyle={styles.transferListContent}
                    showsVerticalScrollIndicator={true}
                    keyboardShouldPersistTaps="handled"
                  >
                    {filteredTransferExtensions.map((item) => (
                      <TouchableOpacity
                        key={item.extension}
                        style={styles.transferExtRow}
                        onPress={() => {
                          if (transferMode === 'blind') {
                            onBlindTransfer(item.extension);
                            setShowTransferModal(false);
                            setTransferTarget('');
                          } else {
                            // Warm: close modal immediately; consultation card appears via state
                            setShowTransferModal(false);
                            setTransferTarget('');
                            setPendingTransferAction('start');
                            onStartWarmTransfer(item.extension).finally(() => {
                              setPendingTransferAction(null);
                            });
                          }
                        }}
                        activeOpacity={0.7}
                      >
                        <View style={styles.transferAvatarMini}>
                          <Text style={styles.transferAvatarText}>
                            {(item.name || item.extension).slice(0, 1).toUpperCase()}
                          </Text>
                        </View>
                        <View style={styles.transferExtInfo}>
                          <Text style={styles.transferExtName} numberOfLines={1}>
                            {item.name && item.name !== item.extension
                              ? item.name
                              : `Extension ${item.extension}`}
                          </Text>
                          <Text style={styles.transferExtNumber}>{item.extension}</Text>
                        </View>
                        <View style={[
                          styles.transferActionBadge,
                          transferMode === 'warm' && styles.transferActionBadgeWarm,
                        ]}>
                          <Text style={styles.transferActionText}>
                            {transferMode === 'blind' ? 'Transfer' : 'Consult'}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

                  {/* Manual transfer/consult button for custom numbers */}
                  {transferTarget.trim().length > 0 && (
                    <TouchableOpacity
                      style={styles.transferManualBtn}
                      onPress={() => {
                        const target = transferTarget.trim();
                        if (transferMode === 'blind') {
                          onBlindTransfer(target);
                          setShowTransferModal(false);
                          setTransferTarget('');
                        } else {
                          setShowTransferModal(false);
                          setTransferTarget('');
                          setPendingTransferAction('start');
                          onStartWarmTransfer(target).finally(() => {
                            setPendingTransferAction(null);
                          });
                        }
                      }}
                      activeOpacity={0.8}
                    >
                      <TransferIcon size={16} color={colors.onBrand} />
                      <Text style={styles.transferManualText}>
                        {transferMode === 'blind'
                          ? `Transfer to "${transferTarget.trim()}"`
                          : `Consult "${transferTarget.trim()}"`}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>
        )}

        {/* In-Call Audio & Volume Adjustment Sheet */}
        {showInCallVolumeModal && renderVolumeModal()}
        {showAudioRouteModal && renderAudioRouteModal()}
      </SafeAreaView>
    );
  }

  // --- Main Phone Application ---
  return (
    <SafeAreaView style={styles.container}>
      {/* Top Title Bar with Connection Status Badge */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topTitle}>
            {activeTab === 'phone' ? 'VOICE' : activeTab === 'contacts' ? t('Contacts') : t('Chat')}
          </Text>
          <TouchableOpacity
            style={[
              styles.statusBadge,
              state === 'registered' ? styles.statusBadgeOk : state === 'connecting' ? styles.statusBadgeWait : styles.statusBadgeErr,
            ]}
            onPress={openSettings}
          >
            <View
              style={[
                styles.statusDot,
                { backgroundColor: state === 'registered' ? colors.success : state === 'connecting' ? colors.warning : colors.danger },
              ]}
            />
            <Text
              style={[
                styles.statusBadgeText,
                { color: state === 'registered' ? colors.successText : state === 'connecting' ? colors.warningText : colors.dangerText },
              ]}
            >
              {state === 'registered'
                ? `${account?.extension || ''} · ${t('Connected')} ✓`
                : state === 'connecting'
                ? `${account?.extension || ''} · ${t('Connecting…')}`
                : `${account?.extension || ''} · ${t('Offline')}`}
            </Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={styles.menuBtn} onPress={() => setShowMenu(!showMenu)}>
          <MenuDotsIcon size={24} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* 3-Dots Dropdown Menu & Click-Outside Dismiss Backdrop */}
      {showMenu && (
        <>
          <TouchableWithoutFeedback onPress={() => setShowMenu(false)}>
            <View style={styles.menuBackdrop} />
          </TouchableWithoutFeedback>
          <Animated.View
            style={[
              styles.dropdownMenu,
              I18nManager.isRTL ? { left: 20, right: undefined, transformOrigin: 'left top' } : null,
              {
                opacity: menuAnim,
                transform: [
                  {
                    scale: menuAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.92, 1],
                    }),
                  },
                  {
                    translateY: menuAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-6, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <TouchableOpacity
              style={styles.dropdownItem}
              onPress={() => {
                setShowMenu(false);
                openSettings();
              }}
            >
              <View style={styles.menuItemRow}>
                <SettingsIcon size={18} color={colors.brand} />
                <Text style={styles.dropdownText}>{t('Settings & PBX Host')}</Text>
              </View>
            </TouchableOpacity>
            {activeTab === 'phone' && (
              <TouchableOpacity
                style={styles.dropdownItem}
                onPress={() => {
                  setShowMenu(false);
                  onClearHistory();
                }}
              >
                <View style={styles.menuItemRow}>
                  <TrashIcon size={18} color={colors.textMuted} />
                  <Text style={styles.dropdownText}>{t('Clear History')}</Text>
                </View>
              </TouchableOpacity>
            )}
            {activeTab === 'contacts' && (
              <>
                <TouchableOpacity
                  style={styles.dropdownItem}
                  onPress={() => {
                    setShowMenu(false);
                    setEditingContact(null);
                    setShowAddContactModal(true);
                  }}
                >
                  <View style={styles.menuItemRow}>
                    <PlusIcon size={18} color={colors.success} />
                    <Text style={styles.dropdownText}>{t('Add Contact')}</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.dropdownItem}
                  onPress={() => {
                    setShowMenu(false);
                    handleSyncContacts();
                  }}
                >
                  <View style={styles.menuItemRow}>
                    <ContactsIcon size={18} color={colors.brand} />
                    <Text style={styles.dropdownText}>{t('Sync Phone Contacts')}</Text>
                  </View>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity
              style={[styles.dropdownItem, { borderTopWidth: 1, borderTopColor: colors.border }]}
              onPress={handleSignOutClick}
            >
              <View style={styles.menuItemRow}>
                <LogoutIcon size={18} color={colors.dangerText} />
                <Text style={[styles.dropdownText, { color: colors.dangerText }]}>{t('Sign Out')}</Text>
              </View>
            </TouchableOpacity>
          </Animated.View>
        </>
      )}

      {/* Main Tab Views — direct render with a RTL-aware page transition */}
      <Animated.View
        style={{
          flex: 1,
          opacity: pageOpacity,
          transform: [{ translateX: pageTranslateX }],
        }}
        {...tabSwipeResponder.panHandlers}
      >
        {activeTab === 'phone' && (
        <View style={{ flex: 1, overflow: 'hidden' }}>
        <View style={styles.phoneTabContent}>
          {/* Top: All / Missed Calls Filter Segmented Switch */}
          <View style={styles.historyFilterRow}>
            <View style={styles.historyFilterSegmented}>
              <TouchableOpacity
                style={[
                  styles.filterSegmentBtn,
                  historyFilter === 'all' && styles.filterSegmentBtnActive,
                ]}
                onPress={() => setHistoryFilter('all')}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.filterSegmentText,
                    historyFilter === 'all' && styles.filterSegmentTextActive,
                  ]}
                >
                  {t('All')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.filterSegmentBtn,
                  historyFilter === 'missed' && styles.filterSegmentBtnActive,
                ]}
                onPress={() => setHistoryFilter('missed')}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.filterSegmentText,
                    historyFilter === 'missed' && styles.filterSegmentTextActive,
                  ]}
                >
                  {t('Missed')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Live contact matches while dialing, otherwise recents history */}
          <View style={styles.recentsSection}>
            {showDialSearch ? (
              <View style={styles.dialMatchPanel}>
                <Text style={styles.dialMatchHeader}>{t('Contacts')}</Text>
                {dialSearchMatches.length === 0 ? (
                  <Text style={styles.dialMatchEmpty}>{t('No contacts found')}</Text>
                ) : (
                  <FlatList
                    data={dialSearchMatches}
                    keyExtractor={contactKeyExtractor}
                    style={styles.dialMatchList}
                    keyboardShouldPersistTaps="handled"
                    nestedScrollEnabled
                    showsVerticalScrollIndicator
                    renderItem={({ item }) => (
                      <TouchableOpacity
                        style={styles.dialMatchRow}
                        activeOpacity={0.7}
                        delayPressIn={0}
                        onPress={() => {
                          onCall(item.extension);
                          setDigits('');
                          setCursorIndex(0);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`${t('Call')} ${item.name}, ${item.extension}`}
                      >
                        <View style={styles.dialMatchInfo}>
                          <Text style={styles.dialMatchName} numberOfLines={1}>
                            {item.name}
                          </Text>
                          <Text style={styles.dialMatchExt}>
                            {item.extension}
                          </Text>
                        </View>
                        <PhoneIcon size={16} color={colors.brand} />
                      </TouchableOpacity>
                    )}
                  />
                )}
              </View>
            ) : displayedCalls.length === 0 ? (
              <View style={styles.emptyHistory}>
                <Text style={styles.emptyHistoryText}>
                  {historyFilter === 'missed' ? t('No missed calls') : t('No recent calls')}
                </Text>
              </View>
            ) : (
              <FlatList
                data={recentCalls}
                keyExtractor={recentKeyExtractor}
                showsVerticalScrollIndicator={false}
                initialNumToRender={10}
                maxToRenderPerBatch={10}
                windowSize={5}
                removeClippedSubviews={Platform.OS === 'android'}
                contentContainerStyle={{ paddingBottom: isDialpadVisible ? dialpadKeysHeight : 0 }}
                renderItem={renderRecentCall}
              />
            )}
          </View>

          {/* Lower Half: Dialpad Display & 3x4 Keypad */}
          <View style={styles.dialpadSection}>
            <View
              pointerEvents={isDialpadVisible ? 'box-none' : 'none'}
              style={[styles.dialpadKeysClip, { height: dialpadKeysHeight }]}
            >
            <Animated.View
              onLayout={(e) => setDialpadKeysHeight(e.nativeEvent.layout.height)}
              pointerEvents={isDialpadVisible ? 'auto' : 'none'}
              style={[
                styles.dialpadKeysOverlay,
                {
                  opacity: dialpadAnim,
                  transform: [
                    {
                      translateY: dialpadAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [dialpadKeysHeight, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
                {/* Native input retains selection handles and copy/paste menu. */}
                <View style={styles.numberRow}>
                  <TextInput
                    testID="dial-number-input"
                    accessibilityLabel={t('Enter number or ext…')}
                    style={[styles.dialedDigits, { width: '100%', minHeight: 44, textAlign: 'center', writingDirection: 'ltr', paddingVertical: 0 }]}
                    value={digits}
                    onChangeText={setDigits}
                    selection={dialSelection}
                    onSelectionChange={(event) => setDialSelection(event.nativeEvent.selection)}
                    showSoftInputOnFocus={false}
                    contextMenuHidden={false}
                    autoCorrect={false}
                    autoCapitalize="none"
                    keyboardType="phone-pad"
                    selectionColor={colors.brand}
                    underlineColorAndroid="transparent"
                  />

                  {hasDigits ? (
                    <TouchableOpacity
                      style={styles.topBackspaceBtn}
                      onPress={handleBackspace}
                      onLongPress={() => {
                        setDigits('');
                        setCursorIndex(0);
                      }}
                      hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
                      activeOpacity={0.6}
                      accessibilityRole="button"
                      accessibilityLabel="Delete digit (hold to clear)"
                    >
                      <BackspaceIcon size={22} color={colors.textMuted} />
                    </TouchableOpacity>
                  ) : null}
                </View>

                {/* 3x4 Dialpad Grid */}
                <View style={styles.keypadGrid}>
                  {DIALPAD_KEYS.map((k) => {
                    const speedTarget = speedDial[k.digit]?.trim();
                    const isConfigured = Boolean(speedTarget);
                    return (
                      <AnimatedDialpadKey
                        key={k.digit}
                        k={k}
                        isConfigured={isConfigured}
                        speedTarget={speedTarget}
                        onPress={handleDigitPress}
                        onLongPress={handleKeyLongPress}
                      />
                    );
                  })}
                </View>
            </Animated.View>
            </View>

            {/* Bottom Action Bar */}
            <View
              style={[
                styles.dialActionsRow,
                isDialpadVisible && styles.dialActionsRowExpanded,
              ]}
            >
              <View style={styles.dialActionsGroup}>
                <TouchableOpacity
                  style={[
                    styles.dialAuxBtn,
                    !hasDigits && !hasRedial && styles.dialAuxBtnDisabled,
                  ]}
                  onPress={handleAuxAction}
                  disabled={!hasDigits && !hasRedial}
                  accessibilityRole="button"
                  accessibilityLabel={
                    hasDigits ? 'Add to contacts' : 'Redial last number'
                  }
                >
                  {hasDigits ? (
                    <UserPlusIcon size={22} color={colors.brand} />
                  ) : (
                    <RedialIcon
                      size={22}
                      color={hasRedial ? colors.textMuted : colors.textFaint}
                    />
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.mainCallPill,
                    !digits && styles.mainCallPillDisabled,
                  ]}
                  onPress={handleDial}
                  disabled={!digits}
                  accessibilityRole="button"
                  accessibilityLabel={t('Call')}
                >
                  <PhoneIcon size={24} color={colors.onBrand} />
                </TouchableOpacity>

                {/* Pull Down / Pull Up Dialpad Toggle Button */}
                <TouchableOpacity
                  style={styles.dialAuxBtn}
                  onPress={toggleDialpad}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={isDialpadVisible ? 'Hide dialpad' : 'Show dialpad'}
                >
                  <Animated.View
                    style={{
                      transform: [
                        {
                          rotate: dialpadAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: ['180deg', '0deg'],
                          }),
                        },
                      ],
                    }}
                  >
                    <ChevronDownIcon size={24} color={isDialpadVisible ? colors.textMuted : colors.brand} />
                  </Animated.View>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
        </View>

        )}
        {activeTab === 'contacts' && (
        <View style={{ flex: 1 }}>
        <View style={styles.contactsContent}>
          <View style={styles.contactsHeaderRow}>
            <TextInput
              style={styles.contactSearchInputFlex}
              value={contactSearch}
              onChangeText={setContactSearch}
              placeholder={t('Search contacts…')}
              placeholderTextColor={colors.textFaint}
            />
            <TouchableOpacity
              style={styles.syncContactsHeaderBtn}
              onPress={() => {
                setEditingContact(null);
                setShowAddContactModal(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={t('Add Contact')}
            >
              <UserPlusIcon size={18} color={colors.brand} />
              <Text style={styles.syncContactsHeaderBtnText}>
                {t('Add Contact')}
              </Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={filteredContacts}
            keyExtractor={contactKeyExtractor}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={5}
            removeClippedSubviews={Platform.OS === 'android'}
            contentContainerStyle={styles.contactsListContent}
            renderItem={renderContact}
          />
        </View>
        </View>

        )}
        {activeTab === 'chat' && (
        <View style={{ flex: 1 }}>
          <ChatTab
            account={account}
            client={chatClient ?? null}
            cache={chatCache ?? null}
            unread={chatUnread}
            conversations={chatConversationsWithNames}
            onOpenThread={setOpenThread}
            onRefresh={onChatRefresh ?? (() => Promise.resolve())}
          />
        </View>
        )}
      </Animated.View>

      {/* Chat thread overlay — full-screen modal */}
      {openThread !== null && chatClient && chatCache && (
        <ChatThreadScreen
          conversation={openThread}
          ownExtension={account?.extension ?? ''}
          client={chatClient}
          cache={chatCache}
          socket={chatSocket}
          onClose={() => setOpenThread(null)}
          onCall={(ext) => { setOpenThread(null); onCall(ext); }}
          onUnreadChange={onChatRead}
        />
      )}

      {/* Bottom Navigation Bar */}
      <View style={styles.bottomNav}>
        <Animated.View
          style={[
            styles.tabIndicatorPill,
            {
              transform: [
                {
                  translateX: tabIndicatorAnim.interpolate({
                    inputRange: [0, 1, 2],
                    outputRange: I18nManager.isRTL
                      ? [
                          (SCREEN_WIDTH / 3) * 2 + (SCREEN_WIDTH / 3 - 48) / 2,
                          (SCREEN_WIDTH / 3) * 1 + (SCREEN_WIDTH / 3 - 48) / 2,
                          (SCREEN_WIDTH / 3) * 0 + (SCREEN_WIDTH / 3 - 48) / 2,
                        ]
                      : [
                          (SCREEN_WIDTH / 3) * 0 + (SCREEN_WIDTH / 3 - 48) / 2,
                          (SCREEN_WIDTH / 3) * 1 + (SCREEN_WIDTH / 3 - 48) / 2,
                          (SCREEN_WIDTH / 3) * 2 + (SCREEN_WIDTH / 3 - 48) / 2,
                        ],
                  }),
                },
              ],
            },
          ]}
        />
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => handleTabPress('phone')}
        >
          <PhoneIcon size={20} color={activeTab === 'phone' ? colors.brand : colors.textFaint} />
          <Text style={[styles.navLabel, activeTab === 'phone' && styles.navLabelActive]}>{t('Phone')}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => handleTabPress('contacts')}
        >
          <ContactsIcon size={20} color={activeTab === 'contacts' ? colors.brand : colors.textFaint} />
          <Text style={[styles.navLabel, activeTab === 'contacts' && styles.navLabelActive]}>{t('Contacts')}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => handleTabPress('chat')}
        >
          <View>
            <ChatIcon size={20} color={activeTab === 'chat' ? colors.brand : colors.textFaint} />
            {chatUnread.total > 0 && (
              <View style={styles.navBadge}>
                <Text style={styles.navBadgeText}>{chatUnread.total > 99 ? '99+' : String(chatUnread.total)}</Text>
              </View>
            )}
          </View>
          <Text style={[styles.navLabel, activeTab === 'chat' && styles.navLabelActive]}>{t('Chat')}</Text>
        </TouchableOpacity>
      </View>

      {/* Settings Modal (Click-Outside to Dismiss) */}
      <Modal visible={showSettingsModal} transparent animationType="fade" onRequestClose={() => setShowSettingsModal(false)}>
        <View style={styles.modalBackdrop}>
          <TouchableWithoutFeedback onPress={() => setShowSettingsModal(false)}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
          <View style={styles.settingsCardWrapper}>
              <ScrollView
                style={styles.settingsScroll}
                contentContainerStyle={styles.settingsCard}
                showsVerticalScrollIndicator={true}
                keyboardShouldPersistTaps="handled"
                bounces={true}
                overScrollMode="always"
              >
                  <Text style={styles.settingsTitle}>{t('PBX Server & Credentials')}</Text>

                  <Text style={styles.fieldLabel}>{t('SIP EXTENSION')}</Text>
                  <TextInput
                    style={styles.settingsInput}
                    value={editExt}
                    onChangeText={setEditExt}
                    placeholder="Extension"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="number-pad"
                  />

                  <Text style={styles.fieldLabel}>{t('SIP PASSWORD')}</Text>
                  <TextInput
                    style={styles.settingsInput}
                    value={editPass}
                    onChangeText={setEditPass}
                    placeholder="SIP Secret"
                    placeholderTextColor={colors.textFaint}
                    secureTextEntry
                  />

                  <Text style={styles.fieldLabel}>{t('PBX SERVER HOST / IP')}</Text>
                  <TextInput
                    style={styles.settingsInput}
                    value={editHost}
                    onChangeText={setEditHost}
                    placeholder="e.g. pbx.yourcompany.com"
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />

                  <Text style={styles.fieldLabel}>{t('LOCAL FALLBACK GATEWAY (OPTIONAL)')}</Text>
                  <TextInput
                    style={styles.settingsInput}
                    value={editFallbackHost}
                    onChangeText={setEditFallbackHost}
                    placeholder="e.g. 192.168.100.50:18080"
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />

                  <TouchableOpacity
                    style={styles.switchRow}
                    activeOpacity={0.7}
                    onPress={() => setEditTls(!editTls)}
                  >
                    <View style={styles.switchTextCol}>
                      <Text style={styles.switchLabel}>{t('TLS / WSS Protocol')}</Text>
                      <Text style={styles.switchSub}>
                        {editTls ? t('Port 8089 (WSS)') : t('Port 8088 (Plain WS on LAN)')}
                      </Text>
                    </View>
                    <View pointerEvents="none">
                      <Switch
                        value={editTls}
                        thumbColor={editTls ? colors.onBrand : colors.textFaint}
                        trackColor={{ false: colors.borderStrong, true: colors.brandFill }}
                      />
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.switchRow}
                    activeOpacity={0.7}
                    onPress={() => setEditDnd(!editDnd)}
                  >
                    <View style={styles.switchTextCol}>
                      <Text style={styles.switchLabel}>{t('Do Not Disturb (DND)')}</Text>
                      <Text style={styles.switchSub}>{t('Auto-reject incoming calls')}</Text>
                    </View>
                    <View pointerEvents="none">
                      <Switch
                        value={editDnd}
                        thumbColor={editDnd ? colors.onBrand : colors.textFaint}
                        trackColor={{ false: colors.borderStrong, true: colors.dangerFill }}
                      />
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.switchRow}
                    activeOpacity={0.7}
                    onPress={() => setEditAuto(!editAuto)}
                  >
                    <View style={styles.switchTextCol}>
                      <Text style={styles.switchLabel}>{t('Auto-Answer')}</Text>
                      <Text style={styles.switchSub}>{t('Auto-accept incoming calls')}</Text>
                    </View>
                    <View pointerEvents="none">
                      <Switch
                        value={editAuto}
                        thumbColor={editAuto ? colors.onBrand : colors.textFaint}
                        trackColor={{ false: colors.borderStrong, true: colors.brandFill }}
                      />
                    </View>
                  </TouchableOpacity>

                  <View style={styles.switchRow}>
                    <View style={styles.switchTextCol}>
                      <Text style={styles.switchLabel}>{t('Language')}</Text>
                      <Text style={styles.switchSub}>English · العربية</Text>
                    </View>
                  </View>
                  <View style={styles.languageRow}>
                    <TouchableOpacity
                      style={[styles.languagePill, lang === 'en' && styles.languagePillActive]}
                      onPress={() => { void changeLanguage('en'); }}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.languagePillText, lang === 'en' && styles.languagePillTextActive]}>
                        English
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.languagePill, lang === 'ar' && styles.languagePillActive]}
                      onPress={() => { void changeLanguage('ar'); }}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.languagePillText, lang === 'ar' && styles.languagePillTextActive]}>
                        العربية
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.settingsSectionDivider} />
                  <Text style={styles.settingsSectionTitle}>{t('Preferred Audio Codec')}</Text>
                  <Text style={styles.settingsSectionSub}>
                    Select your preferred codec for voice calls. Opus delivers HD clarity; G.722 & PCMU offer legacy VoIP compatibility:
                  </Text>

                  <View style={styles.codecGrid}>
                    {[
                      { id: 'opus', label: 'Opus HD', sub: '48 kHz Fullband (Recommended)' },
                      { id: 'g722', label: 'G.722 HD', sub: '16 kHz Wideband VoIP' },
                      { id: 'pcmu', label: 'PCMU / G.711u', sub: '8 kHz Standard PSTN' },
                      { id: 'pcma', label: 'PCMA / G.711a', sub: '8 kHz European PSTN' },
                      { id: 'auto', label: 'Auto', sub: 'Negotiate all supported codecs' },
                    ].map((item) => {
                      const isSelected = editCodec === item.id;
                      return (
                        <TouchableOpacity
                          key={item.id}
                          style={[styles.codecPill, isSelected && styles.codecPillActive]}
                          onPress={() => setEditCodec(item.id as CodecPreference)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.codecPillLabel, isSelected && styles.codecPillLabelActive]}>
                            {item.label}
                          </Text>
                          <Text style={[styles.codecPillSub, isSelected && styles.codecPillSubActive]}>
                            {item.sub}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <UnifiedAudioControls
                    speakerVolume={editSpeakerVol}
                    micVolume={editMicVol}
                    speakerStep={inCallSpeakerStep}
                    isSpeakerOn={isSpeakerOn}
                    onChangeSpeaker={handleSpeakerChange}
                    onChangeMic={handleMicChange}
                    onToggleSpeaker={onToggleSpeaker}
                    showRouteControls={false}
                  />
                  <View style={styles.settingsSectionDivider} />
                  <Text style={styles.settingsSectionTitle}>{t('Speed Dial (Keys 1 – 9)')}</Text>
                  <Text style={styles.settingsSectionSub}>
                    Hold down any key on the dialpad to directly call these numbers:
                  </Text>
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => {
                    const isVmKey = digit === '1';
                    const currentValue = editSpeedDial[digit] || '';
                    return (
                      <View key={digit} style={styles.speedDialConfigRow}>
                        <View style={[styles.speedDialBadge, isVmKey && styles.speedDialBadgeVm]}>
                          <Text style={[styles.speedDialBadgeText, isVmKey && styles.speedDialBadgeTextVm]}>
                            {digit}
                          </Text>
                        </View>
                        <TextInput
                          style={styles.speedDialInput}
                          value={currentValue}
                          onChangeText={(val) =>
                            setEditSpeedDial((prev) => ({ ...prev, [digit]: val }))
                          }
                          placeholder={isVmKey ? '*97 (Voicemail)' : `Speed dial ${digit} (empty)`}
                          placeholderTextColor={colors.textFaint}
                          autoCapitalize="none"
                        />
                        {currentValue.trim() && !isVmKey ? (
                          <TouchableOpacity
                            onPress={() =>
                              setEditSpeedDial((prev) => {
                                const next = { ...prev };
                                delete next[digit];
                                return next;
                              })
                            }
                            style={styles.speedDialClearBtn}
                          >
                            <CloseIcon size={14} color={colors.textMuted} />
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    );
                  })}
                  <View style={styles.settingsSectionDivider} />
                  <Text style={styles.settingsSectionTitle}>{t('WhatsApp')}</Text>
                  <Text style={styles.fieldLabel}>{t('WhatsApp country code')}</Text>
                  <TextInput
                    style={styles.settingsInput}
                    value={editWhatsAppCountryCode}
                    onChangeText={(value) =>
                      setEditWhatsAppCountryCode(value.replace(/\D/g, '').slice(0, 4))
                    }
                    placeholder={t('e.g. 20')}
                    placeholderTextColor={colors.textFaint}
                    keyboardType="number-pad"
                    maxLength={4}
                  />
                  <TouchableOpacity
                    style={styles.switchRow}
                    activeOpacity={0.7}
                    onPress={() => setEditWhatsAppPrompt(!editWhatsAppPrompt)}
                  >
                    <View style={styles.switchTextCol}>
                      <Text style={styles.switchLabel}>{t('Ask for country code when needed')}</Text>
                      <Text style={styles.switchSub}>{t('Prompt once for local numbers')}</Text>
                    </View>
                    <View pointerEvents="none">
                      <Switch
                        value={editWhatsAppPrompt}
                        thumbColor={editWhatsAppPrompt ? colors.onBrand : colors.textFaint}
                        trackColor={{ false: colors.borderStrong, true: colors.brandFill }}
                      />
                    </View>
                  </TouchableOpacity>

                  <View style={styles.settingsActions}>
                    {account && onRepairPush ? (
                      <TouchableOpacity
                        onPress={async () => {
                          const repaired = await onRepairPush();
                          Alert.alert(
                            'Notifications',
                            repaired
                              ? 'Push notifications were re-registered.'
                              : 'Push registration could not be repaired. Check notification permission and network.',
                          );
                        }}
                        style={styles.dialogCancelBtn}
                      >
                        <Text style={styles.dialogCancelText}>{t('Repair notifications')}</Text>
                      </TouchableOpacity>
                    ) : null}
                    {!fullScreenCallsAllowed ? (
                      <TouchableOpacity
                        onPress={async () => {
                          await openFullScreenIntentSettings();
                          setFullScreenCallsAllowed(await canUseFullScreenIntent());
                        }}
                        style={styles.dialogCancelBtn}
                      >
                        <Text style={styles.dialogCancelText}>{t('Allow full-screen calls')}</Text>
                      </TouchableOpacity>
                    ) : null}
                    {account ? (
                      <TouchableOpacity onPress={() => setShowSettingsModal(false)} style={styles.dialogCancelBtn}>
                        <Text style={styles.dialogCancelText}>{t('Cancel')}</Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity onPress={handleSaveSettings} style={styles.settingsSaveBtn}>
                      <Text style={styles.settingsSaveText}>{t('Save & Connect')}</Text>
                    </TouchableOpacity>
                  </View>
                </ScrollView>
              </View>
          </View>
      </Modal>

      {/* Add / Edit Contact Modal (Click-Outside to Dismiss) */}
      <Modal visible={showAddContactModal} transparent animationType="fade" onRequestClose={closeContactModal}>
        <View style={styles.modalBackdrop}>
          <TouchableWithoutFeedback onPress={closeContactModal}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
          <View style={styles.dialogCard}>
                <Text style={styles.dialogTitle}>
                  {editingContact ? t('Edit Contact') : t('Add New Contact')}
                </Text>

                <Text style={styles.fieldLabel}>NAME</Text>
                <TextInput
                  style={styles.dialogInput}
                  value={newContactName}
                  onChangeText={setNewContactName}
                  placeholder="e.g. Support"
                  placeholderTextColor={colors.textFaint}
                />

                <Text style={styles.fieldLabel}>EXTENSION / PHONE</Text>
                <TextInput
                  style={styles.dialogInput}
                  value={newContactNumber}
                  onChangeText={setNewContactNumber}
                  placeholder="e.g. 101"
                  placeholderTextColor={colors.textFaint}
                  keyboardType="phone-pad"
                />

                <View style={styles.dialogActions}>
                  <TouchableOpacity onPress={closeContactModal} style={styles.dialogCancelBtn}>
                    <Text style={styles.dialogCancelText}>{t('Cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={handleCreateContact} style={styles.dialogSubmitBtn}>
                    <Text style={styles.dialogSubmitText}>Save</Text>
                  </TouchableOpacity>
                </View>
              </View>
          </View>
      </Modal>
      <CallerProfileModal
        visible={profileNumber !== null}
        number={profileNumber}
        calls={callsHistory}
        contacts={contacts}
        whatsappCountryCode={whatsappPrefs.countryCode}
        whatsappPromptEnabled={whatsappPrefs.promptEnabled}
        onClose={() => setProfileNumber(null)}
        onCall={(target) => {
          setProfileNumber(null);
          onCall(target);
        }}
        onAddContact={(name, target) => {
          setProfileNumber(null);
          setEditingContact(null);
          setNewContactName(name);
          setNewContactNumber(target);
          setShowAddContactModal(true);
        }}
        onEditContact={(contact) => {
          setProfileNumber(null);
          setEditingContact(contact);
          setNewContactName(contact.name);
          setNewContactNumber(contact.extension);
          setShowAddContactModal(true);
        }}
        onDeleteContact={onDeleteContact}
        onToggleFavorite={onToggleFavorite}
        onDeleteRecord={onDeleteCallRecord}
        onSaveWhatsAppCountryCode={handleSaveWhatsAppCountryCode}
      />
      {showInCallVolumeModal && renderVolumeModal()}
    </SafeAreaView>
  );
}

export function StandardPhoneScreen(props: Props) {
  const { colors } = useTheme();
  const styles = useMemo(
    () => themedStyles(rawStyles, colors, SCREEN_OVERRIDES),
    [colors],
  );
  return (
    <ScreenStylesContext.Provider value={styles}>
      <StandardPhoneScreenInner {...props} />
    </ScreenStylesContext.Provider>
  );
}

const rawStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 12,
  },
  topTitle: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    alignSelf: 'flex-start',
    backgroundColor: '#09090b',
  },
  statusBadgeOk: {
    borderColor: '#064e3b',
  },
  statusBadgeWait: {
    borderColor: '#78350f',
  },
  statusBadgeErr: {
    borderColor: '#450a0a',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  recentMainCol: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  menuBtn: {
    padding: 8,
  },
  menuBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 998,
  },
  dropdownMenu: {
    position: 'absolute',
    top: 56,
    right: 20,
    transformOrigin: 'right top',
    backgroundColor: '#18181b',
    borderRadius: 14,
    paddingVertical: 6,
    borderColor: '#27272a',
    borderWidth: 1,
    zIndex: 999,
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 12,
    elevation: 10,
    minWidth: 200,
  },
  dropdownItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  menuItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dropdownText: {
    color: '#f4f4f5',
    fontSize: 14,
    fontWeight: '600',
  },
  phoneTabContent: {
    flex: 1,
    justifyContent: 'space-between',
  },
  historyFilterRow: {
    paddingHorizontal: 20,
    paddingTop: 2,
    paddingBottom: 8,
  },
  historyFilterSegmented: {
    flexDirection: 'row',
    backgroundColor: '#18181b',
    borderRadius: 24,
    padding: 3,
    borderColor: '#27272a',
    borderWidth: 1,
  },
  filterSegmentBtn: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  filterSegmentBtnActive: {
    backgroundColor: '#27272a',
  },
  filterSegmentText: {
    color: '#71717a',
    fontSize: 13,
    fontWeight: '600',
  },
  filterSegmentTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  recentsSection: {
    flex: 1,
    paddingHorizontal: 20,
    minHeight: 120,
  },
  dialMatchPanel: {
    maxHeight: 220,
    marginTop: 2,
    backgroundColor: '#18181b',
    borderColor: '#27272a',
    borderWidth: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  dialMatchHeader: {
    color: '#71717a',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    paddingHorizontal: 12,
    paddingTop: 9,
    paddingBottom: 3,
  },
  dialMatchList: {
    maxHeight: 185,
  },
  dialMatchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: '#27272a',
  },
  dialMatchInfo: {
    flex: 1,
    marginEnd: 10,
  },
  dialMatchName: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  dialMatchExt: {
    color: '#71717a',
    fontSize: 12,
    marginTop: 1,
  },
  dialMatchEmpty: {
    color: '#71717a',
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 16,
    textAlign: 'center',
  },
  emptyHistory: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
  },
  emptyHistoryText: {
    color: '#71717a',
    fontSize: 14,
  },
  recentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  avatarMini: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#18181b',
    borderColor: '#27272a',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentInfo: {
    flex: 1,
    marginLeft: 14,
  },
  recentName: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  recentNameMissed: {
    color: '#ef4444',
  },
  recentSub: {
    color: '#71717a',
    fontSize: 12,
    marginTop: 2,
  },
  recentSubMissed: {
    color: '#ef4444',
  },
  recentTime: {
    color: '#71717a',
    fontSize: 12,
    marginRight: 10,
  },
  infoCircleBtn: {
    padding: 6,
  },
  dialpadSection: {
    backgroundColor: '#000000',
    paddingTop: 0,
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  dialpadKeysClip: {
    position: 'absolute',
    left: 0,
    right: 0,
    // Keep in sync with dialActionsRow so the keypad cannot overlap the pill.
    bottom: 78,
    overflow: 'hidden',
    zIndex: 5,
    elevation: 5,
  },
  dialpadKeysOverlay: {
    backgroundColor: '#000000',
    borderTopColor: '#27272a',
    borderTopWidth: 1,
    paddingTop: 8,
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  dialpadSectionCollapsed: {
    paddingTop: 16,
    paddingBottom: 16,
    minHeight: 80,
    justifyContent: 'center',
  },
  numberRow: {
    direction: 'ltr',
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
    paddingHorizontal: 48,
    position: 'relative',
  },
  topBackspaceBtn: {
    position: 'absolute',
    right: 8,
    padding: 6,
  },
  digitsWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: '100%',
  },
  dialedDigits: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: 2,
  },
  digitCharTouch: {
    paddingHorizontal: 1,
    paddingVertical: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cursorEdgeTouch: {
    width: 6,
    height: 32,
  },
  cursorCaret: {
    width: 2.5,
    height: 28,
    backgroundColor: '#38bdf8',
    borderRadius: 1.5,
    marginHorizontal: 1.5,
  },
  keypadGrid: {
    direction: 'ltr',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 12,
    paddingHorizontal: 8,
  },
  keyCol: {
    width: '30%',
    aspectRatio: 1.35,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyAnimatedWrap: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyBtn: {
    width: '100%',
    height: '100%',
    borderRadius: 20,
    backgroundColor: '#18181b',
    borderColor: '#27272a',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyNumber: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '500',
    lineHeight: 34,
    textAlign: 'center',
  },
  keySubRow: {
    height: 14,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyLetters: {
    color: '#a1a1aa',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1,
    lineHeight: 12,
  },
  keyLettersActive: {
    color: '#38bdf8',
  },
  dialActionsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 78,
  },
  dialActionsRowExpanded: {
    marginTop: 10,
  },
  dialActionsGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1.5,
    borderColor: '#ef4444',
    borderRadius: 33,
    backgroundColor: '#450a0a',
  },
  dialAuxBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialAuxBtnDisabled: {
    opacity: 0.35,
  },
  mainCallPill: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#38bdf8',
  },
  mainCallPillDisabled: {
    opacity: 0.35,
  },
  callPillText: {
    color: '#000000',
    fontWeight: '700',
    fontSize: 15,
    lineHeight: 20,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  bottomNav: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopColor: '#18181b',
    borderTopWidth: 1,
    backgroundColor: '#000000',
    position: 'relative',
  },
  tabIndicatorPill: {
    position: 'absolute',
    top: 0,
    width: 48,
    height: 3,
    backgroundColor: '#38bdf8',
    borderRadius: 2,
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  navLabel: {
    color: '#71717a',
    fontSize: 11,
    fontWeight: '600',
  },
  navLabelActive: {
    color: '#38bdf8',
    fontWeight: '700',
  },
  navBadge: {
    position: 'absolute',
    top: -4,
    right: -6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  navBadgeText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '700',
  },
  audioRouteCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#18181b',
    borderRadius: 24,
    padding: 22,
    borderColor: '#27272a',
    borderWidth: 1,
    gap: 12,
  },
  audioRouteHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  audioRouteTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
  audioRouteSub: {
    color: '#a1a1aa',
    fontSize: 13,
    marginBottom: 8,
  },
  audioRouteOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#111113',
    borderColor: '#27272a',
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  audioRouteOptionActive: {
    borderColor: '#38bdf8',
    backgroundColor: 'rgba(56, 189, 248, 0.08)',
  },
  audioRouteIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#18181b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioRouteIconWrapActive: {
    backgroundColor: '#38bdf8',
  },
  audioRouteOptionText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  audioRouteOptionTextActive: {
    color: '#38bdf8',
    fontWeight: '700',
  },
  audioRouteOptionSub: {
    color: '#71717a',
    fontSize: 12,
    marginTop: 2,
  },
  audioRouteActiveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#38bdf8',
  },
  contactsContent: {
    flex: 1,
  },
  contactsListContent: {
    paddingHorizontal: 20,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomColor: '#18181b',
    borderBottomWidth: 1,
  },
  favStarBtn: {
    padding: 6,
  },
  contactDetailCol: {
    flex: 1,
    marginLeft: 10,
  },
  contactRowName: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  contactRowExt: {
    color: '#71717a',
    fontSize: 13,
    marginTop: 2,
  },
  contactCallBtn: {
    padding: 10,
    backgroundColor: '#064e3b',
    borderRadius: 20,
  },
  speedDialConfigRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  speedDialBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#27272a',
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: '#3f3f46',
    borderWidth: 1,
  },
  speedDialBadgeVm: {
    borderColor: '#38bdf8',
    backgroundColor: '#0c2838',
  },
  speedDialBadgeText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  speedDialBadgeTextVm: {
    color: '#38bdf8',
  },
  speedDialInput: {
    flex: 1,
    backgroundColor: '#09090b',
    color: '#ffffff',
    borderColor: '#27272a',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    fontSize: 13,
  },
  speedDialClearBtn: {
    padding: 6,
  },
  speedDialClearText: {
    color: '#71717a',
    fontSize: 14,
    fontWeight: '600',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  settingsCardWrapper: {
    width: '100%',
    maxWidth: 400,
    height: '85%',
    maxHeight: '85%',
    backgroundColor: '#18181b',
    borderRadius: 20,
    borderColor: '#27272a',
    borderWidth: 1,
    overflow: 'hidden',
    alignSelf: 'center',
    zIndex: 10,
    elevation: 10,
  },
  settingsScroll: {
    flex: 1,
    width: '100%',
  },
  settingsCard: {
    padding: 22,
    paddingBottom: 40,
  },
  dialogCard: {
    width: '100%',
    backgroundColor: '#18181b',
    borderRadius: 16,
    padding: 20,
    borderColor: '#27272a',
    borderWidth: 1,
  },
  transferDialogCard: {
    width: '100%',
    maxHeight: '75%',
    backgroundColor: '#18181b',
    borderRadius: 16,
    padding: 20,
    borderColor: '#27272a',
    borderWidth: 1,
  },
  transferHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  transferSubTitle: {
    color: '#71717a',
    fontSize: 12,
    marginTop: 2,
  },
  transferDismissBtn: {
    padding: 6,
  },
  transferDismissText: {
    color: '#71717a',
    fontSize: 18,
    fontWeight: '600',
  },
  transferSearchInput: {
    backgroundColor: '#09090b',
    color: '#ffffff',
    borderColor: '#27272a',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    marginBottom: 10,
  },
  transferListScroll: {
    maxHeight: 250,
  },
  transferListContent: {
    paddingVertical: 2,
  },
  transferExtRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#141417',
    marginBottom: 6,
    borderColor: '#27272a',
    borderWidth: 1,
  },
  transferAvatarMini: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#27272a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  transferAvatarText: {
    color: '#38bdf8',
    fontSize: 14,
    fontWeight: '700',
  },
  transferExtInfo: {
    flex: 1,
    marginLeft: 12,
  },
  transferExtName: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  transferExtNumber: {
    color: '#71717a',
    fontSize: 12,
    marginTop: 1,
  },
  transferActionBadge: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  transferActionText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  transferManualBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#38bdf8',
    paddingVertical: 11,
    borderRadius: 8,
    marginTop: 10,
  },
  transferManualText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
  },
  // Transfer mode selector
  transferModeRow: {
    flexDirection: 'row',
    marginBottom: 12,
    borderRadius: 8,
    overflow: 'hidden',
    borderColor: '#27272a',
    borderWidth: 1,
  },
  transferModeBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: '#09090b',
  },
  transferModeBtnActive: {
    backgroundColor: '#0284c7',
  },
  transferModeBtnText: {
    color: '#71717a',
    fontSize: 13,
    fontWeight: '600',
  },
  transferModeBtnTextActive: {
    color: '#ffffff',
  },
  transferActionBadgeWarm: {
    backgroundColor: '#7c3aed',
  },
  // Warm transfer consultation card
  consultCard: {
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: '#18181b',
    borderRadius: 14,
    borderColor: '#7c3aed',
    borderWidth: 1,
    padding: 14,
  },
  consultHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 10,
  },
  consultBadge: {
    backgroundColor: '#7c3aed',
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  consultBadgeText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  consultStatusText: {
    color: '#a1a1aa',
    fontSize: 12,
    flex: 1,
  },
  consultLinesRow: {
    flexDirection: 'row',
    marginBottom: 10,
    gap: 4,
  },
  consultLine: {
    flex: 1,
    backgroundColor: '#09090b',
    borderRadius: 8,
    padding: 10,
    borderColor: '#27272a',
    borderWidth: 1,
  },
  consultLineActive: {
    borderColor: '#10b981',
    backgroundColor: '#052016',
  },
  consultLineSep: {
    width: 4,
  },
  consultLineLabel: {
    color: '#71717a',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  consultLineTarget: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  consultLineIndicator: {
    color: '#10b981',
    fontSize: 9,
    fontWeight: '700',
    marginTop: 3,
  },
  consultErrorText: {
    color: '#ef4444',
    fontSize: 12,
    marginBottom: 8,
  },
  consultGsmWarning: {
    color: '#f59e0b',
    fontSize: 11,
    marginBottom: 8,
    fontStyle: 'italic',
  },
  consultActionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  consultActionBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  consultSwapBtn: {
    backgroundColor: '#0284c7',
  },
  consultCompleteBtn: {
    backgroundColor: '#10b981',
  },
  consultCancelBtn: {
    backgroundColor: '#3f3f46',
  },
  consultBtnDisabled: {
    opacity: 0.35,
  },
  consultActionBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  languageRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
    marginBottom: 6,
  },
  languagePill: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#27272a',
    backgroundColor: '#09090b',
    alignItems: 'center',
  },
  languagePillActive: {
    borderColor: '#38bdf8',
    backgroundColor: '#0c2738',
  },
  languagePillText: {
    color: '#a1a1aa',
    fontSize: 13,
    fontWeight: '700',
  },
  languagePillTextActive: {
    color: '#38bdf8',
  },
  settingsSectionDivider: {
    height: 1,
    backgroundColor: '#27272a',
    marginVertical: 16,
  },
  settingsSectionTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  settingsSectionSub: {
    color: '#71717a',
    fontSize: 12,
    marginBottom: 10,
  },
  dialogTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  dialogInput: {
    backgroundColor: '#09090b',
    color: '#ffffff',
    borderColor: '#27272a',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  dialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 18,
  },
  dialogCancelBtn: {
    padding: 10,
  },
  dialogCancelText: {
    color: '#a1a1aa',
    fontSize: 14,
    fontWeight: '600',
  },
  dialogSubmitBtn: {
    backgroundColor: '#38bdf8',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  dialogSubmitText: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '700',
  },
  settingsTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 16,
  },
  fieldLabel: {
    color: '#a1a1aa',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 10,
    marginBottom: 4,
  },
  settingsInput: {
    backgroundColor: '#09090b',
    color: '#ffffff',
    borderColor: '#27272a',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 14,
    paddingVertical: 4,
  },
  switchTextCol: {
    flex: 1,
    marginRight: 12,
  },
  switchLabel: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  switchSub: {
    color: '#71717a',
    fontSize: 12,
    marginTop: 2,
  },
  codecGrid: {
    flexDirection: 'column',
    gap: 8,
    marginTop: 10,
  },
  codecPill: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#121214',
    borderWidth: 1,
    borderColor: '#27272a',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  codecPillActive: {
    borderColor: '#38bdf8',
    backgroundColor: '#0c2738',
  },
  codecPillLabel: {
    color: '#a1a1aa',
    fontSize: 14,
    fontWeight: '600',
  },
  codecPillLabelActive: {
    color: '#38bdf8',
    fontWeight: '700',
  },
  codecPillSub: {
    color: '#71717a',
    fontSize: 12,
  },
  codecPillSubActive: {
    color: '#93c5fd',
  },
  volSliderContainer: {
    backgroundColor: '#121214',
    borderWidth: 1,
    borderColor: '#27272a',
    borderRadius: 10,
    padding: 14,
    marginTop: 10,
  },
  volSliderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  volSliderTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  volSliderLabel: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  volSliderValueBadge: {
    backgroundColor: '#0c2738',
    borderColor: '#38bdf8',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  volSliderValueText: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '700',
  },
  volSliderSub: {
    color: '#71717a',
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
  volSliderControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
  },
  volStepBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1f1f23',
    borderWidth: 1,
    borderColor: '#3f3f46',
    alignItems: 'center',
    justifyContent: 'center',
  },
  volStepBtnText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 20,
    textAlign: 'center',
  },
  volTrackTouchArea: {
    flex: 1,
    height: 32,
    justifyContent: 'center',
    position: 'relative',
  },
  volTrackBg: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#27272a',
    overflow: 'hidden',
  },
  volTrackFill: {
    height: '100%',
    backgroundColor: '#38bdf8',
    borderRadius: 3,
  },
  volThumb: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#38bdf8',
    borderWidth: 2,
    borderColor: '#ffffff',
    top: 7,
    elevation: 3,
    shadowColor: '#38bdf8',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.5,
    shadowRadius: 2,
  },
  volPresetRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 10,
  },
  volPresetPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#1f1f23',
    borderWidth: 1,
    borderColor: '#27272a',
  },
  volPresetPillActive: {
    borderColor: '#38bdf8',
    backgroundColor: '#0c2738',
  },
  volPresetText: {
    color: '#71717a',
    fontSize: 11,
    fontWeight: '600',
  },
  volPresetTextActive: {
    color: '#38bdf8',
    fontWeight: '700',
  },
  settingsActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 24,
  },
  settingsSaveBtn: {
    backgroundColor: '#10b981',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  settingsSaveText: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '700',
  },
  // In-Call
  inCallContainer: {
    flex: 1,
    backgroundColor: '#09090b',
    justifyContent: 'space-between',
    paddingVertical: 28,
    paddingHorizontal: 20,
  },
  inCallTop: {
    alignItems: 'center',
    marginTop: 28,
    paddingTop: 4,
  },
  inCallBadgePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(24, 24, 27, 0.9)',
    borderColor: '#27272a',
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 20,
    marginBottom: 10,
  },
  inCallBadgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10b981',
  },
  inCallBadgeDotCalling: {
    backgroundColor: '#38bdf8',
  },
  inCallBadgeDotHeld: {
    backgroundColor: '#f59e0b',
  },
  inCallBadgeText: {
    color: '#a1a1aa',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },
  inCallTimer: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 20,
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  inCallTimerPreConnect: {
    fontSize: 22,
    fontWeight: '700',
    color: '#38bdf8',
    letterSpacing: 0.5,
  },
  inCallName: {
    color: '#ffffff',
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 8,
    paddingHorizontal: 20,
  },
  inCallNumberBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#18181b',
    borderColor: '#27272a',
    borderWidth: 1,
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 14,
  },
  inCallNumber: {
    color: '#a1a1aa',
    fontSize: 14,
    fontWeight: '600',
  },
  inCallControlsCard: {
    backgroundColor: 'rgba(24, 24, 27, 0.85)',
    borderColor: '#27272a',
    borderWidth: 1,
    borderRadius: 32,
    paddingVertical: 20,
    paddingHorizontal: 12,
    gap: 18,
    marginHorizontal: 8,
    marginTop: 12,
  },
  inCallRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  inCallBtnCol: {
    alignItems: 'center',
    gap: 6,
  },
  inCallBtn: {
    backgroundColor: '#18181b',
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: '#27272a',
    borderWidth: 1,
  },
  inCallBtnMutedActive: {
    borderColor: '#ef4444',
    backgroundColor: '#7f1d1d',
  },
  inCallBtnSpeakerActive: {
    borderColor: '#38bdf8',
    backgroundColor: '#0369a1',
  },
  inCallBtnHoldActive: {
    borderColor: '#f59e0b',
    backgroundColor: '#78350f',
  },
  inCallBtnActive: {
    borderColor: '#38bdf8',
    backgroundColor: '#0369a1',
  },
  inCallBtnLabel: {
    color: '#a1a1aa',
    fontSize: 12,
    fontWeight: '600',
  },
  contactsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  contactSearchInputFlex: {
    flex: 1,
    backgroundColor: '#18181b',
    color: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    fontSize: 14,
    borderColor: '#27272a',
    borderWidth: 1,
  },
  syncContactsHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#082f49',
    borderColor: '#0284c7',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  syncContactsHeaderBtnText: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '700',
  },
  hangupRow: {
    alignItems: 'center',
    marginBottom: 16,
  },
  hangupBtn: {
    width: 72,
    height: 72,
    backgroundColor: '#ef4444',
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hangupBtnText: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '700',
  },
  dtmfGridContainer: {
    backgroundColor: '#18181b',
    borderRadius: 16,
    padding: 16,
  },
  dtmfGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
  },
  dtmfKey: {
    width: '30%',
    aspectRatio: 1.4,
    backgroundColor: '#09090b',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dtmfKeyText: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '700',
  },
  dtmfCloseBtn: {
    alignItems: 'center',
    marginTop: 12,
    paddingVertical: 6,
  },
  dtmfCloseText: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '700',
  },
  volumeDialogCard: {
    width: '100%',
    maxHeight: '85%',
    backgroundColor: '#18181b',
    borderRadius: 16,
    padding: 20,
    borderColor: '#27272a',
    borderWidth: 1,
  },
  inCallAudioRouteRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
    marginBottom: 10,
  },
  inCallAudioRouteBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#27272a',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#3f3f46',
  },
  inCallAudioRouteBtnActive: {
    backgroundColor: '#0369a1',
    borderColor: '#38bdf8',
  },
  inCallAudioRouteText: {
    color: '#a1a1aa',
    fontSize: 13,
    fontWeight: '600',
  },
  inCallAudioRouteTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  volumeDoneBtn: {
    backgroundColor: '#38bdf8',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  volumeDoneBtnText: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '700',
  },
  unifiedAudioContainer: {
    width: '100%',
  },
});
