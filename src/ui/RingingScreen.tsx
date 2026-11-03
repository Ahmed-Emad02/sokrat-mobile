/**
 * Sokrat VOICE — Modern Incoming Call Ringing Screen.
 * Features fluid multi-ring radar waves, glassmorphic badges, and responsive action controls.
 */
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Animated, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, themedStyles } from '../theme';
import { useI18n } from '../i18n';
import { PhoneAnswerIcon, PhoneDeclineIcon, PhoneIcon } from './Icons';
import { startRingtone, stopRingtone } from '../calls/incall';
import { callDisplayName } from '../calls/callerName';
type Props = {
  callerId: string;
  callerName: string;
  onAnswer: () => void;
  onDecline: () => void;
  answerRequested?: boolean;
};

export function RingingScreen({ callerId, callerName, onAnswer, onDecline, answerRequested = false }: Props) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => themedStyles(rawStyles, colors), [colors]);
  const textFadeAnim = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    const textBreath = Animated.loop(
      Animated.sequence([
        Animated.timing(textFadeAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(textFadeAnim, { toValue: 0.45, duration: 900, useNativeDriver: true }),
      ])
    );
    textBreath.start();
    return () => textBreath.stop();
  }, [textFadeAnim]);
  useEffect(() => {
    if (answerRequested) stopRingtone();
    else startRingtone();
    return () => stopRingtone();
  }, [answerRequested]);
  const [isAnswering, setIsAnswering] = useState(false);
  const wasAnswerRequestedRef = useRef(false);
  const answerPending = isAnswering || answerRequested;

  // The parent clears answerRequested when the SIP answer fails or ends.
  // Mirror that reset locally so the answer control becomes usable again.
  useEffect(() => {
    if (wasAnswerRequestedRef.current && !answerRequested) setIsAnswering(false);
    wasAnswerRequestedRef.current = answerRequested;
  }, [answerRequested]);

  // Safety only for the unusual case where onAnswer never starts a SIP answer
  // (for example, no correlated call leg). A real answer keeps answerPending
  // true until the parent replaces this screen or reports failure.
  useEffect(() => {
    if (!isAnswering || answerRequested) return;
    const timer = setTimeout(() => {
      if (!answerRequested) setIsAnswering(false);
    }, 10_000);
    return () => clearTimeout(timer);
  }, [isAnswering, answerRequested]);

  const handleAnswerPress = () => {
    if (answerPending) return;
    setIsAnswering(true);
    stopRingtone();
    onAnswer();
  };
  const handleDeclinePress = () => {
    stopRingtone();
    onDecline();
  };

  const displayName = callDisplayName(callerId, callerName);
  const displayExt = callerId.trim() || callerName.trim();
  return (
    <SafeAreaView style={styles.container}>
      {/* Top Protocol Badge */}
      <View style={styles.badgeWrapper}>
        <View style={styles.badgePill}>
          <View style={styles.badgeDot} />
          <Text style={styles.badgeText}>{t('Incoming Call')}</Text>
        </View>
      </View>

      {/* Caller information */}
      <View style={styles.centerHero}>
        {/* Caller Info */}
        <Text style={styles.callerName} numberOfLines={1}>
          {displayName}
        </Text>

        <View style={styles.extBadge}>
          <PhoneIcon size={14} color={colors.brand} />
          <Text style={styles.extBadgeText}>{displayExt}</Text>
        </View>

        <Animated.Text style={[styles.ringingStatus, { opacity: textFadeAnim }]}>
          {answerPending ? t('Connecting audio…') : t('Ringing softphone…')}
        </Animated.Text>
      </View>

      {/* Bottom Answer / Decline Action Controls */}
      <View style={styles.actionsBar}>
        {/* Decline Action */}
        <View style={styles.actionCol}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.declineBtn]}
            onPress={handleDeclinePress}
            delayPressIn={0}
            hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Decline incoming call"
          >
            <PhoneDeclineIcon size={32} color={colors.onBrand} />
          </TouchableOpacity>
          <Text style={styles.actionLabel}>{t('Decline')}</Text>
        </View>

        {/* Answer Action */}
        <View style={styles.actionCol}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.answerBtn, answerPending && { opacity: 0.6 }]}
            onPress={handleAnswerPress}
            delayPressIn={0}
            hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            activeOpacity={0.7}
            disabled={answerPending}
            accessibilityRole="button"
            accessibilityState={{ disabled: answerPending, busy: answerPending }}
            accessibilityLabel={answerPending ? 'Connecting call' : 'Answer incoming call'}
          >
            {answerPending
              ? <ActivityIndicator size={30} color={colors.onBrand} />
              : <PhoneAnswerIcon size={32} color={colors.onBrand} />}
          </TouchableOpacity>
          <Text style={styles.actionLabel}>{answerPending ? t('Connecting…') : t('Answer')}</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const rawStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#09090b',
    justifyContent: 'space-between',
    paddingVertical: 32,
    paddingHorizontal: 24,
  },
  badgeWrapper: {
    alignItems: 'center',
    marginTop: 16,
  },
  badgePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badgeDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#38bdf8',
  },
  badgeText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },
  centerHero: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 24,
  },
  callerName: {
    color: '#ffffff',
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 16,
    marginBottom: 14,
  },
  extBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#18181b',
    borderColor: '#27272a',
    borderWidth: 1,
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 14,
    marginBottom: 20,
  },
  extBadgeText: {
    color: '#a1a1aa',
    fontSize: 14,
    fontWeight: '600',
  },
  ringingStatus: {
    color: '#38bdf8',
    fontSize: 15,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  actionsBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 36,
    paddingTop: 12,
    marginBottom: 36,
    zIndex: 100,
    elevation: 20,
  },
  actionCol: {
    alignItems: 'center',
    gap: 12,
  },
  actionBtn: {
    width: 74,
    height: 74,
    borderRadius: 37,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
  },
  declineBtn: {
    backgroundColor: '#dc2626',
    shadowColor: '#dc2626',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  answerBtn: {
    backgroundColor: '#16a34a',
  },
  actionLabel: {
    color: '#a1a1aa',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1,
  },
});
