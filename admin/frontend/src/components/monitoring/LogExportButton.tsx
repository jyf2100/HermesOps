import { useState } from "react";
import { useI18n } from "../../hooks/useI18n";
import { adminApi } from "../../lib/admin-api";
import { showToast } from "../../lib/toast";
import type { LogSearchRequest } from "../../lib/admin-api";

interface LogExportButtonProps {
  params: LogSearchRequest;
}

export function LogExportButton({ params }: LogExportButtonProps) {
  const { t } = useI18n();
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const blob = await adminApi.exportLogs(params);

      // Trigger browser download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `logs-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showToast(t.logExportSuccess, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.logExportFailed, "error");
    } finally {
      setExporting(false);
    }
  }

  return (
    <button
      onClick={handleExport}
      disabled={exporting}
      className="h-8 px-3 text-xs rounded-lg bg-surface border border-border text-text-secondary hover:text-text-primary disabled:opacity-50 transition-colors"
    >
      {exporting ? t.logExporting : t.logExportButton}
    </button>
  );
}
