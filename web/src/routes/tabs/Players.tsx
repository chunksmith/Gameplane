import { useResourceClient, useResourceAccess, useResourceTarget, resourceKey } from "@/lib/resourceTarget";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  RotateCw,
  UserMinus,
  UserPlus,
  Ban,
  Undo2,
  ListChecks,
} from "lucide-react";

import { Button, Input } from "@heroui/react";
import { StatCard } from "@/components/ui/StatCard";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { errorText } from "@/lib/errors";
import { playerRows } from "@/lib/players";
import { playerHeadUrl } from "@/lib/playerHeads";
import type { GameTemplate } from "@/types";

import { cn } from "@/lib/utils";

interface ModResp {
  ok: boolean;
  raw?: string;
}

type Action = "kick" | "ban";

export function PlayersTab({ name, ns, tmpl }: { name: string; ns?: string; tmpl?: GameTemplate }) {
  const canControl = useResourceAccess()?.canControl === true;
  const resourceTarget = useResourceTarget({ name, namespace: ns });
  const resourceClient = useResourceClient(resourceTarget);
  const { Players: PlayersAPI } = resourceClient;
  const qc = useQueryClient();
  const [pending, setPending] = useState<{ player: string; label: string; action: Action } | null>(null);
  const [reason, setReason] = useState("");
  const [showBanned, setShowBanned] = useState(false);
  const [showWhitelist, setShowWhitelist] = useState(false);
  const [wlName, setWlName] = useState("");
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const { data, refetch, isFetching } = useQuery({
    queryKey: resourceKey(resourceTarget, "players", name, ns),
    queryFn: ({ signal }) => resourceClient.withSignal(signal).Players.snapshot(name, ns),
    refetchInterval: 5_000,
  });
  const caps = data?.capabilities;
  const rows = playerRows(data);
  const heads = tmpl?.spec.game.startsWith("minecraft") === true;

  // Banned + whitelist are fetched whenever the game supports them so the
  // summary tiles always have counts; the sections below just toggle the
  // list's visibility, not the fetch.
  const { data: banned, isFetching: bannedFetching } = useQuery({
    queryKey: resourceKey(resourceTarget, "banned", name, ns),
    queryFn: ({ signal }) => resourceClient.withSignal(signal).Players.banned(name, ns),
    enabled: caps?.unban ?? false,
  });
  const { data: whitelist, isFetching: whitelistFetching } = useQuery({
    queryKey: resourceKey(resourceTarget, "whitelist", name, ns),
    queryFn: ({ signal }) => resourceClient.withSignal(signal).Players.whitelist(name, ns),
    enabled: caps?.whitelist ?? false,
  });

  const moderate = useMutation<ModResp, unknown, { action: Action | "unban"; player: string; reason?: string }>({
    mutationFn: (vars) =>
      PlayersAPI.moderate(name, vars.action, {
        name: vars.player,
        ...(vars.reason ? { reason: vars.reason } : {}),
      }, ns),
    onSuccess: (resp, vars) => {
      void qc.invalidateQueries({ queryKey: ["fleet"] });
      setPending(null);
      setReason("");
      setStatus({
        kind: "ok",
        text: resp.raw ? truncate(resp.raw, 200) : `${vars.action} ${vars.player} ok`,
      });
      return Promise.all([
        qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "players", name, ns) }),
        qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "banned", name, ns) }),
      ]);
    },
    onError: (err) => setStatus({ kind: "err", text: errMsg(err) }),
  });

  const whitelistMut = useMutation<ModResp, unknown, { op: "add" | "remove"; player: string }>({
    mutationFn: (vars) =>
      vars.op === "add"
        ? PlayersAPI.whitelistAdd(name, vars.player, ns)
        : PlayersAPI.whitelistRemove(name, vars.player, ns),
    onSuccess: (resp, vars) => {
      void qc.invalidateQueries({ queryKey: ["fleet"] });
      setWlName("");
      setStatus({
        kind: "ok",
        text: resp.raw ? truncate(resp.raw, 200) : `whitelist ${vars.op} ${vars.player} ok`,
      });
      return qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "whitelist", name, ns) });
    },
    onError: (err) => setStatus({ kind: "err", text: errMsg(err) }),
  });

  const noModeration = caps && !caps.kick && !caps.ban && !caps.unban && !caps.whitelist;

  return (
    <div className="space-y-6 p-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Online"
          value={data && data.online >= 0 ? (data.max >= 0 ? `${data.online} / ${data.max}` : `${data.online}`) : "—"}
          accent="success"
        />
        {caps?.whitelist && (
          <StatCard label="Whitelisted" value={whitelist?.length ?? "—"} accent="primary" />
        )}
        {caps?.unban && (
          <StatCard label="Banned" value={banned?.length ?? "—"} accent="danger" />
        )}
      </div>

      <header className="flex items-center justify-between">
        <h2 className="text-sm text-muted">
          {data
            ? data.online < 0
              ? "Player count unknown"
              : data.max >= 0
                ? `${data.online} / ${data.max} online`
                : `${data.online} online`
            : "Loading…"}
        </h2>
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          isDisabled={isFetching}
          aria-label="Refresh players"
        >
          <span title="Refresh">
            <RotateCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          </span>
        </Button>
      </header>

      {status && status.kind === "err" && (
        <ErrorBanner
          err={status.text}
          onDismiss={() => setStatus(null)}
        />
      )}
      {status && status.kind === "ok" && (
        <div className="flex items-start justify-between gap-3 rounded border border-border bg-surface/30 px-3 py-2 text-sm">
          <span className="font-mono">{status.text}</span>
          <button onClick={() => setStatus(null)} className="text-xs text-muted hover:text-fg">
            dismiss
          </button>
        </div>
      )}

      {noModeration && (
        <p className="text-sm text-muted">Player moderation isn&apos;t supported for this game.</p>
      )}

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-3 transition-colors hover:border-accent/40 hover:bg-surface"
          >
            <PlayerAvatar name={r.label} head={heads && r.named} />
            <div className="min-w-0 flex-1">
              <div className={cn("truncate text-sm font-medium text-foreground", !r.named && "font-mono text-muted")}>
                {r.label}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                <span>In game</span>
                {r.faction && (
                  <span className="truncate rounded-full bg-accent/10 px-2 py-0.5 text-accent">{r.faction}</span>
                )}
              </div>
            </div>
            {caps && (caps.kick || caps.ban) && (
              <div className="flex shrink-0 items-center gap-1">
                {caps.kick && (
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    isDisabled={!canControl} aria-label="Kick"
                    onClick={() => {
                      setPending({ player: r.id, label: r.label, action: "kick" });
                      setReason("");
                    }}
                  >
                    <span title="Kick">
                      <UserMinus className="h-4 w-4" />
                    </span>
                  </Button>
                )}
                {caps.ban && (
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    isDisabled={!canControl} aria-label={`Ban ${r.label}`}
                    onClick={() => {
                      setPending({ player: r.id, label: r.label, action: "ban" });
                      setReason("");
                    }}
                  >
                    <span title="Ban">
                      <Ban className="h-4 w-4" />
                    </span>
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
        {data && rows.length === 0 && <p className="text-sm text-muted">Nobody online.</p>}
      </ul>

      {pending && (
        <ConfirmAction
          player={pending.label}
          playerId={pending.player}
          action={pending.action}
          reason={reason}
          onReasonChange={setReason}
          submitting={moderate.isPending}
          onCancel={() => {
            setPending(null);
            setReason("");
          }}
          onConfirm={() =>
            moderate.mutate({
              action: pending.action,
              player: pending.player,
              reason: reason.trim() || undefined,
            })
          }
        />
      )}

      {caps?.whitelist && (
        <section>
          <button
            onClick={() => setShowWhitelist((v) => !v)}
            className="flex items-center gap-1 text-sm text-muted hover:text-fg"
          >
            {showWhitelist ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <ListChecks className="h-4 w-4" /> Whitelist {whitelist ? `(${whitelist.length})` : ""}
          </button>
          {showWhitelist && (
            <div className="mt-2 space-y-2">
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = wlName.trim();
                  if (canControl && n) whitelistMut.mutate({ op: "add", player: n });
                }}
              >
                <Input
                  className="flex-1"
                  placeholder="Add player to whitelist…"
                  value={wlName}
                  onChange={(e) => setWlName(e.target.value)}
                  maxLength={32}
                />
                <Button
                  size="sm"
                  type="submit"
                  isDisabled={!canControl || !wlName.trim() || whitelistMut.isPending}
                  variant="primary"
                >
                  <UserPlus className="h-4 w-4" /> Add
                </Button>
              </form>
              {whitelistFetching && !whitelist && <p className="text-sm text-muted">Loading…</p>}
              {whitelist?.map((w) => (
                <div
                  key={w}
                  className="flex items-center justify-between gap-2 rounded border border-border bg-surface/30 px-3 py-2 font-mono text-sm"
                >
                  <span className="truncate">{w}</span>
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${w} from whitelist`}
                    isDisabled={!canControl || whitelistMut.isPending}
                    onClick={() => whitelistMut.mutate({ op: "remove", player: w })}
                  >
                    <span title="Remove from whitelist">
                      <UserMinus className="h-4 w-4" />
                    </span>
                  </Button>
                </div>
              ))}
              {whitelist?.length === 0 && <p className="text-sm text-muted">Whitelist is empty.</p>}
            </div>
          )}
        </section>
      )}

      {caps?.unban && (
        <section>
          <button
            onClick={() => setShowBanned((v) => !v)}
            className="flex items-center gap-1 text-sm text-muted hover:text-fg"
          >
            {showBanned ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Banned {banned ? `(${banned.length})` : ""}
          </button>
          {showBanned && (
            <div className="mt-2 space-y-1">
              {bannedFetching && !banned && <p className="text-sm text-muted">Loading…</p>}
              {banned?.map((b) => (
                <div
                  key={b.name}
                  className="flex items-center justify-between gap-2 rounded border border-border bg-surface/30 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono">{b.name}</div>
                    {(b.reason || b.source) && (
                      <div className="truncate text-xs text-muted">
                        {b.source && <span>by {b.source}</span>}
                        {b.source && b.reason && <span> · </span>}
                        {b.reason && <span>{b.reason}</span>}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Unban ${b.name}`}
                    isDisabled={!canControl || moderate.isPending}
                    onClick={() => moderate.mutate({ action: "unban", player: b.name })}
                  >
                    <span title="Unban">
                      <Undo2 className="h-4 w-4" />
                    </span>{" "}
                    Unban
                  </Button>
                </div>
              ))}
              {banned?.length === 0 && <p className="text-sm text-muted">Nobody is banned.</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function ConfirmAction({
  player,
  playerId,
  action,
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
  submitting,
}: {
  player: string;
  playerId: string;
  action: Action;
  reason: string;
  onReasonChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const verb = action === "kick" ? "Kick" : "Ban";
  const verbing = action === "kick" ? "Kicking" : "Banning";
  return (
    <div className="rounded border border-border bg-surface/50 p-4">
      <p className="text-sm text-foreground">
        {verb} <span className="font-mono">{player}</span>
        {playerId !== player && (
          <>
            {" "}
            (<span className="font-mono">{playerId}</span>)
          </>
        )}
        ?
      </p>
      <Input
        className="mt-3"
        placeholder="Reason (optional, max 256 chars)"
        value={reason}
        onChange={(e) => onReasonChange(e.target.value)}
        maxLength={256}
        autoFocus
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          isDisabled={submitting}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={onConfirm}
          isDisabled={submitting}
        >
          {submitting ? `${verbing}…` : verb}
        </Button>
      </div>
    </div>
  );
}

function PlayerAvatar({ name, head }: { name: string; head: boolean }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!head) return;
    let active = true;
    void playerHeadUrl(name).then(
      (url) => {
        if (active) setSrc(url);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [name, head]);
  if (src)
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        className="h-10 w-10 shrink-0 rounded-lg [image-rendering:pixelated]"
      />
    );
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--default)] font-mono text-xs font-semibold text-muted">
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function errMsg(err: unknown): string {
  return errorText(err, "action failed");
}
