import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { View, Text, Pressable, StyleSheet, Alert, ScrollView } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { me } from '../api/authApi';
import { clearAuth, loadAuth, isExpiredIso } from '../storage/tokenStorage';
import { getApiBaseUrl, setAuthHeader } from '../api/client';

type Props = NativeStackScreenProps<RootStackParamList, 'Profile'>;

export default function ProfileScreen({ navigation }: Props) {
  const [label, setLabel] = useState('');
  const [apiBase, setApiBase] = useState('');

  useFocusEffect(
    useCallback(() => {
      setApiBase(getApiBaseUrl());
    }, [])
  );

  useEffect(() => {
    (async () => {
      try {
        const { expiresAt } = await loadAuth();
        if (isExpiredIso(expiresAt)) {
          await clearAuth();
          setAuthHeader(null);
          navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
          return;
        }
        const { user } = await me();
        setLabel(`${user.full_name || user.username} (${user.role})`);
      } catch {
        setLabel('—');
      }
    })();
  }, [navigation]);

  const logout = async () => {
    await clearAuth();
    setAuthHeader(null);
    navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.wrap}>
      <Text style={styles.h}>Profile</Text>
      <Text style={styles.meta}>{label}</Text>
      <Text style={styles.section}>Server settings</Text>
      <Text style={styles.apiUrlLabel}>Backend API Base URL</Text>
      <Text style={styles.apiUrl} selectable>
        {apiBase || '—'}
      </Text>
      <Pressable style={styles.btn} onPress={() => navigation.navigate('ApiConfiguration')}>
        <Text style={styles.btnText}>Change Backend API URL</Text>
      </Pressable>
      <Pressable style={styles.btnSecondary} onPress={() => Alert.alert('Token', 'Rotate via login refresh endpoint when wired.')}>
        <Text style={styles.btnSecondaryText}>Session info</Text>
      </Pressable>
      <Pressable style={styles.out} onPress={logout}>
        <Text style={styles.outText}>Logout</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#f8fafc' },
  wrap: { padding: 20, paddingTop: 56, paddingBottom: 40 },
  h: { fontSize: 22, fontWeight: '800' },
  meta: { marginTop: 12, color: '#475569' },
  section: { marginTop: 28, fontSize: 15, fontWeight: '800', color: '#0f172a' },
  apiUrlLabel: { marginTop: 8, fontSize: 12, fontWeight: '600', color: '#64748b' },
  apiUrl: { marginTop: 6, fontSize: 13, color: '#334155', lineHeight: 18 },
  btn: {
    marginTop: 24,
    backgroundColor: '#2563eb',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '700' },
  btnSecondary: {
    marginTop: 12,
    backgroundColor: '#e2e8f0',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnSecondaryText: { fontWeight: '700', color: '#0f172a' },
  out: { marginTop: 16, padding: 14, alignItems: 'center' },
  outText: { color: '#b91c1c', fontWeight: '700' },
});
