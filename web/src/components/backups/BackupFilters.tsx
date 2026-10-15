import type { ResourceTarget } from "@/lib/resourceTarget";
import { useState, type ReactNode } from "react";
import { Chip, Input, Select, ListBox, ListBoxItem } from "@heroui/react";
import { Filter, Search } from "lucide-react";
import { FleetScopeFilter } from "@/components/FleetScope";
import { FilterPopover } from "@/components/ui/FilterPopover";
import type { GameServer } from "@/types";

interface Props {
  search: string;
  onSearchChange: (v: string) => void;
  location: string;
  onLocationChange: (v: string) => void;
  locations: string[];
  server: string;
  onServerChange: (v: string) => void;
  phase?: string;
  onPhaseChange?: (v: string) => void;
  servers: (GameServer & { fleetTarget?: ResourceTarget })[];
  phases?: string[];
  trailing?: ReactNode;
}

export function BackupFilters({
  search, onSearchChange,
  location, onLocationChange, locations,
  server, onServerChange,
  phase = "", onPhaseChange,
  servers, phases = [], trailing,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [draftLocation, setDraftLocation] = useState(location);
  const [draftServer, setDraftServer] = useState(server);
  const [draftPhase, setDraftPhase] = useState(phase);
  const count = Number(Boolean(location)) + Number(Boolean(server)) + Number(Boolean(phase));
  const availableServers = servers.filter((item) => !draftLocation || item.fleetTarget?.cluster === draftLocation);
  const onOpenChange = (open: boolean) => {
    if (open) {
      setDraftLocation(location);
      setDraftServer(server);
      setDraftPhase(phase);
    }
    setIsOpen(open);
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="relative min-w-0 flex-1 basis-48 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/60" />
        <Input
          className="w-full pl-9"
          placeholder="Search by name or server…"
          aria-label="Search backups, schedules or restores"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          type="text"
        />
      </div>
      <div className="ml-auto flex items-center gap-3">
        {trailing && <div className="text-xs text-muted">{trailing}</div>}
        <FilterPopover
          isOpen={isOpen}
          onOpenChange={onOpenChange}
          onApply={() => {
            onLocationChange(draftLocation);
            onServerChange(draftServer);
            onPhaseChange?.(draftPhase);
            setIsOpen(false);
          }}
          onClear={() => {
            setDraftLocation("");
            setDraftServer("");
            setDraftPhase("");
          }}
          fields={<>
            <div className="space-y-1">
              <div className="text-xs font-semibold text-muted">Location</div>
              <FleetScopeFilter value={draftLocation} onChange={(next) => {
                setDraftLocation(next);
                if (next && servers.find((item) => serverOptionID(item) === draftServer)?.fleetTarget?.cluster !== next) setDraftServer("");
              }} clusters={locations} />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-semibold text-muted">Server</div>
              <Select value={draftServer} onChange={(v) => setDraftServer(String(v ?? ""))} className="w-full" aria-label="Filter by server">
                <Select.Trigger><Select.Value /><Select.Indicator className="ml-auto h-4 w-4" /></Select.Trigger>
                <Select.Popover>
                  <ListBox aria-label="Server options">
                    <ListBoxItem id="" textValue="All servers">All servers</ListBoxItem>
                    {availableServers.map((s) => (
                      <ListBoxItem key={serverOptionID(s)} id={serverOptionID(s)} textValue={serverOptionLabel(s)}>
                        {serverOptionLabel(s)}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
            {phases.length > 0 && <div className="space-y-1">
              <div className="text-xs font-semibold text-muted">Phase</div>
              <Select value={draftPhase} onChange={(v) => setDraftPhase(String(v ?? ""))} className="w-full" aria-label="Filter by phase">
                <Select.Trigger><Select.Value /><Select.Indicator className="ml-auto h-4 w-4" /></Select.Trigger>
                <Select.Popover>
                  <ListBox aria-label="Phase options">
                    <ListBoxItem id="" textValue="All phases">All phases</ListBoxItem>
                    {phases.map((p) => <ListBoxItem key={p} id={p} textValue={p}>{p}</ListBoxItem>)}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>}
          </>}
        >
          <div className="inline-flex items-center gap-2 rounded-[6px] px-3 py-2 text-sm font-medium border border-default-300 bg-default-100 hover:bg-default-200 cursor-pointer transition-colors">
            <Filter className="h-4 w-4" /> Filter
            {count > 0 && <Chip size="sm" variant="soft">{count}</Chip>}
          </div>
        </FilterPopover>
      </div>
    </div>
  );
}

function serverOptionID(s: GameServer & { fleetTarget?: ResourceTarget }) {
  const t = s.fleetTarget;
  return t ? JSON.stringify([t.cluster, t.namespace, t.name, t.uid]) : s.metadata.name;
}
function serverOptionLabel(s: GameServer & { fleetTarget?: ResourceTarget }) {
  return s.fleetTarget ? s.metadata.name + " · " + s.fleetTarget.cluster + " / " + s.fleetTarget.namespace : s.metadata.name;
}
