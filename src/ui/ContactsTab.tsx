import React, { useState } from 'react';
import {
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../theme';
import { Contact } from '../storage/store';

type Props = {
  contacts: Contact[];
  onCallContact: (extension: string) => void;
  onSaveContact: (contact: Contact) => void;
  onDeleteContact: (id: string) => void;
  onToggleFavorite: (id: string) => void;
};

export function ContactsTab({
  contacts,
  onCallContact,
  onSaveContact,
  onDeleteContact,
  onToggleFavorite,
}: Props) {
  const [search, setSearch] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [name, setName] = useState('');
  const [extension, setExtension] = useState('');

  const filtered = contacts.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.extension.includes(search)
  ).sort((a, b) => {
    if (a.favorite && !b.favorite) return -1;
    if (!a.favorite && b.favorite) return 1;
    return a.name.localeCompare(b.name);
  });

  const handleAdd = () => {
    if (!name.trim() || !extension.trim()) return;
    onSaveContact({
      id: 'c_' + Date.now(),
      name: name.trim(),
      extension: extension.trim(),
      favorite: false,
    });
    setName('');
    setExtension('');
    setModalVisible(false);
  };

  return (
    <View style={styles.container}>
      {/* Top Search & Add Bar */}
      <View style={styles.topBar}>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search contacts…"
          placeholderTextColor={COLORS.textMuted}
        />
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => setModalVisible(true)}
        >
          <Text style={styles.addBtnText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      {filtered.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>👥</Text>
          <Text style={styles.emptyTitle}>No contacts found</Text>
          <Text style={styles.emptySub}>Tap "+ Add" to save a new contact</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <View style={styles.contactItem}>
              <TouchableOpacity
                style={styles.favBtn}
                onPress={() => onToggleFavorite(item.id)}
              >
                <Text style={[styles.favIcon, item.favorite && styles.favActive]}>
                  {item.favorite ? '★' : '☆'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.infoCol}
                onPress={() => onCallContact(item.extension)}
              >
                <Text style={styles.contactName}>{item.name}</Text>
                <Text style={styles.contactExt}>Ext: {item.extension}</Text>
              </TouchableOpacity>

              <View style={styles.actionsRow}>
                <TouchableOpacity
                  style={styles.callBtn}
                  onPress={() => onCallContact(item.extension)}
                >
                  <Text style={styles.callIcon}>📞</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.delBtn}
                  onPress={() => onDeleteContact(item.id)}
                >
                  <Text style={styles.delIcon}>🗑️</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      )}

      {/* Add Contact Modal */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New Contact</Text>

            <Text style={styles.modalLabel}>NAME</Text>
            <TextInput
              style={styles.modalInput}
              value={name}
              onChangeText={setName}
              placeholder="e.g. John Doe"
              placeholderTextColor={COLORS.textMuted}
            />

            <Text style={styles.modalLabel}>EXTENSION / PHONE</Text>
            <TextInput
              style={styles.modalInput}
              value={extension}
              onChangeText={setExtension}
              placeholder="e.g. 101 or 01011719380"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="phone-pad"
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setModalVisible(false)}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.saveBtn} onPress={handleAdd}>
                <Text style={styles.saveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
  },
  searchInput: {
    flex: 1,
    backgroundColor: COLORS.bgElevated,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderColor: COLORS.border,
    borderWidth: 1,
    fontSize: 14,
  },
  addBtn: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
  },
  addBtnText: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 13,
  },
  listContent: {
    paddingVertical: 6,
  },
  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
  },
  favBtn: {
    padding: 6,
  },
  favIcon: {
    fontSize: 22,
    color: COLORS.textMuted,
  },
  favActive: {
    color: COLORS.warn,
  },
  infoCol: {
    flex: 1,
    marginLeft: 10,
  },
  contactName: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '600',
  },
  contactExt: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  callBtn: {
    padding: 8,
    backgroundColor: '#064e3b',
    borderRadius: 20,
  },
  callIcon: {
    fontSize: 16,
  },
  delBtn: {
    padding: 8,
  },
  delIcon: {
    fontSize: 14,
    opacity: 0.6,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 48,
    opacity: 0.4,
    marginBottom: 16,
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
  },
  emptySub: {
    color: COLORS.textMuted,
    fontSize: 13,
    marginTop: 4,
    textAlign: 'center',
  },
  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: COLORS.bgElevated,
    borderRadius: 12,
    padding: 20,
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  modalTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  modalLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 8,
    marginBottom: 4,
  },
  modalInput: {
    backgroundColor: COLORS.bg,
    color: COLORS.text,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 20,
  },
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  cancelText: {
    color: COLORS.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  saveBtn: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  saveText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
  },
});
