import { cn } from "@/lib/utils";

// A minimal inline-SVG sparkline. Auto-scales to the data's own min/max so the
// trend is legible even for low-variance series; renders nothing until there
// are at least two points (so a tile shows no empty box on first load).
export function Sparkline({
  data,
  className,
  strokeWidth = 1.5,
  area = false,
  fixedMin,
}: {
  data: number[];
  className?: string;
  strokeWidth?: number;
  area?: boolean;
  fixedMin?: number;
}) {
  if (data.length < 2) return null;
  const w = 100;
  const h = 24;
  const max = Math.max(...data);
  const min = fixedMin ?? Math.min(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("h-6 w-full", className)}
      aria-hidden="true"
    >
      {area && <polygon points={`0,${h} ${points} ${w},${h}`} fill="currentColor" fillOpacity={0.12} />}
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
