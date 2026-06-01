import type { ReactNode } from "react";

interface ModalOverlayProps {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  "aria-labelledby"?: string;
}

export function ModalOverlay({
  onClose,
  children,
  className,
  "aria-labelledby": ariaLabelledBy,
}: ModalOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 overflow-y-auto pb-8 bg-black/50"
      data-testid="modal-root"
      role="dialog"
      aria-modal="true"
      aria-labelledby={ariaLabelledBy}
      tabIndex={-1}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className={`bg-surface border border-border rounded-lg flex flex-col ${className ?? ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
