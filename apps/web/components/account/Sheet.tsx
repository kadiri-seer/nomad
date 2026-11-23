"use client";

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="acct-overlay" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="acct-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="acct-handle" aria-hidden="true" />
        <div className="acct-between">
          <h2 className="acct-h2" style={{ margin: 0 }}>{title}</h2>
          <button type="button" className="acct-quiet" onClick={onClose}>Close</button>
        </div>
        {children}
      </section>
    </div>
  );
}

