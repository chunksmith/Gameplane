import { Skeleton } from "@heroui/react";
import { cn } from "@/lib/utils";

const ROWS = [["w-52", "w-36"], ["w-40", "w-28"], ["w-56", "w-32"], ["w-44", "w-28"], ["w-48", "w-36"], ["w-56", "w-24"]];
const PILLS = ["w-16", "w-20", "w-14"];

export function IssueRowsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="divide-y divide-border">
      {ROWS.map(([title, meta], index) => (
        <div key={`row-${index}`} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="h-2 w-2 shrink-0 rounded-full" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className={cn("h-3 max-w-full rounded-md", title)} />
            <Skeleton className={cn("h-2.5 max-w-full rounded-md", meta)} />
          </span>
          <span className="flex flex-col items-end gap-2">
            <Skeleton className="h-3 w-5 rounded-md" />
            <Skeleton className="h-2.5 w-9 rounded-md" />
          </span>
        </div>
      ))}
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div className="flex items-center gap-2.5">
      <Skeleton className="h-7 w-7 rounded-lg" />
      <Skeleton className="h-3.5 w-24 rounded-md" />
    </div>
  );
}

export function IssueDetailSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-3">
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <Skeleton className="h-5 w-40 rounded-md" />
        <Skeleton className="h-6 w-2/5 rounded-lg" />
        <div className="flex gap-2">
          {PILLS.map((width) => <Skeleton key={width} className={cn("h-6 rounded-full", width)} />)}
        </div>
        <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={`meta-${index}`} className="flex flex-col gap-2">
              <Skeleton className="h-2.5 w-12 rounded-md" />
              <Skeleton className="h-3.5 w-20 rounded-md" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
        <SectionSkeleton />
        <Skeleton className="h-3 w-full rounded-md" />
        <Skeleton className="h-3 w-11/12 rounded-md" />
        <Skeleton className="h-3 w-1/2 rounded-md" />
      </div>
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <SectionSkeleton />
        <div className="flex gap-3">
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-28 rounded-md" />
            <Skeleton className="h-3 w-3/5 rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}
