import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Platform,
  type TextInputProps,
} from 'react-native';

export type PartSuggestRow = {
  part_number: string;
  sap_part_number?: string | null;
  description?: string | null;
};

type PartSuggestInputProps = {
  value: string;
  onChangeText: (t: string) => void;
  fetchSuggest: (q: string) => Promise<PartSuggestRow[]>;
  onPick: (row: PartSuggestRow) => void;
  placeholder?: string;
  style?: TextInputProps['style'];
  autoCapitalize?: TextInputProps['autoCapitalize'];
  returnKeyType?: TextInputProps['returnKeyType'];
  onSubmitEditing?: TextInputProps['onSubmitEditing'];
  rightAccessory?: ReactNode;
  wrapStyle?: StyleProp<ViewStyle>;
};

/**
 * Debounced part-number typeahead. Keeps whatever the user types; choosing a row fills the field and calls onPick.
 */
export function PartSuggestInput({
  value,
  onChangeText,
  fetchSuggest,
  onPick,
  placeholder,
  style,
  autoCapitalize = 'characters',
  returnKeyType,
  onSubmitEditing,
  rightAccessory,
  wrapStyle,
}: PartSuggestInputProps) {
  const [suggestions, setSuggestions] = useState<PartSuggestRow[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const skipFetchOnce = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (skipFetchOnce.current) {
      skipFetchOnce.current = false;
      return;
    }
    const q = value.trim();
    const handle = setTimeout(async () => {
      if (q.length < 1) {
        if (mounted.current) {
          setSuggestions([]);
          setOpen(false);
        }
        return;
      }
      setSuggestLoading(true);
      try {
        const rows = await fetchSuggest(q);
        if (!mounted.current) return;
        setSuggestions(rows);
        setOpen(rows.length > 0);
      } catch {
        if (mounted.current) {
          setSuggestions([]);
          setOpen(false);
        }
      } finally {
        if (mounted.current) setSuggestLoading(false);
      }
    }, 280);
    return () => clearTimeout(handle);
  }, [value, fetchSuggest]);

  const pick = useCallback(
    (row: PartSuggestRow) => {
      skipFetchOnce.current = true;
      onChangeText(row.part_number);
      setSuggestions([]);
      setOpen(false);
      onPick(row);
    },
    [onChangeText, onPick]
  );

  return (
    <View style={[styles.wrap, wrapStyle]}>
      <View style={styles.inputOuter}>
        <TextInput
          style={[styles.input, style]}
          placeholder={placeholder}
          placeholderTextColor="#94a3b8"
          value={value}
          onChangeText={onChangeText}
          autoCapitalize={autoCapitalize}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          onFocus={() => {
            if (suggestions.length > 0) setOpen(true);
          }}
          autoCorrect={false}
        />
        <View style={styles.inputTrail}>
          {suggestLoading ? <ActivityIndicator size="small" color="#64748b" /> : null}
          {rightAccessory}
        </View>
      </View>
      {open && suggestions.length > 0 ? (
        <View style={styles.dropdown} pointerEvents="box-none">
          <FlatList
            data={suggestions}
            keyExtractor={(item, idx) => `${item.part_number}-${idx}`}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            style={styles.dropdownScroll}
            showsVerticalScrollIndicator
            initialNumToRender={16}
            maxToRenderPerBatch={24}
            windowSize={12}
            renderItem={({ item: s }) => (
              <Pressable
                style={({ pressed }) => [styles.sugRow, pressed && styles.sugRowPressed]}
                onPress={() => pick(s)}
              >
                <Text style={styles.sugPart}>{s.part_number}</Text>
                {s.sap_part_number ? (
                  <Text style={styles.sugMeta} numberOfLines={1}>
                    SAP {String(s.sap_part_number)}
                  </Text>
                ) : null}
                {s.description ? (
                  <Text style={styles.sugDesc} numberOfLines={2}>
                    {String(s.description)}
                  </Text>
                ) : null}
              </Pressable>
            )}
          />
        </View>
      ) : null}
    </View>
  );
}

