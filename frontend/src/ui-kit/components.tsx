import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect
} from "react";

export type UiTheme = "warm" | "dark";
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  loading = false,
  className = "",
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`ui-button ui-button--${variant} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading}
      {...props}
    >
      {loading ? <span className="ui-button__loader" aria-hidden="true" /> : null}
      <span>{loading ? "处理中" : children}</span>
    </button>
  );
}

interface PanelProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Panel({
  title,
  description,
  actions,
  children,
  className = ""
}: PanelProps) {
  return (
    <section className={`ui-panel ${className}`.trim()}>
      {title || actions ? (
        <div className="ui-panel__header">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="ui-panel__actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="ui-panel__body">{children}</div>
    </section>
  );
}

interface FieldShellProps {
  label: string;
  htmlFor: string;
  helper?: string;
  error?: string;
  children: ReactNode;
}

function FieldShell({
  label,
  htmlFor,
  helper,
  error,
  children
}: FieldShellProps) {
  const messageId = `${htmlFor}-message`;
  return (
    <div className={`ui-field ${error ? "ui-field--error" : ""}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <p id={messageId} className="ui-field__error">
          {error}
        </p>
      ) : helper ? (
        <p id={messageId} className="ui-field__helper">
          {helper}
        </p>
      ) : null}
    </div>
  );
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  helper?: string;
  error?: string;
}

export function TextField({
  label,
  helper,
  error,
  id,
  className = "",
  ...props
}: TextFieldProps) {
  const inputId = id || `field-${props.name || "input"}`;
  return (
    <FieldShell
      label={label}
      htmlFor={inputId}
      helper={helper}
      error={error}
    >
      <input
        id={inputId}
        className={`ui-input ${className}`.trim()}
        aria-invalid={Boolean(error)}
        aria-describedby={helper || error ? `${inputId}-message` : undefined}
        {...props}
      />
    </FieldShell>
  );
}

interface TextAreaFieldProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  helper?: string;
  error?: string;
}

export function TextAreaField({
  label,
  helper,
  error,
  id,
  className = "",
  ...props
}: TextAreaFieldProps) {
  const inputId = id || `field-${props.name || "textarea"}`;
  return (
    <FieldShell
      label={label}
      htmlFor={inputId}
      helper={helper}
      error={error}
    >
      <textarea
        id={inputId}
        className={`ui-textarea ${className}`.trim()}
        aria-invalid={Boolean(error)}
        aria-describedby={helper || error ? `${inputId}-message` : undefined}
        {...props}
      />
    </FieldShell>
  );
}

interface SelectFieldProps
  extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  helper?: string;
  error?: string;
  children: ReactNode;
}

export function SelectField({
  label,
  helper,
  error,
  id,
  className = "",
  children,
  ...props
}: SelectFieldProps) {
  const inputId = id || `field-${props.name || "select"}`;
  return (
    <FieldShell
      label={label}
      htmlFor={inputId}
      helper={helper}
      error={error}
    >
      <select
        id={inputId}
        className={`ui-select ${className}`.trim()}
        aria-invalid={Boolean(error)}
        aria-describedby={helper || error ? `${inputId}-message` : undefined}
        {...props}
      >
        {children}
      </select>
    </FieldShell>
  );
}

interface TabsProps {
  items: Array<{ id: string; label: string; count?: number }>;
  active: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}

export function Tabs({ items, active, onChange, ariaLabel }: TabsProps) {
  return (
    <div className="ui-tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.id}
          className={active === item.id ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={active === item.id}
          onClick={() => onChange(item.id)}
        >
          <span>{item.label}</span>
          {typeof item.count === "number" ? <b>{item.count}</b> : null}
        </button>
      ))}
    </div>
  );
}

interface StatusTagProps {
  tone?: StatusTone;
  children: ReactNode;
}

