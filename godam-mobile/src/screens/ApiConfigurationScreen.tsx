import axios from 'axios';
import { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { persistAndConfigureApiBase, setAuthHeader } from '../api/client';
import { normalizeToApiBase } from '../config/apiConfig';
import { clearAuth } from '../storage/tokenStorage';
import { getSavedBackendApiUrl } from '../storage/backendUrlStorage';

type Props = NativeStackScreenProps<RootStackParamList, 'ApiConfiguration'>;

function healthLooksOk(data: Record<string, unknown>): boolean {
  if (data?.status === 'ok') return true;
  if (typeof data?.message === 'string' && /godam api/i.test(data.message)) return true;
  return data?.ok === true || data?.service === 'warehouse-backend';
}

export default function ApiConfigurationScreen({ navigation }: Props) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const saved = await getSavedBackendApiUrl();
      setUrl(saved || '');
    })();
  }, []);

  const testConnection = async () => {
    const base = normalizeToApiBase(url);
    if (!base) {
      Alert.alert(
        'Invalid URL',
        'Enter your Backend API Base URL, e.g.\nhttps://godam.divadivya.cloud/api'
      );
      return;
    }
    setBusy(true);
    try {
      const client = axios.create({ baseURL: base, timeout: 30000 });
      const res = await client.get('/health');
      const data = res.data as Record<string, unknown>;
      const ok = res.status === 200 && healthLooksOk(data);
      if (ok) Alert.alert('Success', 'Connected — health check passed.');
      else Alert.alert('Unexpected response', JSON.stringify(data).slice(0, 280));
    } catch (e: unknown) {
      const ax = e as { message?: string };
      Alert.alert('Connection failed', ax.message || 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const saveAndContinue = async () => {
    const base = normalizeToApiBase(url);
    if (!base) {
      Alert.alert(
        'Invalid URL',
        'Backend API Base URL must include the /api path (same as the web app API prefix).'
      );
      return;
    }
    try {
      const prev = await getSavedBackendApiUrl();
      await persistAndConfigureApiBase(base);
      if (prev != null && prev !== base) {
        await clearAuth();
        setAuthHeader(null);
      }
      navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not save URL';
      Alert.alert('Save failed', msg);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.h}>Configuration</Text>
        <Text style={styles.sub}>
          Enter your Backend API Base URL (must end with <Text style={styles.mono}>/api</Text>). One URL is used for
          login, orders, receiving, delivery, and all other features. Use HTTPS on port 443 if mobile data blocks other
          ports. For GoDaam, use <Text style={styles.mono}>https://godam.divadivya.cloud/api</Text>.
        </Text>
        <Text style={styles.label}>Backend API Base URL</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://godam.divadivya.cloud/api"
          placeholderTextColor="#94a3b8"
        />
        <Text style={styles.hint}>Example: https://godam.divadivya.cloud/api</Text>
        <Pressable style={styles.btnSecondary} onPress={testConnection} disabled={busy}>
          {busy ? (
            <ActivityIndicator color="#1e40af" />
          ) : (
            <Text style={styles.btnSecondaryText}>Test Connection</Text>
          )}
        </Pressable>
        <Pressable style={styles.btn} onPress={saveAndContinue} disabled={busy}>
          <Text style={styles.btnText}>Save & Continue</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#f8fafc' },
  scroll: { padding: 24, paddingTop: 48 },
  h: { fontSize: 22, fontWeight: '800', color: '#0f172a' },
  sub: { marginTop: 10, marginBottom: 14, fontSize: 14, color: '#64748b', lineHeight: 20 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13 },
  label: { fontSize: 13, fontWeight: '700', color: '#334155', marginBottom: 6 },
  hint: { fontSize: 12, color: '#94a3b8', marginBottom: 14 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    backgroundColor: '#fff',
    marginBottom: 6,
  },
  btn: {
    backgroundColor: '#2563eb',
    padding: 16,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  btnSecondary: {
    borderWidth: 1,
    borderColor: '#93c5fd',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#eff6ff',
    marginBottom: 8,
    minHeight: 48,
    justifyContent: 'center',
  },
  btnSecondaryText: { color: '#1d4ed8', fontWeight: '700' },
});
