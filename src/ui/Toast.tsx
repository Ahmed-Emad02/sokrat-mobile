import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../theme';

export type ToastType = 'error' | 'warning' | 'success' | 'info';

export interface ToastMessage {
  id?: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

type ToastListener = (toast: ToastMessage | null) => void;
const listeners = new Set<ToastListener>();

export function showToast(toast: ToastMessage) {
  listeners.forEach((listener) => listener(toast));
}

export function hideToast() {
  listeners.forEach((listener) => listener(null));
}

const BORDER_BY_TYPE: Record<ToastType, string> = {
  error: COLORS.danger,
  warning: COLORS.warn,
  success: COLORS.accent,
  info: COLORS.info,
};

const ICON_BY_TYPE: Record<ToastType, string> = {
  error: '⚠️',
  warning: '⚡',
  success: '✓',
  info: 'ℹ️',
};

export function ToastContainer() {
  const [current, setCurrent] = useState<ToastMessage | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-50)).current;
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    const handler: ToastListener = (toast) => {
      clearTimeout(timerRef.current as number);
      timerRef.current = null;
      if (!toast) {
        Animated.parallel([
          Animated.timing(opacity, {
            toValue: 0,
            duration: 180,
            useNativeDriver: true,
          }),
          Animated.timing(translateY, {
            toValue: -50,
            duration: 180,
            useNativeDriver: true,
          }),
        ]).start(() => setCurrent(null));
        return;
      }

      setCurrent(toast);
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.spring(translateY, {
          toValue: 0,
          friction: 8,
          tension: 45,
          useNativeDriver: true,
        }),
      ]).start();

      const duration = toast.duration ?? (toast.type === 'error' ? 5500 : 3500);
      timerRef.current = setTimeout(() => {
        hideToast();
      }, duration);
    };

    listeners.add(handler);
    return () => {
      listeners.delete(handler);
      clearTimeout(timerRef.current as number);
    };
  }, [opacity, translateY]);

  if (!current) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          opacity,
          transform: [{ translateY }],
          borderColor: BORDER_BY_TYPE[current.type] || COLORS.info,
        },
      ]}
      pointerEvents="box-none"
    >
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={hideToast}
        style={styles.inner}
      >
        <Text style={styles.icon}>{ICON_BY_TYPE[current.type] || 'ℹ️'}</Text>
        <View style={styles.textContainer}>
          <Text style={styles.title}>{current.title}</Text>
          {current.message ? (
            <Text style={styles.message}>{current.message}</Text>
          ) : null}
        </View>
        <Text style={styles.close}>✕</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 48,
    left: 14,
    right: 14,
    zIndex: 999999,
    backgroundColor: '#1e293be6', // slate-800 90% opacity
    borderRadius: 14,
    borderWidth: 1.5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 12,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 10,
  },
  icon: {
    fontSize: 20,
  },
  textContainer: {
    flex: 1,
  },
  title: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  message: {
    color: '#cbd5e1',
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
  },
  close: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: 'bold',
    padding: 4,
  },
});
