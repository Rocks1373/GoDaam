import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { me } from '../api/authApi';
import { clearAuth, loadAuth, isExpiredIso } from '../storage/tokenStorage';
import { setAuthHeader } from '../api/client';

type Props = NativeStackScreenProps<RootStackParamList, 'Profile'>;

export default function ProfileScreen({ navigation }: Props) {
  const [label, setLabel] = useState('');

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
    <View style={styles.wrap}>
      <Text style={styles.h}>Profile</Text>
      <Text style={styles.meta}>{label}</Text>
      <Pressable style={styles.btn} onPress={() => Alert.alert('Token', 'Rotate via login refresh endpoint when wired.')}>
        <Text style={styles.btnText}>Session info</Text>
      </Pressable>
      <Pressable style={styles.out} onPress={logout}>
        <Text style={styles.outText}>Logout</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 20, paddingTop: 56, backgroundColor: '#f8fafc' },
  h: { fontSize: 22, fontWeight: '800' },
  meta: { marginTop: 12, color: '#475569' },
  btn: {
    marginTop: 24,
    backgroundColor: '#e2e8f0',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnText: { fontWeight: '700' },
  out: { marginTop: 16, padding: 14, alignItems: 'center' },
  outText: { color: '#b91c1c', fontWeight: '700' },
});
