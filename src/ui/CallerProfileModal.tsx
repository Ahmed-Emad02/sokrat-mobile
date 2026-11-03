import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Clipboard,
  I18nManager,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useI18n } from '../i18n';
import type { CallRecord, Contact } from '../storage/store';
import { themedStyles, useTheme } from '../theme';
import {
  buildCallerProfile,
  formatCallDuration,
  formatTimeOfDay,
  groupCallsByDay,
} from '../utils/callLog';
import {
  buildWhatsAppAppUrl,
  buildWhatsAppWebUrl,
  resolveWhatsAppNumber,
  sanitizeCountryCode,
  type WhatsAppResolution,
} from '../utils/whatsapp';
import {
  BackIcon,
  BookmarkIcon,
  CallIncomingIcon,
  CallMissedIcon,
  CallOutgoingIcon,
  CopyIcon,
  EditIcon,
  PhoneIcon,
  TrashIcon,
  UserPlusIcon,
  WhatsAppIcon,
} from './Icons';

export type CallerProfileModalProps = {
  visible: boolean;
  number: string | null;
  calls: CallRecord[];
  contacts: Contact[];
  whatsappCountryCode?: string;
  whatsappPromptEnabled?: boolean;
  onClose: () => void;
  onCall: (number: string) => void;
  onAddContact: (name: string, number: string) => void;
  onEditContact: (contact: Contact) => void;
  onDeleteContact: (contactId: string) => void;
  onToggleFavorite: (contactId: string) => void;
  onDeleteRecord?: (id: string) => void;
  onSaveWhatsAppCountryCode: (code: string) => void;
};

type ProfileCallSection = {
  title: string;
  data: CallRecord[];
};


