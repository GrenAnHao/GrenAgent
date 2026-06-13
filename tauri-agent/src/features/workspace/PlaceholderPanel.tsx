export function PlaceholderPanel({ title }: { title: string }) {
  return (
    <div
      data-testid="placeholder-panel"
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--gren-fg-muted, #9aa1ac)',
        fontSize: 14,
      }}
    >
      {title} · 即将上线
    </div>
  );
}
