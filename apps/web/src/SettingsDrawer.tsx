import { useId, type ReactNode } from "react";
import { Modal } from "./Modal";

export function SettingsDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <Modal className="settings-drawer" labelledBy={heading} onClose={onClose}>
      <div className="settings-drawer-header">
        <h2 id={heading}>{title}</h2>
        <button type="button" onClick={onClose} aria-label="关闭面板">
          关闭 ×
        </button>
      </div>
      <div className="settings-drawer-body">{children}</div>
    </Modal>
  );
}
