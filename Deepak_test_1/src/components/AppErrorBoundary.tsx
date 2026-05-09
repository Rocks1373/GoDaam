import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, Platform } from 'react-native';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error.message, info.componentStack);
  }

  handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <View style={styles.wrap}>
          <Text style={styles.title}>GoDaam hit an error</Text>
          <Text style={styles.sub}>Copy this screen if you need support.</Text>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollInner}>
            <Text selectable style={styles.mono}>
              {error.name}: {error.message}
            </Text>
            {error.stack ? (
              <Text selectable style={styles.stack}>
                {error.stack}
              </Text>
            ) : null}
          </ScrollView>
          <Pressable style={styles.btn} onPress={this.handleRetry}>
            <Text style={styles.btnText}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    padding: 20,
    paddingTop: 56,
    backgroundColor: '#fef2f2',
    justifyContent: 'flex-start',
  },
  title: { fontSize: 18, fontWeight: '700', color: '#991b1b', marginBottom: 8 },
  sub: { fontSize: 14, color: '#64748b', marginBottom: 16 },
  scroll: { flex: 1 },
  scrollInner: { paddingBottom: 16 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 13, color: '#0f172a' },
  stack: {
    marginTop: 12,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 11,
    color: '#475569',
  },
  btn: {
    marginTop: 16,
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '700' },
});
