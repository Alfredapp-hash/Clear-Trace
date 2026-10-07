import Link from "next/link";
import { type ReactNode } from "react";
import { shortStatusLabel } from "@/lib/ux/plain-status";

type CardVariant = "default" | "elevated" | "accent" | "warning" | "danger";

export function Card({
  children,
  className = "",
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
  variant?: CardVariant;
}) {
  const variants: Record<CardVariant, string> = {
    default: "ct-glass rounded-2xl p-5 shadow-[0_8px_32px_-12px_rgba(0,0,0,0.45)]",
    elevated: "ct-glass-strong ct-shine rounded-2xl p-6",
    accent:
      "rounded-2xl border border-teal-500/20 bg-gradient-to-br from-teal-500/10 via-transparent to-transparent p-5 shadow-[0_0_40px_-12px_rgba(45,212,191,0.25)]",
    warning:
      "rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 via-transparent to-transparent p-5",
    danger:
      "rounded-2xl border border-rose-500/20 bg-gradient-to-br from-rose-500/10 via-transparent to-transparent p-5",
  };
  return <div className={`${variants[variant]} ${className}`}>{children}</div>;
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-gradient-to-b from-teal-300 to-teal-500 text-slate-950 shadow-[0_0_24px_-4px_var(--accent-glow)] hover:from-teal-200 hover:to-teal-400 hover:shadow-[0_0_32px_-4px_var(--accent-glow)] disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 disabled:shadow-none",
  secondary: "ct-glass text-slate-100 hover:border-white/20 hover:bg-white/[0.06]",
  ghost: "bg-transparent text-slate-300 hover:bg-white/[0.05] hover:text-white",
  danger:
    "bg-gradient-to-b from-rose-500 to-rose-600 text-white shadow-[0_0_20px_-6px_rgba(251,113,133,0.5)] hover:from-rose-400 hover:to-rose-500",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "rounded-lg px-3 py-1.5 text-xs",
  md: "rounded-xl px-4 py-2.5 text-sm",
  lg: "rounded-xl px-5 py-3 text-sm",
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  className = "",
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return `inline-flex items-center justify-center gap-2 font-medium transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300 disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`;
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button type={type} className={buttonClasses({ variant, size, className })} {...props}>
      {children}
    </button>
  );
}

/**
 * A link styled as a button. Use instead of nesting <Button> inside <Link>/<a>
 * (nested interactive elements are invalid HTML and confuse assistive tech).
 * Internal paths use next/link; anything else renders a plain anchor.
 */
export function ButtonLink({
  href,
  children,
  variant = "primary",
  size = "md",
  className = "",
  external = false,
  download,
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  /** Open in a new tab with rel="noopener noreferrer". */
  external?: boolean;
  download?: boolean | string;
}) {
  const cls = buttonClasses({ variant, size, className });
  const isInternal = href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/api/");
  if (isInternal && !external && download === undefined) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      className={cls}
      download={download === true ? "" : download || undefined}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

export function Input({
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-xl border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 shadow-inner shadow-black/20 placeholder:text-[var(--muted)] transition focus:border-teal-500/50 focus:bg-black/40 focus:ring-2 focus:ring-teal-500/60 ${className}`}
      {...props}
    />
  );
}

export function Label({
  children,
  htmlFor,
}: {
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-300"
    >
      {children}
    </label>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  const tones = {
    neutral: "border-white/10 bg-white/5 text-slate-300",
    success: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
    warning: "border-amber-500/20 bg-amber-500/10 text-amber-200",
    danger: "border-rose-500/20 bg-rose-500/10 text-rose-300",
    info: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  removed_confirmed: "success",
  consent_verified: "success",
  draft: "neutral",
  paused: "neutral",
  archived: "neutral",
  reopened: "danger",
  follow_up_eligible: "warning",
  candidate_review: "warning",
  verification_due: "warning",
};

export function StatusBadge({ status }: { status: string }) {
  let tone = STATUS_TONES[status] ?? "info";
  if (!STATUS_TONES[status]) {
    if (status.includes("review") || status.includes("awaiting")) tone = "warning";
  }
  const dot =
    tone === "success"
      ? "bg-emerald-400"
      : tone === "warning"
        ? "bg-amber-400"
        : tone === "danger"
          ? "bg-rose-400"
          : "bg-sky-400";
  return (
    <Badge tone={tone}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot} shadow-[0_0_6px_currentColor]`} />
      {shortStatusLabel(status)}
    </Badge>
  );
}

