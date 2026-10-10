/**
 * Sokrat VOICE — Modern Incoming Call Ringing Screen.
 * Features fluid multi-ring radar waves, glassmorphic badges, and responsive action controls.
 */
import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme';
import { PhoneAnswerIcon, PhoneDeclineIcon, PhoneIcon } from './Icons';

type Props = {
  callerId: string;
  callerName: string;
  onAnswer: () => void;
  onDecline: () => void;
};

export function RingingScreen({ callerId, callerName, onAnswer, onDecline }: Props) {
  const ripple1 = useRef(new Animated.Value(0)).current;
  const ripple2 = useRef(new Animated.Value(0)).current;
  const ripple3 = useRef(new Animated.Value(0)).current;
  const bounceAnim = useRef(new Animated.Value(1)).current;
  const textFadeAnim = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    const createRipple = (anim: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, {
            toValue: 1,
            duration: 2400,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ])
      );
    };

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(bounceAnim, { toValue: 1.07, duration: 900, useNativeDriver: true }),
        Animated.timing(bounceAnim, { toValue: 1.0, duration: 900, useNativeDriver: true }),
      ])
    );

    const textBreath = Animated.loop(
      Animated.sequence([
        Animated.timing(textFadeAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(textFadeAnim, { toValue: 0.45, duration: 900, useNativeDriver: true }),
      ])
    );

    const r1 = createRipple(ripple1, 0);
    const r2 = createRipple(ripple2, 800);
    const r3 = createRipple(ripple3, 1600);

    r1.start();
    r2.start();
    r3.start();
    pulse.start();
    textBreath.start();

    return () => {
      r1.stop();
      r2.stop();
      r3.stop();
      pulse.stop();
      textBreath.stop();
    };
  }, [ripple1, ripple2, ripple3, bounceAnim, textFadeAnim]);

  const displayName = callerName.trim() || callerId.trim() || 'Unknown Caller';
  const displayExt = callerId.trim() || callerName.trim();
  const initial = displayName.charAt(0).toUpperCase() || '?';

  return (
    <SafeAreaView style={styles.container}>
      {/* Top Protocol Badge */}
      <View style={styles.badgeWrapper}>
        <View style={styles.badgePill}>
          <View style={styles.badgeDot} />
          <Text style={styles.badgeText}>INCOMING SOKRAT CALL</Text>
        </View>
      </View>

      {/* Center Radar Waves & Avatar Hero */}
      <View style={styles.centerHero}>
        <View style={styles.avatarWrapper}>
          <Animated.View
            style={[
              styles.rippleRing,
              {
                transform: [
                  {
                    scale: ripple1.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 2.5],
                    }),
                  },
                ],
                opacity: ripple1.interpolate({
                  inputRange: [0, 0.5, 1],
                  outputRange: [0.65, 0.25, 0],
                }),
              },
            ]}
          />
          <Animated.View
            style={[
              styles.rippleRing,
              {
                transform: [
                  {
                    scale: ripple2.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 2.5],
                    }),
                  },
                ],
                opacity: ripple2.interpolate({
                  inputRange: [0, 0.5, 1],
                  outputRange: [0.65, 0.25, 0],
                }),
              },
            ]}
          />
          <Animated.View
            style={[
              styles.rippleRing,
              {
                transform: [
                  {
                    scale: ripple3.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 2.5],
                    }),
                  },
                ],
                opacity: ripple3.interpolate({
                  inputRange: [0, 0.5, 1],
                  outputRange: [0.65, 0.25, 0],
                }),
              },
            ]}
          />

          <Animated.View style={[styles.avatarCircle, { transform: [{ scale: bounceAnim }] }]}>
            <Text style={styles.avatarInitial}>{initial}</Text>
          </Animated.View>
        </View>

        {/* Caller Info */}
        <Text style={styles.callerName} numberOfLines={1}>
          {displayName}
        </Text>

        <View style={styles.extBadge}>
          <PhoneIcon size={14} color="#38bdf8" />
          <Text style={styles.extBadgeText}>Ext {displayExt}</Text>
        </View>

        <Animated.Text style={[styles.ringingStatus, { opacity: textFadeAnim }]}>
          Ringing softphone…
        </Animated.Text>
      </View>

      {/* Bottom Answer / Decline Action Controls */}
      <View style={styles.actionsBar}>
        {/* Decline Action */}
        <View style={styles.actionCol}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.declineBtn]}
            onPress={onDecline}
            delayPressIn={0}
            hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Decline incoming call"
          >
            <PhoneDeclineIcon size={32} color="#ffffff" />
          </TouchableOpacity>
          <Text style={styles.actionLabel}>Decline</Text>
        </View>

        {/* Answer Action */}
        <View style={styles.actionCol}>
          <View style={styles.answerBtnWrap}>
            <Animated.View
              style={[
                styles.answerHalo,
                {
                  transform: [{ scale: bounceAnim }],
                  opacity: bounceAnim.interpolate({
                    inputRange: [1.0, 1.07],
                    outputRange: [0.35, 0.75],
                  }),
                },
              ]}
              pointerEvents="none"
            />
            <TouchableOpacity
              style={[styles.actionBtn, styles.answerBtn]}
              onPress={onAnswer}
              delayPressIn={0}
              hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Answer incoming call"
            >
              <PhoneAnswerIcon size={32} color="#ffffff" />
            </TouchableOpacity>
          </View>
          <Text style={styles.actionLabel}>Answer</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: 'rgba(56, 189, 248, 0.1)',
    borderColor: 'rgba(56, 189, 248, 0.3)',
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 20,
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
    marginVertical: 'auto',
  },
  avatarWrapper: {
    width: 136,
    height: 136,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    marginBottom: 28,
  },
  rippleRing: {
    position: 'absolute',
    width: 136,
    height: 136,
    borderRadius: 68,
    borderWidth: 2,
    borderColor: '#38bdf8',
  },
  avatarCircle: {
    width: 124,
    height: 124,
    borderRadius: 62,
    backgroundColor: '#18181b',
    borderColor: '#38bdf8',
    borderWidth: 2.5,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 14,
    shadowColor: '#38bdf8',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
  },
  avatarInitial: {
    color: '#38bdf8',
    fontSize: 54,
    fontWeight: '800',
  },
  callerName: {
    color: '#ffffff',
    fontSize: 30,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
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
    marginBottom: 16,
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
    marginBottom: 28,
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
  answerBtnWrap: {
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  answerHalo: {
    position: 'absolute',
    width: 86,
    height: 86,
    borderRadius: 43,
    backgroundColor: '#16a34a',
  },
  answerBtn: {
    backgroundColor: '#16a34a',
    shadowColor: '#16a34a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  actionLabel: {
    color: '#a1a1aa',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1,
  },
});