type RackSuggestInputProps = {
  value: string;
  onChangeText: (t: string) => void;
  fetchSuggest: (q: string) => Promise<{ rack_location: string }[]>;
  onPick: (rackLocation: string) => void;
  placeholder?: string;
  style?: TextInputProps['style'];
  returnKeyType?: TextInputProps['returnKeyType'];
  onSubmitEditing?: TextInputProps['onSubmitEditing'];
  wrapStyle?: StyleProp<ViewStyle>;
};

export function RackSuggestInput({
  value,
  onChangeText,
  fetchSuggest,
  onPick,
  placeholder,
  style,
  returnKeyType,
  onSubmitEditing,
  wrapStyle,
}: RackSuggestInputProps) {
  const [suggestions, setSuggestions] = useState<{ rack_location: string }[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const skipFetchOnce = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (skipFetchOnce.current) {
      skipFetchOnce.current = false;
      return;
    }
    const q = value.trim();
    const handle = setTimeout(async () => {
      if (q.length < 1) {
        if (mounted.current) {
          setSuggestions([]);
          setOpen(false);
        }
        return;
      }
      setSuggestLoading(true);
      try {
        const rows = await fetchSuggest(q);
        if (!mounted.current) return;
        setSuggestions(rows);
        setOpen(rows.length > 0);
      } catch {
        if (mounted.current) {
          setSuggestions([]);
          setOpen(false);
        }
      } finally {
        if (mounted.current) setSuggestLoading(false);
      }
    }, 280);
    return () => clearTimeout(handle);
  }, [value, fetchSuggest]);

  const pick = useCallback(
    (rack: string) => {
      skipFetchOnce.current = true;
      onChangeText(rack);
      setSuggestions([]);
      setOpen(false);
      onPick(rack);
    },
    [onChangeText, onPick]
  );

  return (
    <View style={[styles.wrap, wrapStyle]}>
      <View style={styles.inputOuter}>
        <TextInput
          style={[styles.input, style]}
          placeholder={placeholder}
          placeholderTextColor="#94a3b8"
          value={value}
          onChangeText={onChangeText}
          autoCapitalize="characters"
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          onFocus={() => {
            if (suggestions.length > 0) setOpen(true);
          }}
          autoCorrect={false}
        />
        <View style={styles.inputTrail}>
          {suggestLoading ? <ActivityIndicator size="small" color="#64748b" /> : null}
        </View>
      </View>
      {open && suggestions.length > 0 ? (
        <View style={styles.dropdown}>
          <FlatList
            data={suggestions}
            keyExtractor={(item, idx) => `${item.rack_location}-${idx}`}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            style={styles.dropdownScroll}
            showsVerticalScrollIndicator
            initialNumToRender={20}
            maxToRenderPerBatch={32}
            windowSize={12}
            renderItem={({ item: s }) => (
              <Pressable
                style={({ pressed }) => [styles.sugRow, pressed && styles.sugRowPressed]}
                onPress={() => pick(s.rack_location)}
              >
                <Text style={styles.sugPart}>{s.rack_location}</Text>
              </Pressable>
            )}
          />
        </View>
      ) : null}
    </View>
  );
}

const shadow =
  Platform.OS === 'ios'
    ? {
        shadowColor: '#0f172a',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 8,
      }
    : { elevation: 4 };

const styles = StyleSheet.create({
  wrap: { position: 'relative', zIndex: 10 },
  inputOuter: { flexDirection: 'row', alignItems: 'center', position: 'relative' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    paddingRight: 40,
    backgroundColor: '#fff',
    fontSize: 16,
    color: '#0f172a',
  },
  inputTrail: {
    position: 'absolute',
    right: 10,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dropdown: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '100%',
    marginTop: 4,
    maxHeight: 400,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    zIndex: 100,
    ...shadow,
  },
  dropdownScroll: { maxHeight: 400 },
  sugRow: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  sugRowPressed: { backgroundColor: '#f1f5f9' },
  sugPart: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  sugMeta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  sugDesc: { fontSize: 13, color: '#475569', marginTop: 4, lineHeight: 18 },
});
