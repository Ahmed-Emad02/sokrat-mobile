import React, { useState, useEffect } from 'react';
import {
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme';
import { CallRecord, Contact, SavedAccount } from '../storage/store';
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
} from './Icons';

type Props = {
  account: SavedAccount | null;
  state: SipState;
  callsHistory: CallRecord[];
  contacts: Contact[];
  activeCall: ActiveCall | null;
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
  onDeleteContact: (id: string) => void;
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
  onCall,
  onHangup,
  onToggleMute,
  onToggleHold,
  onToggleSpeaker,
  onSendDtmf,
  onTransfer,
  onSaveAccount,
  onLogout,
  onClearHistory,
  onSaveContact,
  onDeleteContact,
  onToggleFavorite,
}: Props) {
  // Navigation & UI States
  const [activeTab, setActiveTab] = useState<BottomTab>('phone');
  const [digits, setDigits] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(!account);
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [contactSearch, setContactSearch] = useState('');

  // Settings State Form
  const [editExt, setEditExt] = useState(account?.extension || '150');
  const [editPass, setEditPass] = useState(account?.password || 'sss333');
  const [editHost, setEditHost] = useState(account?.serverHost || '192.168.100.128');
  const [editTls, setEditTls] = useState(account?.useTls || false);
  const [editDnd, setEditDnd] = useState(account?.dnd || false);
  const [editAuto, setEditAuto] = useState(account?.autoAnswer || false);

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

  const formatCallTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const formatTimeAgo = (ts: number) => {
    const elapsed = Math.floor((Date.now() - ts) / 1000);
    if (elapsed < 60) return 'Just now';
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)} min ago`;
    if (elapsed < 86400) return `${Math.floor(elapsed / 3600)} hr ago`;
    return 'Yesterday';
  };

  const handleDigitPress = (d: string) => {
    setDigits((prev) => prev + d);
  };

  const handleBackspace = () => {
    setDigits((prev) => prev.slice(0, -1));
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
    });
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
    setShowSettingsModal(true);
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
                <Text style={styles.inCallBtnLabel}>{activeCall.isMuted ? 'Unmute' : 'Mute'}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.inCallBtn} onPress={() => setShowInCallDtmf(true)}>
                <KeypadIcon size={26} color="#ffffff" />
                <Text style={styles.inCallBtnLabel}>Keypad</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.inCallBtn} onPress={onToggleSpeaker}>
                <SpeakerIcon size={26} color="#ffffff" />
                <Text style={styles.inCallBtnLabel}>Speaker</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.inCallRow}>
              <TouchableOpacity
                style={[styles.inCallBtn, activeCall.isHeld && styles.inCallBtnActive]}
                onPress={onToggleHold}
              >
                {activeCall.isHeld ? <PlayIcon size={26} color="#38bdf8" /> : <PauseIcon size={26} color="#ffffff" />}
                <Text style={styles.inCallBtnLabel}>{activeCall.isHeld ? 'Resume' : 'Hold'}</Text>
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

        {/* Transfer Dialog */}
        <Modal visible={showTransferModal} transparent animationType="fade">
          <View style={styles.modalBackdrop}>
            <View style={styles.dialogCard}>
              <Text style={styles.dialogTitle}>Transfer Call</Text>
              <TextInput
                style={styles.dialogInput}
                value={transferTarget}
                onChangeText={setTransferTarget}
                placeholder="Extension (e.g. 102)"
                placeholderTextColor="#666"
                keyboardType="phone-pad"
                autoFocus
              />
              <View style={styles.dialogActions}>
                <TouchableOpacity onPress={() => setShowTransferModal(false)} style={styles.dialogCancelBtn}>
                  <Text style={styles.dialogCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    if (transferTarget.trim()) onTransfer(transferTarget.trim());
                    setShowTransferModal(false);
                  }}
                  style={styles.dialogSubmitBtn}
                >
                  <Text style={styles.dialogSubmitText}>Transfer</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
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

      {/* 3-Dots Dropdown Menu */}
      {showMenu && (
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
      )}

      {/* Main Tab Views */}
      {activeTab === 'phone' && (
        <View style={styles.phoneTabContent}>
          {/* Top Half: Recents History List */}
          <View style={styles.recentsSection}>
            {callsHistory.length === 0 ? (
              <View style={styles.emptyHistory}>
                <Text style={styles.emptyHistoryText}>No recent calls</Text>
              </View>
            ) : (
              <FlatList
                data={callsHistory.slice(0, 20)}
                keyExtractor={(item) => item.id}
                showsVerticalScrollIndicator={false}
                renderItem={({ item }) => (
                  <TouchableOpacity style={styles.recentItem} onPress={() => onCall(item.number)}>
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
                    <TouchableOpacity style={styles.infoCircleBtn} onPress={() => onCall(item.number)}>
                      <InfoIcon size={20} color="#71717a" />
                    </TouchableOpacity>
                  </TouchableOpacity>
                )}
              />
            )}
          </View>

          {/* Lower Half: Dialpad Display & 3x4 Keypad */}
          <View style={styles.dialpadSection}>
            {/* Number Display */}
            <View style={styles.numberRow}>
              <Text style={styles.dialedDigits} numberOfLines={1}>
                {digits || ' '}
              </Text>
            </View>

            {/* 3x4 Dialpad Grid */}
            <View style={styles.keypadGrid}>
              {DIALPAD_KEYS.map((k) => (
                <TouchableOpacity
                  key={k.digit}
                  style={styles.keyBtn}
                  onPress={() => handleDigitPress(k.digit)}
                >
                  <Text style={styles.keyNumber}>{k.digit}</Text>
                  {k.isVm ? (
                    <View style={{ marginTop: 2 }}>
                      <VoicemailIcon size={12} color="#a1a1aa" />
                    </View>
                  ) : k.sub ? (
                    <Text style={styles.keyLetters}>{k.sub}</Text>
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>

            {/* Bottom Action Bar */}
            <View style={styles.dialActionsRow}>
              <TouchableOpacity style={styles.dialAuxBtn} onPress={() => setDigits('')}>
                <KeypadIcon size={22} color="#a1a1aa" />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.mainCallPill, !digits && styles.mainCallPillDisabled]}
                onPress={handleDial}
                disabled={!digits}
              >
                <PhoneIcon size={18} color="#000000" />
                <Text style={styles.callPillText}>
                  {account ? `Ext ${account.extension}` : 'Call'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.dialAuxBtn} onPress={handleBackspace}>
                <BackspaceIcon size={22} color="#a1a1aa" />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {activeTab === 'contacts' && (
        <View style={styles.contactsContent}>
          <TextInput
            style={styles.contactSearchInput}
            value={contactSearch}
            onChangeText={setContactSearch}
            placeholder="Search contacts…"
            placeholderTextColor="#666"
          />
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

      {/* Settings Modal (Vertically & Horizontally Centered) */}
      <Modal visible={showSettingsModal} transparent animationType="fade" onRequestClose={() => setShowSettingsModal(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.settingsCardWrapper}>
            <ScrollView
              style={styles.settingsScroll}
              contentContainerStyle={styles.settingsCard}
              showsVerticalScrollIndicator={false}
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

              <View style={styles.switchRow}>
                <View>
                  <Text style={styles.switchLabel}>TLS / WSS Protocol</Text>
                  <Text style={styles.switchSub}>{editTls ? 'Port 8089 (WSS)' : 'Port 8088 (Plain WS on LAN)'}</Text>
                </View>
                <Switch value={editTls} onValueChange={setEditTls} thumbColor={editTls ? '#38bdf8' : '#555'} />
              </View>

              <View style={styles.switchRow}>
                <View>
                  <Text style={styles.switchLabel}>Do Not Disturb (DND)</Text>
                  <Text style={styles.switchSub}>Auto-reject incoming calls</Text>
                </View>
                <Switch value={editDnd} onValueChange={setEditDnd} thumbColor={editDnd ? '#ef4444' : '#555'} />
              </View>

              <View style={styles.switchRow}>
                <View>
                  <Text style={styles.switchLabel}>Auto-Answer</Text>
                  <Text style={styles.switchSub}>Auto-accept incoming calls</Text>
                </View>
                <Switch value={editAuto} onValueChange={setEditAuto} thumbColor={editAuto ? '#10b981' : '#555'} />
              </View>

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

      {/* Add Contact Modal */}
      <Modal visible={showAddContactModal} transparent animationType="fade" onRequestClose={() => setShowAddContactModal(false)}>
        <View style={styles.modalBackdrop}>
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
  menuBtn: {
    padding: 8,
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
    paddingHorizontal: 24,
    paddingBottom: 8,
  },
  numberRow: {
    minHeight: 38,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  dialedDigits: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: 2,
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
  },
  keyLetters: {
    color: '#a1a1aa',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1,
    marginTop: 2,
  },
  dialActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingHorizontal: 16,
  },
  dialAuxBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mainCallPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#38bdf8',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 30,
    gap: 8,
  },
  mainCallPillDisabled: {
    opacity: 0.35,
  },
  callPillText: {
    color: '#000000',
    fontWeight: '700',
    fontSize: 14,
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
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  settingsCardWrapper: {
    width: '100%',
    maxHeight: '85%',
    backgroundColor: '#18181b',
    borderRadius: 20,
    borderColor: '#27272a',
    borderWidth: 1,
    overflow: 'hidden',
  },
  settingsScroll: {
    maxHeight: '100%',
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