export function CallerProfileModal({
  visible,
  number,
  calls,
  contacts,
  whatsappCountryCode,
  whatsappPromptEnabled = true,
  onClose,
  onCall,
  onAddContact,
  onEditContact,
  onDeleteContact,
  onToggleFavorite,
  onDeleteRecord,
  onSaveWhatsAppCountryCode,
}: CallerProfileModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => themedStyles(rawStyles, colors), [colors]);
  const { t } = useI18n();
  const isRTL = I18nManager.isRTL;

  const [promptVisible, setPromptVisible] = useState(false);
  const [countryInput, setCountryInput] = useState('');
  const [promptError, setPromptError] = useState('');
  const [copied, setCopied] = useState(false);
  const longPressedRecordRef = useRef<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) {
      setPromptVisible(false);
      setCountryInput('');
      setPromptError('');
      setCopied(false);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    }
  }, [visible]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const profile = useMemo(
    () => (number ? buildCallerProfile(number, calls, contacts) : null),
    [number, calls, contacts],
  );

  const sections: ProfileCallSection[] = useMemo(() => {
    if (!profile) return [];
    return groupCallsByDay(profile.calls).map((section) => ({
      title:
        section.kind === 'today'
          ? t('Today')
          : section.kind === 'yesterday'
            ? t('Yesterday')
            : section.label,
      data: section.data,
    }));
  }, [profile, t]);

  const whatsappResolution: WhatsAppResolution = useMemo(
    () =>
      profile
        ? resolveWhatsAppNumber(profile.number, whatsappCountryCode)
        : { status: 'ineligible', reason: 'empty' },
    [profile, whatsappCountryCode],
  );

  const showWhatsApp =
    whatsappResolution.status === 'ready' ||
    whatsappResolution.status === 'needs-country-code';

  const launchWhatsApp = useCallback(
    async (digits: string) => {
      const appUrl = buildWhatsAppAppUrl(digits);
      try {
        if (await Linking.canOpenURL(appUrl)) {
          await Linking.openURL(appUrl);
          return;
        }
      } catch {
        // Fall through to the web link.
      }

      try {
        await Linking.openURL(buildWhatsAppWebUrl(digits));
      } catch {
        Alert.alert(t('WhatsApp'), t('Could not open WhatsApp.'));
      }
    },
    [t],
  );

  const handleWhatsApp = useCallback(() => {
    if (!profile) return;
    if (whatsappResolution.status === 'ready') {
      void launchWhatsApp(whatsappResolution.digits);
      return;
    }
    if (
      whatsappResolution.status === 'needs-country-code' &&
      whatsappPromptEnabled
    ) {
      setCountryInput(sanitizeCountryCode(whatsappCountryCode));
      setPromptError('');
      setPromptVisible(true);
      return;
    }
    if (whatsappResolution.status === 'needs-country-code') {
      Alert.alert(
        t('WhatsApp'),
        t('Set a WhatsApp country code in Settings to message local numbers.'),
        [{ text: t('OK') }],
      );
    }
  }, [launchWhatsApp, profile, whatsappCountryCode, whatsappPromptEnabled, whatsappResolution, t]);

  const submitCountryCode = useCallback(() => {
    if (!profile) return;
    const code = sanitizeCountryCode(countryInput);
    if (!code) {
      setPromptError(t('Enter a valid country code.'));
      return;
    }
    const resolved = resolveWhatsAppNumber(profile.number, code);
    if (resolved.status !== 'ready') {
      setPromptError(t('This number cannot be used with WhatsApp.'));
      return;
    }
    setPromptVisible(false);
    onSaveWhatsAppCountryCode(code);
    void launchWhatsApp(resolved.digits);
  }, [
    countryInput,
    launchWhatsApp,
    onSaveWhatsAppCountryCode,
    profile,
    t,
  ]);

  const handleCall = useCallback(
    (target: string) => {
      onClose();
      onCall(target);
    },
    [onCall, onClose],
  );

  const confirmDelete = useCallback(
    (record: CallRecord) => {
      if (!onDeleteRecord) return;
      Alert.alert(t('Delete call?'), t('Remove this call from the history?'), [
        { text: t('Cancel'), style: 'cancel' },
        {
          text: t('Delete'),
          style: 'destructive',
          onPress: () => onDeleteRecord(record.id),
        },
      ]);
    },
    [onDeleteRecord, t],
  );

  const handleRequestClose = useCallback(() => {
    if (promptVisible) {
      setPromptVisible(false);
      return;
    }
    onClose();
  }, [onClose, promptVisible]);

  if (!profile) {
    return null;
  }

  const hasMeaningfulName = profile.displayName !== profile.number;
  const subtitle = profile.contact
    ? profile.isExtension
      ? `${profile.contact.extension} · ${t('VoIP')}`
      : `${profile.contact.extension} · ${t('VoIP')}`
    : profile.isExtension
      ? `${profile.number} · ${t('VoIP')}`
      : hasMeaningfulName
        ? profile.number
        : t('Unknown');

  const handleCopyNumber = () => {
    Clipboard.setString(profile.number.trim());
    setCopied(true);
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = setTimeout(() => setCopied(false), 1600);
  };

  const confirmDeleteContact = () => {
    const contact = profile.contact;
    if (!contact) return;
    Alert.alert(
      t('Delete contact?'),
      t('This contact will be removed. Your call history stays.'),
      [
        { text: t('Cancel'), style: 'cancel' },
        {
          text: t('Delete'),
          style: 'destructive',
          onPress: () => {
            onDeleteContact(contact.id);
            onClose();
          },
        },
      ],
    );
  };

  const renderHeader = () => (
    <View>
      <View style={styles.identity}>
        <Text style={styles.name} numberOfLines={1}>
          {profile.displayName}
        </Text>
        <View style={styles.numberRow}>
          <Text style={styles.number}>{subtitle}</Text>
          <TouchableOpacity
            style={styles.copyNumberButton}
            onPress={handleCopyNumber}
            accessibilityRole="button"
            accessibilityLabel={t('Copy phone number')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <CopyIcon size={14} color={colors.brand} />
          </TouchableOpacity>
        </View>
        {copied ? <Text style={styles.copiedText}>{t('Copied')}</Text> : null}
      </View>

      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={styles.primaryAction}
          activeOpacity={0.8}
          onPress={() => handleCall(profile.number)}
          accessibilityRole="button"
          accessibilityLabel={`${t('Call')} ${profile.displayName}`}
        >
          <PhoneIcon size={17} color={colors.onBrand} />
          <Text style={styles.primaryActionText}>{t('Call')}</Text>
        </TouchableOpacity>

        {showWhatsApp ? (
          <TouchableOpacity
            style={styles.secondaryAction}
            activeOpacity={0.8}
            onPress={handleWhatsApp}
            accessibilityRole="button"
            accessibilityLabel={`${t('WhatsApp')} ${profile.displayName}`}
          >
            <WhatsAppIcon size={18} color="#25D366" />
            <Text style={styles.secondaryActionText}>{t('WhatsApp')}</Text>
          </TouchableOpacity>
        ) : null}

        {profile.contact ? (
          <TouchableOpacity
            style={styles.secondaryAction}
            activeOpacity={0.8}
            onPress={() => onToggleFavorite(profile.contact!.id)}
            accessibilityRole="button"
            accessibilityLabel={
              profile.contact.favorite ? t('Remove bookmark') : t('Bookmark')
            }
          >
            <BookmarkIcon
              size={17}
              color={profile.contact.favorite ? colors.brand : colors.textMuted}
              fill={profile.contact.favorite ? colors.brand : 'none'}
            />
            <Text style={styles.secondaryActionText}>
              {profile.contact.favorite ? t('Bookmarked') : t('Bookmark')}
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.secondaryAction}
            activeOpacity={0.8}
            onPress={() => onAddContact(hasMeaningfulName ? profile.displayName : '', profile.number)}
            accessibilityRole="button"
            accessibilityLabel={t('Add Contact')}
          >
            <UserPlusIcon size={17} color={colors.text} />
            <Text style={styles.secondaryActionText}>{t('Add Contact')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {profile.contact ? (
        <View style={styles.manageRow}>
          <TouchableOpacity
            style={styles.manageBtn}
            activeOpacity={0.8}
            onPress={() => onEditContact(profile.contact!)}
            accessibilityRole="button"
            accessibilityLabel={t('Edit')}
          >
            <EditIcon size={15} color={colors.textMuted} />
            <Text style={styles.manageText}>{t('Edit')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.manageBtn, styles.manageDeleteBtn]}
            activeOpacity={0.8}
            onPress={confirmDeleteContact}
            accessibilityRole="button"
            accessibilityLabel={t('Delete')}
          >
            <TrashIcon size={15} color={colors.dangerText} />
            <Text style={styles.manageDeleteText}>{t('Delete')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Text style={styles.summary}>
        {profile.calls.length} {t('calls')}
        {profile.missedCount > 0
          ? ` · ${profile.missedCount} ${t('missed')}`
          : ''}
      </Text>

      <Text style={styles.historyTitle}>{t('Call History')}</Text>
    </View>
  );

  const renderLogRow = (record: CallRecord) => {
    const isMissed = record.direction === 'missed';
    const directionLabel =
      record.direction === 'inbound'
        ? t('Incoming')
        : record.direction === 'outbound'
          ? t('Outgoing')
          : t('Missed call');
    const directionColor =
      record.direction === 'inbound'
        ? colors.success
        : record.direction === 'outbound'
          ? colors.brand
          : colors.danger;

    return (
      <TouchableOpacity
        style={styles.logRow}
        activeOpacity={0.7}
        delayPressIn={0}
        onPress={() => {
          if (longPressedRecordRef.current === record.id) {
            longPressedRecordRef.current = null;
            return;
          }
          handleCall(record.number);
        }}
        onLongPress={() => {
          longPressedRecordRef.current = record.id;
          confirmDelete(record);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${directionLabel}, ${formatTimeOfDay(record.timestamp)}`}
        accessibilityHint={t('Tap to call, hold to delete')}
      >
        <View style={styles.logIcon}>
          {record.direction === 'inbound' ? (
            <CallIncomingIcon size={17} color={directionColor} />
          ) : record.direction === 'outbound' ? (
            <CallOutgoingIcon size={17} color={directionColor} />
          ) : (
            <CallMissedIcon size={17} color={directionColor} />
          )}
        </View>
        <View style={styles.logMain}>
          <Text style={[styles.logDirection, isMissed && styles.logDirectionMissed]}>
            {directionLabel}
          </Text>
          <Text style={styles.logTime}>{formatTimeOfDay(record.timestamp)}</Text>
        </View>
        {record.duration != null && record.duration > 0 ? (
          <Text style={styles.logDuration}>{formatCallDuration(record.duration)}</Text>
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={handleRequestClose}
      statusBarTranslucent
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('Back')}
          >
            <View style={{ transform: [{ scaleX: isRTL ? -1 : 1 }] }}>
              <BackIcon size={23} color={colors.text} />
            </View>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('Profile')}</Text>
          <View style={styles.iconButton} />
        </View>

        <SectionList<CallRecord, ProfileCallSection>
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => renderLogRow(item)}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          ListHeaderComponent={renderHeader}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>{t('No calls with this number')}</Text>
            </View>
          }
          contentContainerStyle={styles.listContent}
          stickySectionHeadersEnabled={false}
          showsVerticalScrollIndicator={false}
        />

        {promptVisible ? (
          <View style={styles.promptOverlay}>
            <KeyboardAvoidingView
              style={styles.promptKeyboard}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
              <View style={styles.promptCard}>
                <Text style={styles.promptTitle}>{t('WhatsApp country code')}</Text>
                <Text style={styles.promptSubtitle}>
                  {t('Enter the country code for')} {profile.number}
                </Text>
                <TextInput
                  style={styles.promptInput}
                  value={countryInput}
                  onChangeText={(value) => {
                    setCountryInput(value.replace(/\D/g, '').slice(0, 4));
                    setPromptError('');
                  }}
                  placeholder={t('e.g. 20')}
                  placeholderTextColor={colors.textFaint}
                  keyboardType="number-pad"
                  maxLength={4}
                  autoFocus
                />
                {promptError ? <Text style={styles.promptError}>{promptError}</Text> : null}
                <View style={styles.promptActions}>
                  <TouchableOpacity
                    style={styles.promptCancel}
                    onPress={() => setPromptVisible(false)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.promptCancelText}>{t('Cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.promptSubmit}
                    onPress={submitCountryCode}
                    accessibilityRole="button"
                  >
                    <Text style={styles.promptSubmitText}>{t('Continue')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </View>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const rawStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  identity: {
    alignItems: 'center',
    paddingTop: 24,
    paddingBottom: 18,
  },
  name: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  number: {
    color: '#a1a1aa',
    fontSize: 14,
    textAlign: 'center',
  },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    marginTop: 4,
  },
  copyNumberButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#18181b',
    borderColor: '#27272a',
    borderWidth: 1,
  },
  copiedText: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
    textAlign: 'center',
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  primaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#38bdf8',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 24,
  },
  primaryActionText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  secondaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#18181b',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 24,
    borderColor: '#27272a',
    borderWidth: 1,
  },
  secondaryActionText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  manageRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
  },
  manageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#27272a',
    backgroundColor: '#18181b',
  },
  manageText: {
    color: '#a1a1aa',
    fontSize: 12,
    fontWeight: '600',
  },
  manageDeleteBtn: {
    borderColor: '#7f1d1d',
    backgroundColor: '#271b1d',
  },
  manageDeleteText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '600',
  },
  summary: {
    color: '#71717a',
    fontSize: 13,
    marginTop: 16,
    textAlign: 'center',
  },
  historyTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 22,
    marginBottom: 2,
  },
  sectionHeader: {
    color: '#a1a1aa',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    paddingTop: 16,
    paddingBottom: 6,
  },
  logRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  logIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#18181b',
    marginEnd: 12,
  },
  logMain: {
    flex: 1,
  },
  logDirection: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  logDirectionMissed: {
    color: '#ef4444',
  },
  logTime: {
    color: '#71717a',
    fontSize: 12,
    marginTop: 2,
  },
  logDuration: {
    color: '#a1a1aa',
    fontSize: 12,
    marginStart: 8,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  emptyText: {
    color: '#71717a',
    fontSize: 14,
  },
  promptOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 20,
  },
  promptKeyboard: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  promptCard: {
    width: '100%',
    backgroundColor: '#18181b',
    borderRadius: 18,
    borderColor: '#27272a',
    borderWidth: 1,
    padding: 20,
  },
  promptTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
  promptSubtitle: {
    color: '#a1a1aa',
    fontSize: 13,
    marginTop: 6,
    marginBottom: 14,
  },
  promptInput: {
    backgroundColor: '#09090b',
    borderColor: '#27272a',
    borderWidth: 1,
    borderRadius: 12,
    color: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  promptError: {
    color: '#ef4444',
    fontSize: 12,
    marginTop: 8,
  },
  promptActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
  },
  promptCancel: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  promptCancelText: {
    color: '#a1a1aa',
    fontSize: 13,
    fontWeight: '600',
  },
  promptSubmit: {
    backgroundColor: '#38bdf8',
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  promptSubmitText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
});