export function PageHeader({
  title,
  description,
  eyebrow,
  action,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
      <div className="max-w-2xl">
        {eyebrow && (
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-teal-300">
            {eyebrow}
          </p>
        )}
        <h1 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">
          {title}
        </h1>
        {description && (
          <p className="mt-2 text-base leading-relaxed text-slate-400">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Card
      variant={accent ? "accent" : "default"}
      className="ct-animate-in group transition duration-300 hover:border-white/15"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
        {label}
      </p>
      <p
        className={`mt-3 text-3xl font-semibold tracking-tight ${accent ? "text-teal-200" : "text-white"}`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
    </Card>
  );
}

export function SectionTitle({
  children,
  subtitle,
  action,
}: {
  children: ReactNode;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-medium tracking-tight text-white">{children}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-[var(--muted)]">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "warning" | "success";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const variant = tone === "warning" ? "warning" : tone === "success" ? "accent" : "default";
  return (
    <Card variant={variant} className="ct-animate-in">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="font-medium text-white">{title}</h3>
          {children && (
            <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{children}</p>
          )}
        </div>
        {action}
      </div>
    </Card>
  );
}

export function ListRow({
  href,
  children,
  className = "",
}: {
  href?: string;
  children: ReactNode;
  className?: string;
}) {
  const cls = `group flex items-center justify-between gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3.5 transition duration-200 hover:border-white/12 hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300 ${className}`;
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return <div className={cls}>{children}</div>;
}

export function PhaseHeader({
  phase,
  title,
  action,
}: {
  phase: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-4">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-teal-500/30 bg-teal-500/10 text-xs font-bold text-teal-300">
          {phase}
        </span>
        <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-300">
          {title}
        </h3>
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Card variant="elevated" className="py-12 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
        <span className="text-2xl opacity-60">◇</span>
      </div>
      <h3 className="text-lg font-medium text-white">{title}</h3>
      <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--muted)]">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </Card>
  );
}
/* ------------------------------------------------------------------------------------
 * Feedback primitives. These stay hook-free (ui.tsx is also imported by server pages);
 * state lives in the caller (see useToasts in components/case/useCaseMutations.ts).
 * ---------------------------------------------------------------------------------- */

export type ToastTone = "success" | "error" | "info";

export interface ToastView {
  id: number;
  tone: ToastTone;
  text: string;
  /** Adds an inline link to /billing (402 responses). */
  billing?: boolean;
  /** One optional action, e.g. Undo. */
  action?: { label: string; onClick: () => void };
}

const TOAST_TONES: Record<ToastTone, string> = {
  success: "border-emerald-500/30 bg-slate-950/95 text-emerald-100",
  info: "border-sky-500/30 bg-slate-950/95 text-slate-100",
  error: "border-rose-500/40 bg-rose-950/95 text-rose-100",
};

/** Pause / resume a toast's auto-dismiss timer while the pointer or focus is on it. */
export interface ToastHoldHandlers {
  onHold?: (id: number) => void;
  onRelease?: (id: number) => void;
}

function ToastItem({
  toast,
  onDismiss,
  onHold,
  onRelease,
}: { toast: ToastView; onDismiss: (id: number) => void } & ToastHoldHandlers) {
  // Resume only when neither the pointer nor focus is still on the toast.
  const release = (el: HTMLElement, focusLeaving: boolean) => {
    const focused = !focusLeaving && el.contains(document.activeElement);
    const hovered = focusLeaving && el.matches(":hover");
    if (!focused && !hovered) onRelease?.(toast.id);
  };
  return (
    <div
      data-toast-tone={toast.tone}
      onMouseEnter={() => onHold?.(toast.id)}
      onMouseLeave={(e) => release(e.currentTarget, false)}
      onFocus={() => onHold?.(toast.id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release(e.currentTarget, true);
      }}
      className={`pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-[0_12px_40px_-12px_rgba(0,0,0,0.7)] backdrop-blur ${TOAST_TONES[toast.tone]}`}
    >
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {toast.tone === "success" && <span aria-hidden="true">✓ </span>}
        {toast.text}
        {toast.billing && (
          <>
            {" "}
            <Link href="/billing" className="font-medium underline underline-offset-2">
              See plans on Billing
            </Link>
          </>
        )}
      </p>
      {toast.action && (
        <button
          type="button"
          onClick={toast.action.onClick}
          className="shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold underline underline-offset-2 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-teal-300"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="shrink-0 rounded-md px-1.5 text-xs opacity-70 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-teal-300"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Fixed bottom notification region. Always rendered (live regions must exist before
 * content is added): results are announced politely, errors assertively, and both are
 * visible without scrolling, however long the page is.
 */
export function ToastRegion({
  toasts,
  onDismiss,
  onHold,
  onRelease,
}: {
  toasts: ReadonlyArray<ToastView>;
  onDismiss: (id: number) => void;
} & ToastHoldHandlers) {
  const errors = toasts.filter((t) => t.tone === "error");
  const others = toasts.filter((t) => t.tone !== "error");
  return (
    <div
      data-testid="toast-region"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pb-4 sm:items-end sm:px-6"
    >
      <div role="status" aria-live="polite" className="flex w-full flex-col items-center gap-2 sm:items-end">
        {others.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} onHold={onHold} onRelease={onRelease} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" className="flex w-full flex-col items-center gap-2 sm:items-end">
        {errors.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} onHold={onHold} onRelease={onRelease} />
        ))}
      </div>
    </div>
  );
}

/**
 * Opens a <dialog> modally once it mounts and, when it unmounts, returns focus to whatever
 * had it before (the button that opened it). A ref callback with a React 19 cleanup, so
 * ui.tsx stays hook-free for server pages. Exported for tests.
 */
export function openModal(el: HTMLDialogElement | null): (() => void) | undefined {
  if (!el) return undefined;
  const doc = el.ownerDocument;
  const active = doc?.activeElement;
  const trigger = active && active !== doc.body && !el.contains(active) ? (active as HTMLElement) : null;
  if (!el.open && typeof el.showModal === "function") el.showModal();
  return () => {
    if (el.open && typeof el.close === "function") el.close();
    if (trigger?.isConnected && typeof trigger.focus === "function") trigger.focus();
  };
}

/**
 * Accessible confirmation dialog (native <dialog>: focus is trapped, Escape cancels, and
 * focus goes back to the opening control on close). Replaces window.confirm(). Render it
 * with `open` from the caller's state.
 */
export function ConfirmDialog({
  open,
  id = "confirm-dialog",
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  id?: string;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  /** Keep the confirm button disabled (say why in `message`). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <dialog
      ref={openModal}
      id={id}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-message`}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-white/10 bg-slate-950 p-6 text-slate-100 shadow-2xl backdrop:bg-black/60"
    >
      <h2 id={`${id}-title`} className="text-base font-semibold text-white">
        {title}
      </h2>
      <div id={`${id}-message`} className="mt-2 text-sm leading-relaxed text-slate-300">
        {message}
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} autoFocus>
          {cancelLabel}
        </Button>
        <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} disabled={confirmDisabled}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

/** Result of the last action on one row, keyed by the mutation's loading key. */
export type InlineResultView =
  | { kind: "saved"; at: number }
  | { kind: "error"; text: string; at: number };

/**
 * Per-row outcome next to the control that caused it: a "Saved" check, or the error with
 * a Retry button. Announcement happens in the toast region; this keeps the result in place.
 */
export function InlineResult({
  result,
  onRetry,
}: {
  result: InlineResultView | undefined;
  onRetry?: () => void;
}) {
  if (!result) return null;
  if (result.kind === "saved") {
    return (
      <span data-inline-result="saved" className="inline-flex items-center gap-1 text-xs text-emerald-300">
        <span aria-hidden="true">✓</span> Saved
      </span>
    );
  }
  return (
    <span
      data-inline-result="error"
      className="inline-flex flex-wrap items-center gap-2 text-xs text-rose-300 [overflow-wrap:anywhere]"
    >
      <span>{result.text}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-rose-400/30 px-2 py-0.5 font-medium text-rose-100 hover:bg-rose-500/10 focus-visible:outline-2 focus-visible:outline-teal-300"
        >
          Retry
        </button>
      )}
    </span>
  );
}

/** "12 of 34 brokers done" with a bar. */
export function ProgressMeter({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label: string;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <p className="text-sm font-medium text-slate-200">{label}</p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]"
      >
        <div className="h-full rounded-full bg-teal-400 transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
