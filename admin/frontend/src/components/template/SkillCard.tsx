import type { Translations } from "../../i18n/zh";

// ---------------------------------------------------------------------------
// SkillCard
// ---------------------------------------------------------------------------

interface SkillCardProps {
  name: string;
  templateCount: number;
  t: Translations;
  onClick: () => void;
}

export function SkillCard({ name, templateCount, t, onClick }: SkillCardProps) {
  return (
    <article
      className="group rounded-lg border border-border bg-surface/50 p-4 hover:border-accent-cyan/50 transition-colors cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(); }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-mono text-text-primary truncate">
          {name}
        </span>
        <span className="text-xs text-text-secondary shrink-0">
          {t.templateSkillUsedBy.replace("{count}", String(templateCount))}
        </span>
      </div>
    </article>
  );
}
