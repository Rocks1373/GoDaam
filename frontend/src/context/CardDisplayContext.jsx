import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

const STORAGE_KEY = 'godam_card_scale';
const MIN = 0;
const MAX = 4;
export const CARD_SCALE_DEFAULT = 2;

const LABELS = ['XS', 'S', 'M', 'L', 'XL'];

function readStored() {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    if (Number.isFinite(v) && v >= MIN && v <= MAX) return v;
  } catch {
    /* ignore */
  }
  return CARD_SCALE_DEFAULT;
}

const CardDisplayContext = createContext(null);

export function CardDisplayProvider({ children }) {
  const [scale, setScale] = useState(readStored);

  useLayoutEffect(() => {
    document.documentElement.dataset.cardScale = String(scale);
  }, [scale]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(scale));
    } catch {
      /* ignore */
    }
  }, [scale]);

  const increase = useCallback(() => setScale((s) => Math.min(MAX, s + 1)), []);
  const decrease = useCallback(() => setScale((s) => Math.max(MIN, s - 1)), []);
  const reset = useCallback(() => setScale(CARD_SCALE_DEFAULT), []);

  const value = useMemo(
    () => ({
      scale,
      sizeLabel: LABELS[scale],
      canDecrease: scale > MIN,
      canIncrease: scale < MAX,
      increase,
      decrease,
      reset,
    }),
    [scale, increase, decrease, reset]
  );

  return <CardDisplayContext.Provider value={value}>{children}</CardDisplayContext.Provider>;
}

export function useCardDisplay() {
  const ctx = useContext(CardDisplayContext);
  if (!ctx) {
    throw new Error('useCardDisplay must be used within CardDisplayProvider');
  }
  return ctx;
}