export function StatusTag({
  tone = "neutral",
  children
}: StatusTagProps) {
  return (
    <span className={`ui-status ui-status--${tone}`}>{children}</span>
  );
}

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="ui-modal-layer" role="presentation">
      <button
        className="ui-modal-layer__backdrop"
        type="button"
        aria-label="关闭弹窗"
        onClick={onClose}
      />
      <section
        className="ui-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ui-modal-title"
      >
        <header className="ui-modal__header">
          <div>
            <h2 id="ui-modal-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </header>
        <div className="ui-modal__body">{children}</div>
        {footer ? <footer className="ui-modal__footer">{footer}</footer> : null}
      </section>
    </div>
  );
}

interface ToastProps {
  visible: boolean;
  tone?: StatusTone;
  title: string;
  message: string;
  onClose: () => void;
}

export function Toast({
  visible,
  tone = "success",
  title,
  message,
  onClose
}: ToastProps) {
  if (!visible) return null;
  return (
    <div
      className={`ui-toast ui-toast--${tone}`}
      role="status"
      aria-live="polite"
    >
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      <button type="button" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({
  title,
  description,
  action
}: EmptyStateProps) {
  return (
    <div className="ui-empty">
      <div className="ui-empty__mark" aria-hidden="true">
        GJ
      </div>
      <strong>{title}</strong>
      <p>{description}</p>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="ui-skeleton-list" aria-label="内容加载中" aria-busy="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="ui-skeleton-row" key={index}>
          <span className="ui-skeleton ui-skeleton--avatar" />
          <span className="ui-skeleton-lines">
            <i className="ui-skeleton ui-skeleton--wide" />
            <i className="ui-skeleton ui-skeleton--short" />
          </span>
          <span className="ui-skeleton ui-skeleton--action" />
        </div>
      ))}
    </div>
  );
}

interface AppShellProps {
  theme: UiTheme;
  onThemeChange: (theme: UiTheme) => void;
  children: ReactNode;
}

const NAV_ITEMS = [
  ["overview", "概览", "总"],
  ["tokens", "设计 Token", "规"],
  ["actions", "按钮与表单", "表"],
  ["data", "数据展示", "数"],
  ["states", "系统状态", "态"]
];

export function AppShell({
  theme,
  onThemeChange,
  children
}: AppShellProps) {
  return (
    <div className="ui-app-shell">
      <aside className="ui-sidebar">
        <a className="ui-brand" href="#overview" aria-label="GoodJob UI 首页">
          <span>GJ</span>
          <strong>
            GoodJob UI
            <small>增长经营设计系统</small>
          </strong>
        </a>
        <nav className="ui-sidebar__nav" aria-label="组件目录">
          {NAV_ITEMS.map(([id, label, short], index) => (
            <a className={index === 0 ? "is-active" : ""} href={`#${id}`} key={id}>
              <span>{short}</span>
              {label}
            </a>
          ))}
        </nav>
        <div className="ui-sidebar__footer">
          <span>设计语言</span>
          <strong>霓光玻璃组件库</strong>
        </div>
      </aside>
      <div className="ui-app-main">
        <header className="ui-topbar">
          <div>
            <strong>AI 营销工作台</strong>
            <span>组件与状态基线</span>
          </div>
          <div className="ui-topbar__actions">
            <div className="ui-theme-switch" aria-label="主题选择">
              <button
                type="button"
                className={theme === "warm" ? "is-active" : ""}
                aria-pressed={theme === "warm"}
                onClick={() => onThemeChange("warm")}
              >
                明亮玻璃
              </button>
              <button
                type="button"
                className={theme === "dark" ? "is-active" : ""}
                aria-pressed={theme === "dark"}
                onClick={() => onThemeChange("dark")}
              >
                暗黑玻璃
              </button>
            </div>
            <div className="ui-account">
              <span>ZM</span>
              <strong>设计负责人</strong>
            </div>
          </div>
        </header>
        <main className="ui-content">{children}</main>
      </div>
    </div>
  );
}
