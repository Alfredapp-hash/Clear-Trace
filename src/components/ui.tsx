import Link from "next/link";
import { type ReactNode } from "react";

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
  return `inline-flex items-center justify-center gap-2 font-medium transition-all duration-200 disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`;
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
      className={`w-full rounded-xl border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 shadow-inner shadow-black/20 placeholder:text-slate-500 transition focus:border-teal-500/50 focus:bg-black/40 focus:outline-none focus:ring-2 focus:ring-teal-500/20 ${className}`}
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
      className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400"
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
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide ${tones[tone]}`}
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
      <span className={`h-1.5 w-1.5 rounded-full ${dot} shadow-[0_0_6px_currentColor]`} />
      {status.replaceAll("_", " ")}
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
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-400/90">
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
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </p>
      <p
        className={`mt-3 text-3xl font-semibold tracking-tight ${accent ? "text-teal-200" : "text-white"}`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
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
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
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
  const cls = `group flex items-center justify-between gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3.5 transition duration-200 hover:border-white/12 hover:bg-white/[0.04] ${className}`;
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
      <p className="mx-auto mt-2 max-w-sm text-sm text-slate-500">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </Card>
  );
}