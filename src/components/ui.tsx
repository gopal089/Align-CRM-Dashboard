import type { ReactNode, FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  X,
  Ellipsis,
  ArrowUpRight,
  Inbox,
  LoaderCircle,
  AlertCircle,
  ChevronDown,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useState } from "react";
export function Logo() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      align<span className="brand-dot">.</span>
    </span>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={`modal ${wide ? "modal-wide" : ""}`}>
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>
                {description || "Manage your CRM records."}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close dialog">
              <X size={18} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Confirm({
  open,
  onClose,
  onConfirm,
  title,
  description,
  destructive = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  title: string;
  description: string;
  destructive?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={title}
      description={description}
    >
      <p className="muted">{description}</p>
      {error && <ErrorMessage error={error} />}
      <div className="form-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className={`button ${destructive ? "danger" : "primary"}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : null}
          {destructive ? "Delete permanently" : "Confirm"}
        </button>
      </div>
    </Modal>
  );
}
export function Menu({
  items,
  label,
  children,
}: {
  items: {
    label: string;
    action: () => void;
    danger?: boolean;
    disabled?: boolean;
  }[];
  label?: string;
  children?: ReactNode;
}) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          className={label ? "button" : "icon-button"}
          aria-label={label || "More actions"}
        >
          {children || label || <Ellipsis size={18} />}
          {label && <ChevronDown size={14} />}
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="dropdown" sideOffset={6} align="end">
          {items.map((item, i) => (
            <Dropdown.Item
              key={i}
              className={item.danger ? "text-danger" : ""}
              onSelect={item.action}
              disabled={item.disabled}
            >
              {item.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
export function Badge({ value }: { value: any }) {
  const text = String(value || "—");
  const kind = [
    "Qualified",
    "Converted",
    "Closed won",
    "Accepted",
    "Completed",
    "Administrator",
  ].includes(text)
    ? "good"
    : [
          "High",
          "Lost",
          "Rejected",
          "Closed lost",
          "Overdue",
          "Expired",
        ].includes(text)
      ? "bad"
      : [
            "New",
            "Proposal",
            "Ready to Send",
            "Sent",
            "In progress",
            "Sales Manager",
          ].includes(text)
        ? "accent"
        : "neutral";
  return (
    <span className={`badge ${kind}`}>
      <span />
      {text}
    </span>
  );
}
export function Empty({
  title = "Nothing here yet",
  description = "Your records will appear here.",
  action,
  link,
  compact = false,
}: {
  title?: string;
  description?: string;
  action?: () => void;
  link?: string;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? "compact" : ""}`}>
      <span className="empty-icon">
        <Inbox size={23} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <button className="button" onClick={action}>
          Create your first record <ArrowUpRight size={14} />
        </button>
      )}
      {link && (
        <Link className="text-link" to={link}>
          Get started <ArrowUpRight size={14} />
        </Link>
      )}
    </div>
  );
}
export function Loading({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeletons" aria-label="Loading" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  );
}
export function ErrorMessage({
  error,
  retry,
}: {
  error: string;
  retry?: () => void;
}) {
  return (
    <div className="error" role="alert">
      <AlertCircle size={17} />
      <span>{error}</span>
      {retry && <button onClick={retry}>Try again</button>}
    </div>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
export function Section({
  title,
  description,
  children,
  action,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Form({
  onSubmit,
  children,
}: {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return <form onSubmit={onSubmit}>{children}</form>;
}
