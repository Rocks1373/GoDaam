import { Minus, Plus, RotateCcw } from 'lucide-react';
import { useCardDisplay } from '../context/CardDisplayContext';

/** Header control: smaller / larger display cards (stat + panel + toolbar density). */
export default function CardSizeControls() {
  const { sizeLabel, canDecrease, canIncrease, increase, decrease, reset } = useCardDisplay();

  return (
    <div
      className="inline-flex items-center rounded-md border border-theme-border bg-theme-muted overflow-hidden"
      title="Card size: stats, panels, page toolbars"
    >
      <button
        type="button"
        className="px-1.5 py-1 hover:bg-theme-card disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={decrease}
        disabled={!canDecrease}
        aria-label="Smaller cards"
      >
        <Minus size={14} className="text-theme-fg-secondary" />
      </button>
      <span className="px-1.5 text-[10px] font-bold text-theme-fg-muted tabular-nums min-w-[2rem] text-center border-x border-theme-border">
        {sizeLabel}
      </span>
      <button
        type="button"
        className="px-1.5 py-1 hover:bg-theme-card disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={increase}
        disabled={!canIncrease}
        aria-label="Larger cards"
      >
        <Plus size={14} className="text-theme-fg-secondary" />
      </button>
      <button
        type="button"
        className="px-1 py-1 border-l border-theme-border hover:bg-theme-card text-theme-fg-muted"
        onClick={reset}
        title="Reset card size to default (M)"
        aria-label="Reset card size"
      >
        <RotateCcw size={13} />
      </button>
    </div>
  );
}
