import { useState, useEffect, useCallback, useRef } from "react";
import { adminApi } from "../lib/admin-api";
import { useI18n } from "../hooks/useI18n";
import { showToast } from "../lib/toast";
import type { ProfileTemplateData } from "../types/profile";
import { TemplateCard } from "../components/template/TemplateCard";
import { TemplateEditor } from "../components/template/TemplateEditor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FilterMode = "all" | "builtin" | "custom";
type EditorTarget =
  | null
  | { mode: "create" }
  | { mode: "edit"; template: ProfileTemplateData }
  | { mode: "clone"; template: ProfileTemplateData };

// ---------------------------------------------------------------------------
// TemplateListPage
// ---------------------------------------------------------------------------

export function TemplateListPage() {
  const { t } = useI18n();

  // Data
  const [templates, setTemplates] = useState<ProfileTemplateData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter & search
  const [filter, setFilter] = useState<FilterMode>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // Editor modal
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);

  // ----- Data loading -----

  const loadTemplates = useCallback(async (search?: string, isBuiltin?: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const params: { is_builtin?: boolean; search?: string } = {};
      if (isBuiltin !== undefined) params.is_builtin = isBuiltin;
      if (search) params.search = search;
      const data = await adminApi.listProfileTemplates(params);
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(t.templateLoadFailed));
    } finally {
      setLoading(false);
    }
  }, [t.templateLoadFailed]);

  // Re-fetch when filter or debounced search changes (also handles initial load)
  useEffect(() => {
    const isBuiltin = filter === "builtin" ? true : filter === "custom" ? false : undefined;
    loadTemplates(debouncedSearch || undefined, isBuiltin);
  }, [filter, debouncedSearch, loadTemplates]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // ----- Debounced search -----

  function handleSearchChange(value: string) {
    setSearchQuery(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(value);
    }, 300);
  }

  // ----- Actions -----

  function handleEdit(template: ProfileTemplateData) {
    setEditorTarget({ mode: "edit", template });
  }

  function handleClone(template: ProfileTemplateData) {
    setEditorTarget({ mode: "clone", template });
  }

  async function handleDelete(template: ProfileTemplateData) {
    const label = template.display_name || template.name;
    let confirmMsg = t.templateDeleteConfirm.replace("{name}", label);
    if ((template.profile_count ?? 0) > 0) {
      confirmMsg += "\n\n" + t.templateDeleteWarning.replace("{count}", String(template.profile_count));
    }
    if (!window.confirm(confirmMsg)) return;

    try {
      await adminApi.deleteProfileTemplate(template.id);
      showToast(t.templateDeleteSuccess);
      const isBuiltin = filter === "builtin" ? true : filter === "custom" ? false : undefined;
      loadTemplates(debouncedSearch || undefined, isBuiltin);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(t.errorGeneric), "error");
    }
  }

  function handleEditorSaved() {
    setEditorTarget(null);
    const isBuiltin = filter === "builtin" ? true : filter === "custom" ? false : undefined;
    loadTemplates(debouncedSearch || undefined, isBuiltin);
  }

  // ----- Derived state -----

  const existingNames = templates.map((tmpl) => tmpl.name);
  const isSearching = debouncedSearch.length > 0;
  const isEmpty = templates.length === 0 && !loading && !error;

  // Active tab for filter bar
  const filterTabs: Array<{ key: FilterMode; label: string }> = [
    { key: "all", label: t.templateFilterAll },
    { key: "builtin", label: t.templateFilterBuiltin },
    { key: "custom", label: t.templateFilterCustom },
  ];

  // ----- Render -----

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border pb-0">
        <button
          type="button"
          className="px-4 py-2 text-sm font-medium text-text-primary border-b-2 border-accent-cyan"
        >
          {t.templateTemplatesTab}
        </button>
        <button
          type="button"
          disabled
          className="px-4 py-2 text-sm text-text-secondary/50 cursor-not-allowed"
        >
          {t.templateSkillsTab}
        </button>
      </div>

      {/* Header: title + search + create */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="text-lg font-medium text-text-primary">
          {t.templateList}
        </h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <svg
              className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-secondary"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t.templateSearchPlaceholder}
              className="h-8 pl-8 pr-3 w-48 text-xs bg-background border border-border rounded text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
            />
          </div>
          <button
            type="button"
            onClick={() => setEditorTarget({ mode: "create" })}
            className="h-8 px-3 text-xs rounded bg-accent-pink text-white hover:bg-accent-pink/90 transition-colors"
          >
            {t.templateCreate}
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-1">
        {filterTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setFilter(tab.key)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              filter === tab.key
                ? "bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20"
                : "text-text-secondary hover:text-text-primary border border-transparent"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-text-secondary">{t.templateLoading}</p>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 py-12">
          <p className="text-sm text-accent-pink">{error}</p>
          <button
            type="button"
            onClick={() => {
              const isBuiltin = filter === "builtin" ? true : filter === "custom" ? false : undefined;
              loadTemplates(debouncedSearch || undefined, isBuiltin);
            }}
            className="h-9 px-4 text-sm border border-accent-cyan text-accent-cyan hover:bg-accent-cyan/10 rounded transition-colors"
          >
            {t.templateRetry}
          </button>
        </div>
      ) : isEmpty ? (
        <div className="rounded-lg border border-border border-dashed bg-surface/50 p-12 text-center">
          <p className="text-sm text-text-secondary">
            {isSearching ? t.templateEmptySearch : t.templateEmptyState}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              t={t}
              onEdit={() => handleEdit(template)}
              onClone={() => handleClone(template)}
              onDelete={() => handleDelete(template)}
            />
          ))}
        </div>
      )}

      {/* Editor modal */}
      {editorTarget && (
        <TemplateEditor
          mode={editorTarget.mode}
          template={"template" in editorTarget ? editorTarget.template : null}
          existingNames={existingNames}
          onClose={() => setEditorTarget(null)}
          onSaved={handleEditorSaved}
        />
      )}
    </div>
  );
}
