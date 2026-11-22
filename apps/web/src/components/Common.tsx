import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Instance, SessionStatus } from '@nf-hub/protocol';
import { ApiError, errorMessage } from '../lib/errors';
import { connectionLabel, statusLabels } from '../lib/format';
import { Icon } from './Icon';

export function HeaderMenu({ label, icon, children, className = '' }: { label: string; icon: ReactNode; children: ReactNode; className?: string }) {
  const root = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && root.current) root.current.open = false;
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && root.current?.open) {
        event.preventDefault(); root.current.open = false; root.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard); };
  }, [open]);
  return <details ref={root} className={`header-menu ${className}`} onToggle={event => setOpen(event.currentTarget.open)} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }} onClick={event => {
    if (event.target instanceof Element && event.target.closest('[data-close-menu]') && root.current) {
      root.current.open = false; root.current.querySelector('summary')?.focus();
    }
  }}><summary className="icon-button" aria-label={label} title={label}>{icon}</summary><div className="header-popover" aria-label={label}>{children}</div></details>;
}

export function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}
export function ErrorBanner({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return <div className="notice notice-error" role="alert"><div>{errorMessage(error)}{error instanceof ApiError && <small>错误码：{error.code}</small>}</div>{retry && <button className="button small secondary" onClick={retry}>重试</button>}</div>;
}
export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol"><Icon name="grid" size={26} /></div><h2>{title}</h2><p>{detail}</p>{action}</div>;
}
export function ConnectionPill({ instance }: { instance: Instance }) {
  const tone = instance.connection === 'connected' && instance.freshness === 'fresh' && !instance.lastError ? 'good' : instance.connection === 'lost' || instance.freshness === 'stale' ? 'warning' : 'neutral';
  return <span className={`pill ${tone}`}><span className="status-dot" />{connectionLabel(instance)}</span>;
}
export function SessionPill({ status, old = false }: { status: SessionStatus; old?: boolean }) {
  return <span className={`pill ${old ? 'neutral' : status === 'working' ? 'teal' : status === 'waiting' ? 'warning' : 'neutral'}`}><span className="status-dot" />{statusLabels[status]}</span>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const headingId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = panel.current;
    dialog?.querySelector<HTMLElement>('input, button, select, textarea, [tabindex="0"]')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous instanceof HTMLElement) previous.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop"><div ref={panel} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={headingId}>
    <div className="modal-heading"><h2 id={headingId}>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><Icon name="close" /></button></div>{children}
  </div></div>;
}
