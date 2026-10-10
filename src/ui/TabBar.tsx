import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../theme';
import {
  KeypadIcon,
  HistoryIcon,
  ContactsIcon,
  SettingsIcon,
} from './Icons';

export type TabId = 'keypad' | 'recents' | 'contacts' | 'settings';

type Props = {
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  unreadMissedCount?: number;
};

export function TabBar({ activeTab, onSelectTab, unreadMissedCount = 0 }: Props) {
  const renderTabIcon = (id: TabId, color: string) => {
    switch (id) {
      case 'keypad': return <KeypadIcon size={20} color={color} />;
      case 'recents': return <HistoryIcon size={20} color={color} />;
      case 'contacts': return <ContactsIcon size={20} color={color} />;
      case 'settings': return <SettingsIcon size={20} color={color} />;
    }
  };

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'keypad', label: 'Keypad' },
    { id: 'recents', label: 'Recents' },
    { id: 'contacts', label: 'Contacts' },
    { id: 'settings', label: 'Settings' },
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
              <View style={{ alignItems: 'center', justifyContent: 'center' }}>
                {renderTabIcon(t.id, isActive ? COLORS.accent : COLORS.textMuted)}
              </View>
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
