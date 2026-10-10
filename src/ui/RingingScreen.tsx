/**
 * Sokrat VOICE — incoming call ringing overlay.
 * Mirrors the native CallKit screen with fluid ripple wave animations.
 */
import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Animated } from 'react-native';
import { COLORS } from '../theme';
import { PhoneAnswerIcon, PhoneDeclineIcon } from './Icons';

type Props = {
  callerId: string;
  callerName: string;
  onAnswer: () => void;
  onDecline: () => void;
};

export function RingingScreen({ callerId, callerName, onAnswer, onDecline }: Props) {
  const ripple1 = useRef(new Animated.Value(0)).current;
  const ripple2 = useRef(new Animated.Value(0)).current;
  const bounceAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const createRipple = (anim: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.parallel([
            Animated.timing(anim, {
              toValue: 1,
              duration: 2200,
              useNativeDriver: true,
            }),
          ]),
          Animated.timing(anim, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      );
    };

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(bounceAnim, { toValue: 1.06, duration: 800, useNativeDriver: true }),
        Animated.timing(bounceAnim, { toValue: 1.0, duration: 800, useNativeDriver: true }),
      ]),
    );

    const r1 = createRipple(ripple1, 0);
    const r2 = createRipple(ripple2, 1100);

    r1.start();
    r2.start();
    pulse.start();

    return () => {
      r1.stop();
      r2.stop();
      pulse.stop();
    };
  }, [ripple1, ripple2, bounceAnim]);

  return (
    <View style={styles.container}>
      <Text style={styles.incoming}>INCOMING CALL</Text>

      <View style={styles.avatarWrapper}>
        <Animated.View
          style={[
            styles.rippleRing,
            {
              transform: [
                {
                  scale: ripple1.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 2.2],
                  }),
                },
              ],
              opacity: ripple1.interpolate({
                inputRange: [0, 0.6, 1],
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
                    outputRange: [1, 2.2],
                  }),
                },
              ],
              opacity: ripple2.interpolate({
                inputRange: [0, 0.6, 1],
                outputRange: [0.65, 0.25, 0],
              }),
            },
          ]}
        />
        <Animated.View style={[styles.idAvatar, { transform: [{ scale: bounceAnim }] }]}>
          <Text style={styles.idInitial}>{callerName.charAt(0) || callerId.charAt(0) || '?'}</Text>
        </Animated.View>
      </View>

      <Text style={styles.name}>{callerName || callerId}</Text>
      <Text style={styles.id}>{callerId}</Text>

      <View style={styles.actions}>
        <View style={styles.actionWrap}>
          <Text style={styles.actionLabel}>DECLINE</Text>
          <TouchableOpacity style={[styles.round, styles.decline]} onPress={onDecline} activeOpacity={0.8}>
            <PhoneDeclineIcon size={28} color="#ffffff" />
          </TouchableOpacity>
        </View>

        <Text style={styles.pulse}>●</Text>

        <View style={styles.actionWrap}>
          <Text style={styles.actionLabel}>ANSWER</Text>
          <Animated.View style={{ transform: [{ scale: bounceAnim }] }}>
            <TouchableOpacity style={[styles.round, styles.answer]} onPress={onAnswer} activeOpacity={0.8}>
              <PhoneAnswerIcon size={28} color="#ffffff" />
            </TouchableOpacity>
          </Animated.View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: COLORS.bg, alignItems: 'center', paddingTop: 100,
  },
  incoming: { color: COLORS.textMuted, fontSize: 12, letterSpacing: 6, marginBottom: 50 },
  avatarWrapper: {
    width: 140,
    height: 140,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  rippleRing: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: COLORS.accent,
  },
  idAvatar: {
    width: 120, height: 120, borderRadius: 60, backgroundColor: COLORS.bgElevated,
    alignItems: 'center', justifyContent: 'center', borderColor: COLORS.accent, borderWidth: 2.5,
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 15,
    elevation: 8,
  },
  idInitial: { color: COLORS.accent, fontSize: 52, fontWeight: '700' },
  name: { color: COLORS.text, fontSize: 28, fontWeight: '700', marginTop: 28 },
  id: { color: COLORS.textMuted, fontSize: 18, marginTop: 6 },
  actions: {
    flexDirection: 'row', marginTop: 'auto', marginBottom: 90,
    justifyContent: 'space-between', width: '80%', alignItems: 'flex-end',
  },
  actionWrap: { alignItems: 'center', gap: 12 },
  actionLabel: { color: COLORS.textMuted, fontSize: 11, letterSpacing: 2 },
  round: {
    width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 6,
  },
  answer: { backgroundColor: COLORS.accent },
  decline: { backgroundColor: COLORS.danger },
  pulse: { color: COLORS.accent, fontSize: 18, marginBottom: 24 },
});
