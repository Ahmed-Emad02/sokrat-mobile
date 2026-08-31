import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../theme';

export type TabId = 'keypad' | 'recents' | 'contacts' | 'settings';

type Props = {
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  unreadMissedCount?: number;
};

export function TabBar({ activeTab, onSelectTab, unreadMissedCount = 0 }: Props) {
  const tabs: Array<{ id: TabId; label: string; icon: string }> = [
    { id: 'keypad', label: 'Keypad', icon: '🔢' },
    { id: 'recents', label: 'Recents', icon: '🕒' },
    { id: 'contacts', label: 'Contacts', icon: '👥' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];

  return (
    <View style={styles.container}>
      {tabs.map((t) => {
        const isActive = activeTab === t.id;
        return (
          <TouchableOpacity
            key={t.id}
            style={[styles.tabBtn, isActive && styles.tabBtnActive]}
            onPress={() => onSelectTab(t.id)}
          >
            <View>
              <Text style={[styles.tabIcon, isActive && styles.tabIconActive]}>
                {t.icon}
              </Text>
              {t.id === 'recents' && unreadMissedCount > 0 && (
                <View style={styles.badgeCircle}>
                  <Text style={styles.badgeText}>{unreadMissedCount}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
              {t.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: COLORS.bgElevated,
    borderTopColor: COLORS.border,
    borderTopWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    justifyContent: 'space-around',
  },
  tabBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  tabBtnActive: {
    backgroundColor: COLORS.surface,
  },
  tabIcon: {
    fontSize: 20,
    opacity: 0.6,
  },
  tabIconActive: {
    opacity: 1.0,
  },
  tabLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 3,
  },
  tabLabelActive: {
    color: COLORS.accent,
    fontWeight: '700',
  },
  badgeCircle: {
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: COLORS.danger,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
});
