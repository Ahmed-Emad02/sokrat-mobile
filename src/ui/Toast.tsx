import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme, themedStyles, ThemeColors } from '../theme';
import { useI18n } from '../i18n';
import {
  AlertTriangleIcon,
  ZapIcon,
  CheckIcon,
  InfoIcon,
  CloseIcon,
} from './Icons';

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

function borderByType(type: ToastType, colors: ThemeColors) {
  switch (type) {
    case 'error': return colors.danger;
    case 'warning': return colors.warning;
    case 'success': return colors.success;
    default: return colors.brand;
  }
}

function renderToastIcon(type: ToastType, colors: ThemeColors) {
  switch (type) {
    case 'error': return <AlertTriangleIcon size={22} color={colors.dangerText} />;
    case 'warning': return <ZapIcon size={22} color={colors.warningText} />;
    case 'success': return <CheckIcon size={22} color={colors.successText} />;
    default: return <InfoIcon size={22} color={colors.brand} />;
  }
}

export function ToastContainer() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => themedStyles(rawStyles, colors), [colors]);
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
          borderColor: borderByType(current.type, colors),
        },
      ]}
      pointerEvents="box-none"
    >
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={hideToast}
        style={styles.inner}
      >
        <View style={styles.iconWrap}>{renderToastIcon(current.type, colors)}</View>
        <View style={styles.textContainer}>
          <Text style={styles.title}>{t(current.title)}</Text>
          {current.message ? (
            <Text style={styles.message}>{t(current.message)}</Text>
          ) : null}
        </View>
        <View style={styles.closeWrap}><CloseIcon size={14} color={colors.textDim} /></View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const rawStyles = StyleSheet.create({
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
  iconWrap: {
    justifyContent: 'center',
    alignItems: 'center',
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
  closeWrap: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 4,
  },
});
