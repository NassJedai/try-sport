export function PillToggle({
  pressed,
  onClick,
  disabled,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      disabled={disabled}
      className={`min-h-11 rounded-pill px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
        pressed ? 'bg-accent text-on-accent' : 'bg-surface-muted text-text-secondary'
      }`}
    >
      {children}
    </button>
  );
}
