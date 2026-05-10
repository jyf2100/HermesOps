import type { ProfileTemplateData } from "../../types/profile";
import type { Translations } from "../../i18n/zh";

// ---------------------------------------------------------------------------
// TemplateCard
// ---------------------------------------------------------------------------

interface TemplateCardProps {
  template: ProfileTemplateData;
  onEdit: () => void;
  onClone: () => void;
  onDelete: () => void;
  t: Translations;
}

/** Extract enabled skill names from config_overrides.skills.enabled. */
function extractSkills(config: Record<string, unknown>): string[] {
  const skills = config?.skills;
  if (typeof skills !== "object" || skills === null) return [];
  const enabled = (skills as Record<string, unknown>).enabled;
  if (!Array.isArray(enabled)) return [];
  return enabled.filter((s): s is string => typeof s === "string");
}

export function TemplateCard({ template, onEdit, onClone, onDelete, t }: TemplateCardProps) {
  const skills = extractSkills(template.config_overrides);
  const borderClass = template.is_builtin
    ? "border-l-2 border-l-accent-cyan"
    : "border-l-2 border-l-border";

  return (
    <article
      className={`rounded-lg border border-border bg-surface p-4 flex flex-col gap-3 hover:border-accent-cyan/30 transition-colors ${borderClass}`}
    >
      {/* Top: name + badge */}
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium text-text-primary truncate" title={template.display_name || template.name}>
          {template.display_name || template.name}
        </h4>
        <span
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${
            template.is_builtin
              ? "bg-accent-cyan/10 text-accent-cyan border-accent-cyan/20"
              : "bg-surface text-text-secondary border-border"
          }`}
        >
          {template.is_builtin ? t.templateBuiltinBadge : t.templateCustomBadge}
        </span>
      </div>

      {/* Middle: description + skills */}
      {template.description && (
        <p className="text-xs text-text-secondary line-clamp-2 leading-relaxed">
          {template.description}
        </p>
      )}

      {skills.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {skills.slice(0, 5).map((skill) => (
            <span
              key={skill}
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-cyan/5 text-accent-cyan/80 border border-accent-cyan/10"
            >
              {skill}
            </span>
          ))}
          {skills.length > 5 && (
            <span className="text-[10px] px-1.5 py-0.5 text-text-secondary">
              +{skills.length - 5}
            </span>
          )}
        </div>
      )}

      {/* Bottom: meta info */}
      <div className="flex items-center gap-3 text-[10px] text-text-secondary mt-auto pt-1">
        {(template.profile_count ?? 0) > 0 && (
          <span>
            {t.templateProfileCount.replace("{count}", String(template.profile_count))}
          </span>
        )}
        {template.updated_at && (
          <span>
            {t.templateLastUpdated}: {formatRelativeTime(template.updated_at, t)}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 pt-1 border-t border-border/50">
        <button
          type="button"
          onClick={onClone}
          className="h-7 px-2.5 text-[10px] border border-border text-text-secondary hover:text-text-primary hover:border-accent-cyan/30 rounded transition-colors"
        >
          {t.templateClone}
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="h-7 px-2.5 text-[10px] border border-border text-text-secondary hover:text-text-primary hover:border-accent-cyan/30 rounded transition-colors"
        >
          {t.edit}
        </button>
        {!template.is_builtin && (
          <button
            type="button"
            onClick={onDelete}
            className="h-7 px-2.5 text-[10px] border border-accent-pink/30 text-accent-pink hover:bg-accent-pink/10 rounded transition-colors ml-auto"
          >
            {t.delete}
          </button>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string, t: Translations): string {
  try {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return iso;
    const diffMs = Date.now() - date.getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return t.timeJustNow;
    if (minutes < 60) return t.timeMinutesAgo.replace("{n}", String(minutes));
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t.timeHoursAgo.replace("{n}", String(hours));
    const days = Math.floor(hours / 24);
    return t.timeDaysAgo.replace("{n}", String(days));
  } catch {
    return iso;
  }
}
