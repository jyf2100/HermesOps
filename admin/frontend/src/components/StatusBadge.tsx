import { useI18n } from "../hooks/useI18n";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400",
  notified: "bg-blue-500/20 text-blue-400",
  confirmed: "bg-green-500/20 text-green-400",
  executing: "bg-cyan-500/20 text-cyan-400",
  completed: "bg-emerald-500/20 text-emerald-400",
  failed: "bg-red-500/20 text-red-400",
  rejected: "bg-pink-500/20 text-pink-400",
  expired: "bg-amber-500/20 text-amber-400",
  cancelled: "bg-zinc-500/20 text-zinc-400",
  // dispatch task level statuses
  dispatching: "bg-yellow-500/20 text-yellow-400",
  dispatched: "bg-blue-500/20 text-blue-400",
  partial: "bg-orange-500/20 text-orange-400",
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const key = `dispatchStatus${status.charAt(0).toUpperCase() + status.slice(1)}` as keyof typeof t;
  const label = (t[key] as string) || status;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status] || "bg-gray-500/20 text-gray-400"}`}>
      {label}
    </span>
  );
}
