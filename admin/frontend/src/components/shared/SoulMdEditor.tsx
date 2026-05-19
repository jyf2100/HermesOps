import { type ReactNode, useState } from "react";

interface SoulMdEditorProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  label?: string;
  previewLabel?: string;
  editLabel?: string;
  disabled?: boolean;
  placeholder?: string;
  actions?: ReactNode;
}

export function SoulMdEditor({
  value,
  onChange,
  rows = 6,
  label,
  previewLabel = "Preview",
  editLabel,
  disabled = false,
  placeholder,
  actions,
}: SoulMdEditorProps) {
  const [showPreview, setShowPreview] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          {label && (
            <label className="text-xs text-text-secondary">
              {label}
            </label>
          )}
          {actions}
        </div>
        {value && (
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="text-[10px] text-accent-cyan hover:text-accent-cyan/80"
          >
            {showPreview ? editLabel : previewLabel}
          </button>
        )}
      </div>
      {showPreview ? (
        <pre className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary whitespace-pre-wrap max-h-48 overflow-auto">
          {value}
        </pre>
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          className={`w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary resize-y placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
          placeholder={placeholder ?? "Custom SOUL.md content for this profile..."}
          disabled={disabled}
        />
      )}
    </div>
  );
}
