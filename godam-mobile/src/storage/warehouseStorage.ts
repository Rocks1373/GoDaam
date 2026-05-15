import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'godam_selected_warehouse_id';

export async function getSelectedWarehouseId(): Promise<number | null> {
  const raw = await AsyncStorage.getItem(KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function setSelectedWarehouseId(id: number | null): Promise<void> {
  if (id == null || !Number.isFinite(id) || id <= 0) {
    await AsyncStorage.removeItem(KEY);
    return;
  }
  await AsyncStorage.setItem(KEY, String(id));
}
