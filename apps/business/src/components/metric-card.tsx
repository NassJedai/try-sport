interface MetricCardProps {
  label: string;
  value: string | number | undefined;
  loading?: boolean;
  tone?: 'default' | 'success' | 'warning';
  hint?: string;
}

export function MetricCard({ label, value, loading, tone = 'default', hint }: MetricCardProps) {
  const toneClass = {
    default: 'text-ink-900',
    success: 'text-success',
    warning: 'text-warning',
  }[tone];

  return (
    <div className="rounded-card bg-surface p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</p>

      {loading ? (
        // Reserves the exact height of the value, so nothing shifts on load.
        <div className="mt-2 h-8 w-20 animate-pulse rounded bg-surface-muted" aria-hidden />
      ) : (
        <p className={`mt-1 text-3xl font-bold tabular-nums ${toneClass}`}>{value ?? '—'}</p>
      )}

      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}
