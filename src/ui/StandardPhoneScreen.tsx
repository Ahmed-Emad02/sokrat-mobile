import React, { useState, useEffect, useRef } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  GestureResponderEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme';
import { CallRecord, Contact, SavedAccount, SpeedDialMap, StorageService, CodecPreference } from '../storage/store';
import { SipState, ActiveCall } from '../sip/JsSipService';
import {
  PhoneIcon,
  ContactsIcon,
  StarIcon,
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
} from './Icons';
import { fetchDeviceContacts } from '../calls/nativeCallNotification';

function VolumeSlider({
  label,
  value,
  onChange,
  icon,
  description,
}: {
  label: string;
  value: number;
  onChange: (val: number) => void;
  icon: React.ReactNode;
  description: string;
}) {
  const [trackWidth, setTrackWidth] = useState(0);

  const handleTouch = (evt: GestureResponderEvent) => {
    if (trackWidth <= 0) return;
    const x = evt.nativeEvent.locationX;
    const pct = Math.round(Math.max(0, Math.min(100, (x / trackWidth) * 100)));
    onChange(pct);
  };

  const stepDown = () => {
    onChange(Math.max(0, value - 5));
  };

  const stepUp = () => {
    onChange(Math.min(100, value + 5));
  };

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
          onPress={stepDown}
          activeOpacity={0.6}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.volStepBtnText}>−</Text>
        </TouchableOpacity>

        <View
          style={styles.volTrackTouchArea}
          onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={handleTouch}
          onResponderMove={handleTouch}
        >
          <View style={styles.volTrackBg}>
            <View style={[styles.volTrackFill, { width: `${value}%` }]} />
          </View>
          <View
            style={[
              styles.volThumb,
              { left: `${Math.max(0, Math.min(94, value - 3))}%` },
            ]}
          />
        </View>

        <TouchableOpacity
          style={styles.volStepBtn}
          onPress={stepUp}
          activeOpacity={0.6}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.volStepBtnText}>+</Text>
        </TouchableOpacity>
      </View>

      {/* Preset Pills */}
      <View style={styles.volPresetRow}>
        {[25, 50, 75, 100].map((p) => {
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
  onTransfer: (target: string) => void;
  onSaveAccount: (account: SavedAccount) => void;
  onLogout: () => void;
  onClearHistory: () => void;
  onSaveContact: (contact: Contact) => void;
  onSaveContactsBatch?: (contacts: Contact[]) => void;
  onDeleteContact: (id: string) => void;
  onDeleteCallRecord?: (id: string) => void;
  onToggleFavorite: (id: string) => void;
};

type BottomTab = 'phone' | 'contacts' | 'favourites';

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

export function StandardPhoneScreen({
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
  onSendDtmf,
  onTransfer,
  onSaveAccount,
  onSaveContactsBatch,
  onLogout,
  onClearHistory,
  onSaveContact,
  onDeleteContact,
  onDeleteCallRecord,
  onToggleFavorite,
}: Props) {
  // Navigation & UI States
  const [activeTab, setActiveTab] = useState<BottomTab>('phone');
  const [digits, setDigits] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [contactSearch, setContactSearch] = useState('');

  const [selectedCallRecord, setSelectedCallRecord] = useState<CallRecord | null>(null);
  const [showCallDetailsModal, setShowCallDetailsModal] = useState(false);

  // Settings State Form
  const [editExt, setEditExt] = useState(account?.extension || '150');
  const [editPass, setEditPass] = useState(account?.password || 'sss333');
  const [editHost, setEditHost] = useState(account?.serverHost || '192.168.100.128');
  const [editTls, setEditTls] = useState(account?.useTls ?? false);
  const [editDnd, setEditDnd] = useState(account?.dnd || false);
  const [editAuto, setEditAuto] = useState(account?.autoAnswer || false);
  const [editCodec, setEditCodec] = useState<CodecPreference>(account?.preferredCodec || 'opus');
  const [editMicVol, setEditMicVol] = useState(account?.micVolume ?? 85);
  const [editSpeakerVol, setEditSpeakerVol] = useState(account?.speakerVolume ?? 85);
  // Speed Dial Configuration (Keys 1 to 9)
  const [speedDial, setSpeedDial] = useState<SpeedDialMap>({ '1': '*97' });
  const [editSpeedDial, setEditSpeedDial] = useState<SpeedDialMap>({ '1': '*97' });

  // Dialpad Collapse / Expand Toggle
  const [isDialpadVisible, setIsDialpadVisible] = useState(true);

  // Recents History Filter (All vs Missed)
  const [historyFilter, setHistoryFilter] = useState<'all' | 'missed'>('all');

  const displayedCalls = callsHistory.filter((item) => {
    if (historyFilter === 'missed') {
      return item.direction === 'missed';
    }
    return true;
  });

  // Animated Dialpad Input Cursor Caret
  const cursorOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(cursorOpacity, {
          toValue: 0,
          duration: 530,
          useNativeDriver: true,
        }),
        Animated.timing(cursorOpacity, {
          toValue: 1,
          duration: 530,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [cursorOpacity]);
  // Live PBX Extensions (for 1-click transfer)
  const [serverExtensions, setServerExtensions] = useState<Array<{ extension: string; name: string }>>([
    { extension: '101', name: 'ahmed' },
    { extension: '102', name: 'mazen' },
    { extension: '103', name: '103' },
    { extension: '111', name: 'cisco' },
    { extension: '150', name: '150' },
    { extension: '151', name: '151' },
    { extension: '170', name: '170' },
    { extension: '200', name: '200' },
  ]);

  // New Contact Form
  const [newContactName, setNewContactName] = useState('');
  const [newContactNumber, setNewContactNumber] = useState('');

  // In-Call DTMF & Transfer Overlay
  const [showInCallDtmf, setShowInCallDtmf] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferTarget, setTransferTarget] = useState('');
  const [callTimerSecs, setCallTimerSecs] = useState(0);

  useEffect(() => {
    let timer: number | undefined;
    if (activeCall?.status === 'active') {
      timer = setInterval(() => setCallTimerSecs((s) => s + 1), 1000) as unknown as number;
    } else {
      setCallTimerSecs(0);
    }
    return () => {
      clearInterval(timer);
    };
  }, [activeCall?.status]);

  useEffect(() => {
    StorageService.getSpeedDial().then((sd) => {
      const initial = { '1': '*97', ...sd };
      setSpeedDial(initial);
      setEditSpeedDial(initial);
    });
  }, []);

  const fetchExtensions = async () => {
    try {
      const host = account?.serverHost || '192.168.100.128';
      let res = await fetch(`http://${host}:8095/api/push/extensions`).catch(() => null);
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
  };

  useEffect(() => {
    if (account) {
      setEditExt(account.extension);
      setEditPass(account.password);
      setEditHost(account.serverHost);
      setEditTls(account.useTls);
      setEditDnd(account.dnd);
      setEditAuto(account.autoAnswer);
      setEditCodec(account.preferredCodec || 'opus');
      setEditMicVol(account.micVolume ?? 85);
      setEditSpeakerVol(account.speakerVolume ?? 85);
    }
  }, [account]);

  useEffect(() => {
    void fetchExtensions();
  }, [account?.serverHost]);

  const handleKeyLongPress = (digit: string) => {
    const target = speedDial[digit]?.trim();
    console.log(`[speed-dial] long-press digit=${digit} target=${target || 'none'}`);
    if (target) {
      setDigits('');
      onCall(target);
    } else if (digit === '0') {
      setDigits((prev) => prev + '+');
    }
  };

  const filteredTransferExtensions = serverExtensions
    .filter((e) => e.extension !== account?.extension)
    .filter((e) => {
      const q = transferTarget.trim().toLowerCase();
      if (!q) return true;
      return (
        e.extension.toLowerCase().includes(q) ||
        (e.name || '').toLowerCase().includes(q)
      );
    });
  const formatCallTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const formatExactDate = (ts: number): string => {
    const d = new Date(ts);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getMonth()];
    const day = d.getDate();
    let hours = d.getHours();
    const minutes = d.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const minStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
    return `${month} ${day}, ${d.getFullYear()} at ${hours}:${minStr} ${ampm}`;
  };

  const handleOpenCallDetails = (record: CallRecord) => {
    setSelectedCallRecord(record);
    setShowCallDetailsModal(true);
  };

  const formatTimeAgo = (ts: number) => {
    const elapsed = Math.floor((Date.now() - ts) / 1000);
    if (elapsed < 60) return 'Just now';
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)} min ago`;
    if (elapsed < 86400) return `${Math.floor(elapsed / 3600)} hr ago`;
    return 'Yesterday';
  };
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

  const handleDigitPress = (d: string) => {
    cursorOpacity.setValue(1);
    setDigits((prev) => prev + d);
  };

  const handleBackspace = () => {
    cursorOpacity.setValue(1);
    setDigits((prev) => prev.slice(0, -1));
  };

  const hasDigits = digits.trim().length > 0;
  const lastCallNumber =
    callsHistory.length > 0 ? (callsHistory[0]?.number || '').trim() : '';
  const hasRedial = lastCallNumber.length > 0;

  const handleAuxAction = () => {
    if (hasDigits) {
      setNewContactName('');
      setNewContactNumber(digits.trim());
      setShowAddContactModal(true);
    } else if (hasRedial) {
      setDigits(lastCallNumber);
    }
  };

  const handleDial = () => {
    if (!digits.trim()) return;
    onCall(digits.trim());
    setDigits('');
  };

  const handleSaveSettings = () => {
    if (!editExt.trim() || !editPass.trim() || !editHost.trim()) return;
    onSaveAccount({
      extension: editExt.trim(),
      password: editPass.trim(),
      serverHost: editHost.trim(),
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
    setShowSettingsModal(false);
  };

  const handleCreateContact = () => {
    if (!newContactName.trim() || !newContactNumber.trim()) return;
    onSaveContact({
      id: 'c_' + Date.now(),
      name: newContactName.trim(),
      extension: newContactNumber.trim(),
      favorite: false,
    });
    setNewContactName('');
    setNewContactNumber('');
    setShowAddContactModal(false);
  };

  const handleSignOutClick = () => {
    setShowMenu(false);
    onLogout();
    setShowSettingsModal(false);
  };

  // --- Active In-Call View ---
  if (activeCall) {
    return (
      <SafeAreaView style={styles.inCallContainer}>
        <View style={styles.inCallTop}>
          <Text style={styles.inCallLabel}>
            {activeCall.isHeld ? 'CALL ON HOLD' : activeCall.status === 'active' ? 'CONNECTED' : 'CALLING…'}
          </Text>
          <Text style={styles.inCallTimer}>{formatCallTime(callTimerSecs)}</Text>
          <View style={styles.inCallAvatar}>
            <Text style={styles.inCallAvatarText}>
              {activeCall.targetName.charAt(0) || activeCall.target.charAt(0) || '?'}
            </Text>
          </View>
          <Text style={styles.inCallName}>{activeCall.targetName}</Text>
          <Text style={styles.inCallNumber}>{activeCall.target}</Text>
        </View>

        {showInCallDtmf ? (
          <View style={styles.dtmfGridContainer}>
            <View style={styles.dtmfGrid}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => (
                <TouchableOpacity key={k} style={styles.dtmfKey} onPress={() => onSendDtmf(k)}>
                  <Text style={styles.dtmfKeyText}>{k}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={styles.dtmfCloseBtn} onPress={() => setShowInCallDtmf(false)}>
              <Text style={styles.dtmfCloseText}>Hide Keypad</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.inCallControls}>
            <View style={styles.inCallRow}>
              <TouchableOpacity
                style={[styles.inCallBtn, activeCall.isMuted && styles.inCallBtnActive]}
                onPress={onToggleMute}
              >
                {activeCall.isMuted ? <MicOffIcon size={26} color="#38bdf8" /> : <MicIcon size={26} color="#ffffff" />}
                <Text style={[styles.inCallBtnLabel, activeCall.isMuted && styles.inCallBtnLabelActive]}>
                  {activeCall.isMuted ? 'Unmute' : 'Mute'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.inCallBtn} onPress={() => setShowInCallDtmf(true)}>
                <KeypadIcon size={26} color="#ffffff" />
                <Text style={styles.inCallBtnLabel}>Keypad</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.inCallBtn, isSpeakerOn && styles.inCallBtnActive]}
                onPress={onToggleSpeaker}
              >
                <SpeakerIcon size={26} color={isSpeakerOn ? '#38bdf8' : '#ffffff'} />
                <Text style={[styles.inCallBtnLabel, isSpeakerOn && styles.inCallBtnLabelActive]}>
                  {isSpeakerOn ? 'Speaker On' : 'Speaker'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.inCallRow}>
              <TouchableOpacity
                style={[styles.inCallBtn, activeCall.isHeld && styles.inCallBtnActive]}
                onPress={onToggleHold}
              >
                {activeCall.isHeld ? <PlayIcon size={26} color="#38bdf8" /> : <PauseIcon size={26} color="#ffffff" />}
                <Text style={[styles.inCallBtnLabel, activeCall.isHeld && styles.inCallBtnLabelActive]}>
                  {activeCall.isHeld ? 'Resume' : 'Hold'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.inCallBtn} onPress={() => setShowTransferModal(true)}>
                <TransferIcon size={26} color="#ffffff" />
                <Text style={styles.inCallBtnLabel}>Transfer</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.hangupRow}>
          <TouchableOpacity style={styles.hangupBtn} onPress={onHangup}>
            <Text style={styles.hangupBtnText}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Transfer Dialog with 1-Click Server Extension List */}
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
                        Tap an extension below to transfer with 1 click:
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => setShowTransferModal(false)}
                      style={styles.transferDismissBtn}
                    >
                      <Text style={styles.transferDismissText}>✕</Text>
                    </TouchableOpacity>
                  </View>

                  <TextInput
                    style={styles.transferSearchInput}
                    value={transferTarget}
                    onChangeText={setTransferTarget}
                    placeholder="Filter or enter custom extension…"
                    placeholderTextColor="#666"
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
                          onTransfer(item.extension);
                          setShowTransferModal(false);
                          setTransferTarget('');
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
                          <Text style={styles.transferExtNumber}>Ext {item.extension}</Text>
                        </View>
                        <View style={styles.transferActionBadge}>
                          <Text style={styles.transferActionText}>Transfer</Text>
                        </View>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

                  {/* Manual Transfer Button for custom numbers */}
                  {transferTarget.trim().length > 0 && (
                    <TouchableOpacity
                      style={styles.transferManualBtn}
                      onPress={() => {
                        onTransfer(transferTarget.trim());
                        setShowTransferModal(false);
                        setTransferTarget('');
                      }}
                      activeOpacity={0.8}
                    >
                      <TransferIcon size={16} color="#000000" />
                      <Text style={styles.transferManualText}>
                        Transfer to "{transferTarget.trim()}"
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>
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
            {activeTab === 'phone' ? 'Phone' : activeTab === 'contacts' ? 'Contacts' : 'Favourites'}
          </Text>
          <TouchableOpacity
            style={[
              styles.statusBadge,
              state === 'registered' ? styles.statusBadgeOk : state === 'connecting' ? styles.statusBadgeWait : styles.statusBadgeErr,
            ]}
            onPress={() => setShowSettingsModal(true)}
          >
            <View
              style={[
                styles.statusDot,
                { backgroundColor: state === 'registered' ? '#10b981' : state === 'connecting' ? '#f59e0b' : '#ef4444' },
              ]}
            />
            <Text
              style={[
                styles.statusBadgeText,
                { color: state === 'registered' ? '#10b981' : state === 'connecting' ? '#f59e0b' : '#ef4444' },
              ]}
            >
              {state === 'registered'
                ? `Ext ${account?.extension || '150'} · Connected ✓`
                : state === 'connecting'
                ? `Ext ${account?.extension || '150'} · Connecting…`
                : `Ext ${account?.extension || '150'} · Offline`}
            </Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={styles.menuBtn} onPress={() => setShowMenu(!showMenu)}>
          <MenuDotsIcon size={24} color="#ffffff" />
        </TouchableOpacity>
      </View>

      {/* 3-Dots Dropdown Menu & Click-Outside Dismiss Backdrop */}
      {showMenu && (
        <>
          <TouchableWithoutFeedback onPress={() => setShowMenu(false)}>
            <View style={styles.menuBackdrop} />
          </TouchableWithoutFeedback>
          <View style={styles.dropdownMenu}>
            <TouchableOpacity
              style={styles.dropdownItem}
              onPress={() => {
                setShowMenu(false);
                setShowSettingsModal(true);
              }}
            >
              <View style={styles.menuItemRow}>
                <SettingsIcon size={18} color="#38bdf8" />
                <Text style={styles.dropdownText}>Settings & PBX Host</Text>
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
                  <TrashIcon size={18} color="#a1a1aa" />
                  <Text style={styles.dropdownText}>Clear History</Text>
                </View>
              </TouchableOpacity>
            )}
            {activeTab === 'contacts' && (
              <>
                <TouchableOpacity
                  style={styles.dropdownItem}
                  onPress={() => {
                    setShowMenu(false);
                    setShowAddContactModal(true);
                  }}
                >
                  <View style={styles.menuItemRow}>
                    <PlusIcon size={18} color="#10b981" />
                    <Text style={styles.dropdownText}>Add Contact</Text>
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
                    <ContactsIcon size={18} color="#38bdf8" />
                    <Text style={styles.dropdownText}>Sync Phone Contacts</Text>
                  </View>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity
              style={[styles.dropdownItem, { borderTopWidth: 1, borderTopColor: '#27272a' }]}
              onPress={handleSignOutClick}
            >
              <View style={styles.menuItemRow}>
                <LogoutIcon size={18} color="#ef4444" />
                <Text style={[styles.dropdownText, { color: '#ef4444' }]}>Sign Out</Text>
              </View>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Main Tab Views */}
      {activeTab === 'phone' && (
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
                  All
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
                  Missed
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Recents History List */}
          <View style={styles.recentsSection}>
            {displayedCalls.length === 0 ? (
              <View style={styles.emptyHistory}>
                <Text style={styles.emptyHistoryText}>
                  {historyFilter === 'missed' ? 'No missed calls' : 'No recent calls'}
                </Text>
              </View>
            ) : (
              <FlatList
                data={displayedCalls.slice(0, 40)}
                keyExtractor={(item) => item.id}
                showsVerticalScrollIndicator={false}
                renderItem={({ item }) => (
                  <View style={styles.recentItem}>
                    <TouchableOpacity
                      style={styles.recentMainCol}
                      onPress={() => onCall(item.number)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.avatarMini}>
                        <UserIcon size={20} color="#a1a1aa" />
                      </View>

                      <View style={styles.recentInfo}>
                        <Text
                          style={[
                            styles.recentName,
                            item.direction === 'missed' && styles.recentNameMissed,
                          ]}
                          numberOfLines={1}
                        >
                          {item.name || item.number}
                        </Text>
                        <Text style={styles.recentSub}>
                          {item.direction === 'missed' ? 'Missed call' : 'VoIP'}
                        </Text>
                      </View>

                      <Text style={styles.recentTime}>{formatTimeAgo(item.timestamp)}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.infoCircleBtn}
                      onPress={() => handleOpenCallDetails(item)}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      activeOpacity={0.6}
                      accessibilityRole="button"
                      accessibilityLabel={`Call details for ${item.name || item.number}`}
                    >
                      <InfoIcon size={20} color="#38bdf8" />
                    </TouchableOpacity>
                  </View>
                )}
              />
            )}
          </View>

          {/* Lower Half: Dialpad Display & 3x4 Keypad */}
          <View
            style={[
              styles.dialpadSection,
              !isDialpadVisible && styles.dialpadSectionCollapsed,
            ]}
          >
            {isDialpadVisible && (
              <>
                {/* Number Display with inline Backspace & Blinking Caret Indicator */}
                <View style={styles.numberRow}>
                  <View style={styles.digitsWrapper}>
                    <Text style={styles.dialedDigits} numberOfLines={1}>
                      {digits}
                    </Text>
                    <Animated.View
                      style={[
                        styles.cursorCaret,
                        { opacity: cursorOpacity },
                      ]}
                    />
                  </View>
                  {hasDigits ? (
                    <TouchableOpacity
                      style={styles.topBackspaceBtn}
                      onPress={handleBackspace}
                      onLongPress={() => {
                        cursorOpacity.setValue(1);
                        setDigits('');
                      }}
                      hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
                      activeOpacity={0.6}
                      accessibilityRole="button"
                      accessibilityLabel="Delete digit (hold to clear)"
                    >
                      <BackspaceIcon size={22} color="#a1a1aa" />
                    </TouchableOpacity>
                  ) : null}
                </View>

                {/* 3x4 Dialpad Grid */}
                <View style={styles.keypadGrid}>
                  {DIALPAD_KEYS.map((k) => {
                    const speedTarget = speedDial[k.digit]?.trim();
                    const isConfigured = Boolean(speedTarget);
                    return (
                      <TouchableOpacity
                        key={k.digit}
                        style={styles.keyBtn}
                        onPress={() => handleDigitPress(k.digit)}
                        onLongPress={() => handleKeyLongPress(k.digit)}
                        delayLongPress={450}
                        activeOpacity={0.6}
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
                              color={isConfigured ? '#38bdf8' : '#a1a1aa'}
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
                    );
                  })}
                </View>
              </>
            )}

            {/* Bottom Action Bar */}
            <View
              style={[
                styles.dialActionsRow,
                isDialpadVisible && styles.dialActionsRowExpanded,
              ]}
            >
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
                  <UserPlusIcon size={22} color="#38bdf8" />
                ) : (
                  <RedialIcon
                    size={22}
                    color={hasRedial ? '#a1a1aa' : '#52525b'}
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
                accessibilityLabel={
                  account ? `Call from extension ${account.extension}` : 'Place call'
                }
              >
                <PhoneIcon size={18} color="#000000" />
                <Text style={styles.callPillText}>
                  {account ? `Ext ${account.extension}` : 'Call'}
                </Text>
              </TouchableOpacity>

              {/* Pull Down / Pull Up Dialpad Toggle Button */}
              <TouchableOpacity
                style={styles.dialAuxBtn}
                onPress={() => setIsDialpadVisible(!isDialpadVisible)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel={isDialpadVisible ? 'Hide dialpad' : 'Show dialpad'}
              >
                {isDialpadVisible ? (
                  <ChevronDownIcon size={24} color="#a1a1aa" />
                ) : (
                  <KeypadIcon size={22} color="#38bdf8" />
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {activeTab === 'contacts' && (
        <View style={styles.contactsContent}>
          <View style={styles.contactsHeaderRow}>
            <TextInput
              style={styles.contactSearchInputFlex}
              value={contactSearch}
              onChangeText={setContactSearch}
              placeholder="Search contacts…"
              placeholderTextColor="#666"
            />
            <TouchableOpacity
              style={styles.syncContactsHeaderBtn}
              onPress={handleSyncContacts}
              disabled={isSyncingContacts}
            >
              <ContactsIcon size={18} color="#38bdf8" />
              <Text style={styles.syncContactsHeaderBtnText}>
                {isSyncingContacts ? 'Syncing…' : 'Import'}
              </Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={contacts.filter((c) =>
              c.name.toLowerCase().includes(contactSearch.toLowerCase()) ||
              c.extension.includes(contactSearch)
            )}
            keyExtractor={(c) => c.id}
            renderItem={({ item }) => (
              <View style={styles.contactRow}>
                <TouchableOpacity style={styles.favStarBtn} onPress={() => onToggleFavorite(item.id)}>
                  <StarIcon size={22} color={item.favorite ? '#f59e0b' : '#71717a'} fill={item.favorite ? '#f59e0b' : 'none'} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.contactDetailCol} onPress={() => onCall(item.extension)}>
                  <Text style={styles.contactRowName}>{item.name}</Text>
                  <Text style={styles.contactRowExt}>Ext {item.extension}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.contactCallBtn} onPress={() => onCall(item.extension)}>
                  <PhoneIcon size={16} color="#10b981" />
                </TouchableOpacity>
              </View>
            )}
          />
        </View>
      )}

      {activeTab === 'favourites' && (
        <View style={styles.contactsContent}>
          <FlatList
            data={contacts.filter((c) => c.favorite)}
            keyExtractor={(c) => c.id}
            ListEmptyComponent={
              <View style={styles.emptyHistory}>
                <Text style={styles.emptyHistoryText}>No favourites yet. Star contacts to see them here.</Text>
              </View>
            }
            renderItem={({ item }) => (
              <View style={styles.contactRow}>
                <TouchableOpacity style={styles.favStarBtn} onPress={() => onToggleFavorite(item.id)}>
                  <StarIcon size={22} color="#f59e0b" fill="#f59e0b" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.contactDetailCol} onPress={() => onCall(item.extension)}>
                  <Text style={styles.contactRowName}>{item.name}</Text>
                  <Text style={styles.contactRowExt}>Ext {item.extension}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.contactCallBtn} onPress={() => onCall(item.extension)}>
                  <PhoneIcon size={16} color="#10b981" />
                </TouchableOpacity>
              </View>
            )}
          />

        </View>
      )}

      {/* Bottom Navigation Bar */}
      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('phone')}
        >
          <PhoneIcon size={20} color={activeTab === 'phone' ? '#38bdf8' : '#71717a'} />
          <Text style={[styles.navLabel, activeTab === 'phone' && styles.navLabelActive]}>Phone</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('contacts')}
        >
          <ContactsIcon size={20} color={activeTab === 'contacts' ? '#38bdf8' : '#71717a'} />
          <Text style={[styles.navLabel, activeTab === 'contacts' && styles.navLabelActive]}>Contacts</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navItem}
          onPress={() => setActiveTab('favourites')}
        >
          <StarIcon size={20} color={activeTab === 'favourites' ? '#38bdf8' : '#71717a'} fill={activeTab === 'favourites' ? '#38bdf8' : 'none'} />
          <Text style={[styles.navLabel, activeTab === 'favourites' && styles.navLabelActive]}>Favourites</Text>
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
                nestedScrollEnabled={true}
              >
                  <Text style={styles.settingsTitle}>PBX Server & Credentials</Text>

                  <Text style={styles.fieldLabel}>SIP EXTENSION</Text>
                  <TextInput
                    style={styles.settingsInput}
                    value={editExt}
                    onChangeText={setEditExt}
                    placeholder="e.g. 150"
                    placeholderTextColor="#666"
                    keyboardType="number-pad"
                  />

                  <Text style={styles.fieldLabel}>SIP PASSWORD</Text>
                  <TextInput
                    style={styles.settingsInput}
                    value={editPass}
                    onChangeText={setEditPass}
                    placeholder="SIP Secret (e.g. sss333)"
                    placeholderTextColor="#666"
                    secureTextEntry
                  />

                  <Text style={styles.fieldLabel}>PBX SERVER HOST / IP</Text>
                  <TextInput
                    style={styles.settingsInput}
                    value={editHost}
                    onChangeText={setEditHost}
                    placeholder="192.168.100.128"
                    placeholderTextColor="#666"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />

                  <TouchableOpacity
                    style={styles.switchRow}
                    activeOpacity={0.7}
                    onPress={() => setEditTls(!editTls)}
                  >
                    <View style={styles.switchTextCol}>
                      <Text style={styles.switchLabel}>TLS / WSS Protocol</Text>
                      <Text style={styles.switchSub}>
                        {editTls ? 'Port 8089 (WSS)' : 'Port 8088 (Plain WS on LAN)'}
                      </Text>
                    </View>
                    <View pointerEvents="none">
                      <Switch
                        value={editTls}
                        thumbColor={editTls ? '#38bdf8' : '#71717a'}
                        trackColor={{ false: '#3f3f46', true: '#0369a1' }}
                      />
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.switchRow}
                    activeOpacity={0.7}
                    onPress={() => setEditDnd(!editDnd)}
                  >
                    <View style={styles.switchTextCol}>
                      <Text style={styles.switchLabel}>Do Not Disturb (DND)</Text>
                      <Text style={styles.switchSub}>Auto-reject incoming calls</Text>
                    </View>
                    <View pointerEvents="none">
                      <Switch
                        value={editDnd}
                        thumbColor={editDnd ? '#ef4444' : '#71717a'}
                        trackColor={{ false: '#3f3f46', true: '#991b1b' }}
                      />
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.switchRow}
                    activeOpacity={0.7}
                    onPress={() => setEditAuto(!editAuto)}
                  >
                    <View style={styles.switchTextCol}>
                      <Text style={styles.switchLabel}>Auto-Answer</Text>
                      <Text style={styles.switchSub}>Auto-accept incoming calls</Text>
                    </View>
                    <View pointerEvents="none">
                      <Switch
                        value={editAuto}
                        thumbColor={editAuto ? '#10b981' : '#71717a'}
                        trackColor={{ false: '#3f3f46', true: '#065f46' }}
                      />
                    </View>
                  </TouchableOpacity>


                  <View style={styles.settingsSectionDivider} />
                  <Text style={styles.settingsSectionTitle}>Preferred Audio Codec</Text>
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

                  <View style={styles.settingsSectionDivider} />
                  <Text style={styles.settingsSectionTitle}>Audio & Volume Levels</Text>
                  <Text style={styles.settingsSectionSub}>
                    Fine-tune microphone capture sensitivity and in-call speaker loudness:
                  </Text>

                  <VolumeSlider
                    label="Microphone Volume"
                    value={editMicVol}
                    onChange={setEditMicVol}
                    icon={<MicIcon size={18} color="#38bdf8" />}
                    description="Controls microphone capture gain and input sensitivity during calls."
                  />

                  <VolumeSlider
                    label="Speaker Volume"
                    value={editSpeakerVol}
                    onChange={setEditSpeakerVol}
                    icon={<SpeakerIcon size={18} color="#38bdf8" />}
                    description="Controls in-call earpiece and loudspeaker audio output level."
                  />
                  <View style={styles.settingsSectionDivider} />
                  <Text style={styles.settingsSectionTitle}>Speed Dial (Keys 1 – 9)</Text>
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
                          placeholderTextColor="#666"
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
                            <Text style={styles.speedDialClearText}>✕</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    );
                  })}
                  <View style={styles.settingsActions}>
                    {account ? (
                      <TouchableOpacity onPress={() => setShowSettingsModal(false)} style={styles.dialogCancelBtn}>
                        <Text style={styles.dialogCancelText}>Cancel</Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity onPress={handleSaveSettings} style={styles.settingsSaveBtn}>
                      <Text style={styles.settingsSaveText}>Save & Connect</Text>
                    </TouchableOpacity>
                  </View>
                </ScrollView>
              </View>
          </View>
      </Modal>

      {/* Add Contact Modal (Click-Outside to Dismiss) */}
      <Modal visible={showAddContactModal} transparent animationType="fade" onRequestClose={() => setShowAddContactModal(false)}>
        <View style={styles.modalBackdrop}>
          <TouchableWithoutFeedback onPress={() => setShowAddContactModal(false)}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
          <View style={styles.dialogCard}>
                <Text style={styles.dialogTitle}>Add New Contact</Text>

                <Text style={styles.fieldLabel}>NAME</Text>
                <TextInput
                  style={styles.dialogInput}
                  value={newContactName}
                  onChangeText={setNewContactName}
                  placeholder="e.g. Support"
                  placeholderTextColor="#666"
                />

                <Text style={styles.fieldLabel}>EXTENSION / PHONE</Text>
                <TextInput
                  style={styles.dialogInput}
                  value={newContactNumber}
                  onChangeText={setNewContactNumber}
                  placeholder="e.g. 101"
                  placeholderTextColor="#666"
                  keyboardType="phone-pad"
                />

                <View style={styles.dialogActions}>
                  <TouchableOpacity onPress={() => setShowAddContactModal(false)} style={styles.dialogCancelBtn}>
                    <Text style={styles.dialogCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={handleCreateContact} style={styles.dialogSubmitBtn}>
                    <Text style={styles.dialogSubmitText}>Save</Text>
                  </TouchableOpacity>
                </View>
              </View>
          </View>
      </Modal>
      {/* Call Details & Quick Actions Sheet */}
      <Modal
        visible={showCallDetailsModal && Boolean(selectedCallRecord)}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCallDetailsModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <TouchableWithoutFeedback onPress={() => setShowCallDetailsModal(false)}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
          <View style={styles.callDetailsCard}>
                <View style={styles.callDetailsHeaderRow}>
                  <Text style={styles.dialogTitle}>Call Details</Text>
                  <TouchableOpacity
                    onPress={() => setShowCallDetailsModal(false)}
                    style={styles.transferDismissBtn}
                  >
                    <Text style={styles.transferDismissText}>✕</Text>
                  </TouchableOpacity>
                </View>

                {selectedCallRecord && (
                  <>
                    {/* Caller Avatar & Name */}
                    <View style={styles.callDetailsIdentity}>
                      <View style={styles.callDetailsAvatar}>
                        <UserIcon size={34} color="#38bdf8" />
                      </View>
                      <Text style={styles.callDetailsName} numberOfLines={1}>
                        {selectedCallRecord.name || selectedCallRecord.number}
                      </Text>
                      <Text style={styles.callDetailsNumber}>
                        {selectedCallRecord.name && selectedCallRecord.name !== selectedCallRecord.number
                          ? `Ext ${selectedCallRecord.number} · VoIP`
                          : 'VoIP Extension'}
                      </Text>
                    </View>

                    {/* Quick Action Buttons Row */}
                    <View style={styles.callDetailsActionsRow}>
                      <TouchableOpacity
                        style={styles.callDetailsActionPill}
                        onPress={() => {
                          const num = selectedCallRecord.number;
                          setShowCallDetailsModal(false);
                          onCall(num);
                        }}
                      >
                        <PhoneIcon size={16} color="#000000" />
                        <Text style={styles.callDetailsActionText}>Call</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.callDetailsActionSecondary}
                        onPress={() => {
                          const num = selectedCallRecord.number;
                          const name =
                            selectedCallRecord.name !== selectedCallRecord.number
                              ? selectedCallRecord.name
                              : '';
                          setShowCallDetailsModal(false);
                          setNewContactName(name);
                          setNewContactNumber(num);
                          setShowAddContactModal(true);
                        }}
                      >
                        <UserPlusIcon size={16} color="#ffffff" />
                        <Text style={styles.callDetailsSecondaryText}>Add Contact</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.callDetailsActionDanger}
                        onPress={() => {
                          if (onDeleteCallRecord) {
                            onDeleteCallRecord(selectedCallRecord.id);
                          }
                          setShowCallDetailsModal(false);
                        }}
                      >
                        <TrashIcon size={16} color="#ef4444" />
                        <Text style={styles.callDetailsDangerText}>Delete</Text>
                      </TouchableOpacity>
                    </View>

                    {/* Detailed Metadata Card */}
                    <View style={styles.callDetailsMetaCard}>
                      <View style={styles.callDetailsMetaRow}>
                        <Text style={styles.callDetailsMetaLabel}>Call Type</Text>
                        <Text
                          style={[
                            styles.callDetailsMetaValue,
                            selectedCallRecord.direction === 'missed' && { color: '#ef4444' },
                          ]}
                        >
                          {selectedCallRecord.direction === 'inbound'
                            ? 'Incoming (Answered)'
                            : selectedCallRecord.direction === 'outbound'
                            ? 'Outgoing Call'
                            : 'Missed Call'}
                        </Text>
                      </View>

                      <View style={styles.callDetailsMetaDivider} />

                      <View style={styles.callDetailsMetaRow}>
                        <Text style={styles.callDetailsMetaLabel}>Date & Time</Text>
                        <Text style={styles.callDetailsMetaValue}>
                          {formatExactDate(selectedCallRecord.timestamp)}
                        </Text>
                      </View>

                      {selectedCallRecord.duration != null && selectedCallRecord.duration > 0 && (
                        <>
                          <View style={styles.callDetailsMetaDivider} />
                          <View style={styles.callDetailsMetaRow}>
                            <Text style={styles.callDetailsMetaLabel}>Duration</Text>
                            <Text style={styles.callDetailsMetaValue}>
                              {formatCallTime(selectedCallRecord.duration)}
                            </Text>
                          </View>
                        </>
                      )}
                    </View>
                  </>
                )}
              </View>
          </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
  cursorCaret: {
    width: 2.5,
    height: 28,
    backgroundColor: '#38bdf8',
    borderRadius: 1.5,
    marginLeft: 3,
  },
  keypadGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 14,
    paddingHorizontal: 8,
  },
  keyBtn: {
    width: '30%',
    aspectRatio: 1.3,
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  dialActionsRowExpanded: {
    marginTop: 12,
  },
  dialAuxBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialAuxBtnDisabled: {
    opacity: 0.35,
  },
  mainCallPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#38bdf8',
    paddingHorizontal: 28,
    height: 48,
    borderRadius: 24,
    gap: 8,
  },
  mainCallPillDisabled: {
    opacity: 0.35,
  },
  callPillText: {
    color: '#000000',
    fontWeight: '700',
    fontSize: 14,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  bottomNav: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 10,
    borderTopColor: '#18181b',
    borderTopWidth: 1,
    backgroundColor: '#000000',
  },
  navItem: {
    alignItems: 'center',
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
  contactsContent: {
    flex: 1,
    paddingHorizontal: 20,
  },
  contactSearchInput: {
    backgroundColor: '#18181b',
    color: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    marginBottom: 12,
    fontSize: 14,
    borderColor: '#27272a',
    borderWidth: 1,
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
    maxHeight: '85%',
    backgroundColor: '#18181b',
    borderRadius: 20,
    borderColor: '#27272a',
    borderWidth: 1,
    overflow: 'hidden',
    alignSelf: 'center',
  },
  settingsScroll: {
    flexGrow: 0,
  },
  settingsCard: {
    padding: 22,
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
  settingsSectionDivider: {
    height: 1,
    backgroundColor: '#27272a',
    marginVertical: 16,
  },
  callDetailsCard: {
    width: '100%',
    backgroundColor: '#18181b',
    borderRadius: 20,
    padding: 22,
    borderColor: '#27272a',
    borderWidth: 1,
  },
  callDetailsHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  callDetailsIdentity: {
    alignItems: 'center',
    marginBottom: 20,
  },
  callDetailsAvatar: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#27272a',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    borderColor: '#38bdf8',
    borderWidth: 1.5,
  },
  callDetailsName: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  callDetailsNumber: {
    color: '#71717a',
    fontSize: 14,
    marginTop: 4,
    textAlign: 'center',
  },
  callDetailsActionsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 20,
  },
  callDetailsActionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#38bdf8',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 24,
  },
  callDetailsActionText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
  },
  callDetailsActionSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#27272a',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 24,
    borderColor: '#3f3f46',
    borderWidth: 1,
  },
  callDetailsSecondaryText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  callDetailsActionDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#271b1d',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 24,
    borderColor: '#7f1d1d',
    borderWidth: 1,
  },
  callDetailsDangerText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '600',
  },
  callDetailsMetaCard: {
    backgroundColor: '#121215',
    borderRadius: 12,
    padding: 14,
    borderColor: '#27272a',
    borderWidth: 1,
  },
  callDetailsMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  callDetailsMetaDivider: {
    height: 1,
    backgroundColor: '#27272a',
    marginVertical: 4,
  },
  callDetailsMetaLabel: {
    color: '#71717a',
    fontSize: 13,
    fontWeight: '500',
  },
  callDetailsMetaValue: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
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
    backgroundColor: '#000000',
    justifyContent: 'space-between',
    paddingVertical: 32,
    paddingHorizontal: 24,
  },
  inCallTop: {
    alignItems: 'center',
    marginTop: 20,
  },
  inCallLabel: {
    color: '#a1a1aa',
    fontSize: 12,
    letterSpacing: 3,
    fontWeight: '700',
  },
  inCallTimer: {
    color: '#38bdf8',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  inCallAvatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#18181b',
    borderColor: '#38bdf8',
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
  },
  inCallAvatarText: {
    color: '#38bdf8',
    fontSize: 40,
    fontWeight: '700',
  },
  inCallName: {
    color: '#ffffff',
    fontSize: 26,
    fontWeight: '700',
    marginTop: 14,
  },
  inCallNumber: {
    color: '#a1a1aa',
    fontSize: 16,
    marginTop: 4,
  },
  inCallControls: {
    gap: 20,
  },
  inCallRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  inCallBtn: {
    backgroundColor: '#18181b',
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: '#27272a',
    borderWidth: 1,
  },
  inCallBtnActive: {
    borderColor: '#38bdf8',
    backgroundColor: '#082f49',
  },
  inCallBtnLabel: {
    color: '#a1a1aa',
    fontSize: 11,
    marginTop: 4,
    fontWeight: '600',
  },
  inCallBtnLabelActive: {
    color: '#38bdf8',
    fontWeight: '700',
  },
  contactsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
});
