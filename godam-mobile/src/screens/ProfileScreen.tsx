import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { View, Text, Pressable, StyleSheet, Alert, ScrollView } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { me } from '../api/authApi';
import { clearAuth, loadAuth, isExpiredIso } from '../storage/tokenStorage';
import { getApiBaseUrl, setAuthHeader } from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import type { ThemeDefinition, ThemeId } from '../theme/palettes';

type Props = NativeStackScreenProps<RootStackParamList, 'Profile'>;

function createProfileStyles(c: ThemeDefinition) {
  return StyleSheet.create({
    scroll: { flex: 1, backgroundColor: c.background },
    wrap: { padding: 20, paddingTop: 56, paddingBottom: 40 },
    h: { fontSize: 22, fontWeight: '800', color: c.text },
    meta: { marginTop: 12, color: c.textMuted },
    section: { marginTop: 28, fontSize: 15, fontWeight: '800', color: c.text },
    apiUrlLabel: { marginTop: 8, fontSize: 12, fontWeight: '600', color: c.textMuted },
    apiUrl: { marginTop: 6, fontSize: 13, color: c.textSecondary, lineHeight: 18 },
    btn: {
      marginTop: 24,
      backgroundColor: c.primary,
      padding: 14,
      borderRadius: 10,
      alignItems: 'center',
    },
    btnText: { color: '#fff', fontWeight: '700' },
    btnSecondary: {
      marginTop: 12,
      backgroundColor: c.surfaceMuted,
      padding: 14,
      borderRadius: 10,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.border,
    },
    btnSecondaryText: { fontWeight: '700', color: c.text },
    out: { marginTop: 16, padding: 14, alignItems: 'center' },
    outText: { color: c.danger, fontWeight: '700' },
    themeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
    themeChip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    themeChipActive: {
      borderColor: c.primaryBorder,
      backgroundColor: c.primarySoft,
    },
    themeChipText: { fontSize: 12, fontWeight: '700', color: c.textSecondary },
    themeChipTextActive: { color: c.primaryHover },
  });
}

export default function ProfileScreen({ navigation }: Props) {
  const { palette, themeId, setThemeId, labels, ids } = useTheme();
  const styles = useMemo(() => createProfileStyles(palette), [palette]);
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

      <Text style={styles.section}>Appearance</Text>
      <Text style={styles.apiUrlLabel}>Theme (saved on device)</Text>
      <View style={styles.themeRow}>
        {ids.map((id: ThemeId) => (
          <Pressable
            key={id}
            style={[styles.themeChip, themeId === id && styles.themeChipActive]}
            onPress={() => setThemeId(id)}
          >
            <Text style={[styles.themeChipText, themeId === id && styles.themeChipTextActive]}>{labels[id]}</Text>
          </Pressable>
        ))}
      </View>

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
