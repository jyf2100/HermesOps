interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  rows?: number;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
}

export function JsonEditor({
  value,
  onChange,
  error,
  rows = 8,
  placeholder = '{"model": {"default": "glm-4.7"}}',
  label,
  disabled = false,
}: JsonEditorProps) {
  return (
    <div>
      {label && (
        <label className="text-xs text-text-secondary block mb-1">
          {label}
        </label>
      )}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className={`w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-[family-name:var(--font-mono)] text-text-primary resize-y placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
        placeholder={placeholder}
        disabled={disabled}
      />
      {error && (
        <p className="mt-1 text-xs text-accent-pink">{error}</p>
      )}
    </div>
  );
}
