import { useNavigate } from "react-router-dom";

interface AnomalyBadgeProps {
  count: number;
}

export function AnomalyBadge({ count }: AnomalyBadgeProps) {
  const navigate = useNavigate();

  if (count <= 0) return null;

  return (
    <button
      onClick={() => navigate("/monitoring?tab=anomaly")}
      className="relative inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-accent-pink/15 text-accent-pink hover:bg-accent-pink/25 transition-colors cursor-pointer"
      title={`${count} anomaly(ies)`}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-pink opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-pink" />
      </span>
      {count}
    </button>
  );
}
