import { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { changePassword } from '../api/authApi';
import { useTheme } from '../theme/ThemeContext';
import type { ThemeDefinition } from '../theme/palettes';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

function createSettingsStyles(c: ThemeDefinition) {
  return StyleSheet.create({
    scroll: { flex: 1, backgroundColor: c.background },
    wrap: { padding: 20, paddingBottom: 40 },
    h: { fontSize: 22, fontWeight: '800', color: c.text },
    sub: { marginTop: 8, fontSize: 13, color: c.textMuted, lineHeight: 18 },
    section: { marginTop: 28, fontSize: 15, fontWeight: '800', color: c.text },
    label: { marginTop: 14, fontSize: 12, fontWeight: '700', color: c.textMuted },
    input: {
      marginTop: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 12,
      fontSize: 15,
      color: c.text,
      backgroundColor: c.surface,
    },
    btn: {
      marginTop: 24,
      backgroundColor: c.primary,
      padding: 14,
      borderRadius: 10,
      alignItems: 'center',
    },
    btnDisabled: { opacity: 0.55 },
    btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
    hint: { marginTop: 12, fontSize: 12, color: c.textMuted, lineHeight: 17 },
  });
}

export default function SettingsScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => createSettingsStyles(palette), [palette]);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async () => {
    if (!current.trim() || !next.trim()) {
      Alert.alert('Required', 'Enter your current password and a new password.');
      return;
    }
    if (next.length < 8) {
      Alert.alert('New password', 'Use at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      Alert.alert('Mismatch', 'New password and confirmation do not match.');
      return;
    }
    setBusy(true);
    try {
      await changePassword(current.trim(), next.trim());
      setCurrent('');
      setNext('');
      setConfirm('');
      Alert.alert('Updated', 'Your password was changed. Use the new password next time you log in.');
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } }; message?: string };
      const msg = ax.response?.data?.error || ax.message || 'Could not change password';
      Alert.alert('Error', msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <Text style={styles.h}>Settings</Text>
      <Text style={styles.sub}>Change the password for your account on this server.</Text>

      <Text style={styles.section}>Password</Text>
      <Text style={styles.label}>Current password</Text>
      <TextInput
        style={styles.input}
        value={current}
        onChangeText={setCurrent}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Current password"
        placeholderTextColor={palette.textMuted}
      />
      <Text style={styles.label}>New password (min. 8 characters)</Text>
      <TextInput
        style={styles.input}
        value={next}
        onChangeText={setNext}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="New password"
        placeholderTextColor={palette.textMuted}
      />
      <Text style={styles.label}>Confirm new password</Text>
      <TextInput
        style={styles.input}
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Repeat new password"
        placeholderTextColor={palette.textMuted}
      />
      <Text style={styles.hint}>
        After a successful change, your current session stays active. Other devices must log in again with the new
        password.
      </Text>

      <Pressable
        style={[styles.btn, busy && styles.btnDisabled]}
        onPress={() => void onSubmit()}
        disabled={busy}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Update password</Text>}
      </Pressable>
    </ScrollView>
  );
}
