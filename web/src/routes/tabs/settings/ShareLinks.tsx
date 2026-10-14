import { useResourceClient, useResourceAccess, useResourceTarget, resourceKey } from "@/lib/resourceTarget";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter,
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContainer,
  AlertDialogDialog,
  AlertDialogHeader,
  AlertDialogHeading,
  AlertDialogBody,
  AlertDialogFooter,
  AlertDialogIcon,
  Table,
  Select,
  ListBox,
  ListBoxItem,
  Label,
  Description,
  Switch,
  Chip,
  Input,
} from "@heroui/react";
import { AlertCircle, Calendar as CalendarIcon, Copy, Link2 } from "lucide-react";
import type { ShareLink } from "@/types";
import { type ShareLinkCreateBody } from "@/lib/api";
import { errorText } from "@/lib/errors";

interface ShareLinksProps {
  name: string;
  ns?: string;
}

// Expiry options for the create dialog (FR-001): four day-count presets,
// "No expiry" (FR-002), and "Custom" (FR-003/FR-004). 30 days is the default.
const EXPIRY_OPTIONS = [
  { label: "15 days", value: "15" },
  { label: "30 days", value: "30" },
  { label: "60 days", value: "60" },
  { label: "90 days", value: "90" },
  { label: "No expiry", value: "never" },
  { label: "Custom", value: "custom" },
];

const DEFAULT_EXPIRY_CHOICE = "30";

// Maps a preset choice's value to its day count.
const PRESET_DAYS: Record<string, number> = { "15": 15, "30": 30, "60": 60, "90": 90 };

// OD-6: the long-lived-token warning shows at 365+ days from today.
const LONG_LIVED_THRESHOLD_DAYS = 365;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Today's (or `date`'s) calendar date as "YYYY-MM-DD" in the browser's local
// time zone. Used for the custom-date picker's minimum and for comparing
// against the chosen custom date; safe to compare lexicographically since
// both sides always use this same zero-padded format.
function localISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// The earliest selectable custom date: tomorrow, local time (FR-003 requires
// a date strictly after today).
function tomorrowISODate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localISODate(d);
}

// A custom date is valid once it is strictly after today, local time.
function isCustomDateValid(customDate: string): boolean {
  return customDate !== "" && customDate > localISODate(new Date());
}

// Converts a "YYYY-MM-DD" custom date into the UTC instant at which the link
// stops working: the end of that calendar day in the browser's local time
// zone (OD-2's ruling), i.e. 23:59:59.999 local time on the chosen date —
// not midnight.
function customDateToExpiresAt(customDate: string): string {
  const [year, month, day] = customDate.split("-").map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
}

// The end-of-day expiresAt instant for a preset of N calendar days from
// today (OD-1's ruling, 2026-09-20): a preset is a CALENDAR date, not N x
// 24h from the request time, so it goes through the same end-of-day path
// as a custom date (OD-2) — a "30 days" link expires at 23:59:59.999 local
// on that calendar date, not at whatever wall-clock time it was created.
// `setDate` advances by whole calendar days, which is correct across a DST
// boundary, unlike `Date.now() + N * ONE_DAY_MS`.
function presetDaysToExpiresAt(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return customDateToExpiresAt(localISODate(d));
}

// Whether a custom date is 365 days or more from today (OD-6), measured as
// the whole-day difference between local midnight today and local midnight
// on the chosen date.
function isLongLivedCustomDate(customDate: string): boolean {
  const [year, month, day] = customDate.split("-").map(Number);
  const chosen = new Date(year, month - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((chosen.getTime() - today.getTime()) / ONE_DAY_MS);
  return diffDays >= LONG_LIVED_THRESHOLD_DAYS;
}

// Status badge coloring
function statusColor(status: string): "success" | "warning" | "danger" | "default" {
  if (status === "Active") return "success";
  if (status === "Expired") return "warning";
  if (status === "Revoked") return "danger";
  return "default";
}

// Determine link status based on revocation first, then expiry. A null expiry means the link
// never expires (FR-007), so it can never be reported "Expired". Revoked links are always Revoked
// regardless of expiry (FR-010).
function getLinkStatus(expiresAt: string | null, revokedAt?: string | null): string {
  if (revokedAt !== null && revokedAt !== undefined) return "Revoked";
  if (expiresAt === null) return "Active";
  const expiry = new Date(expiresAt);
  const now = new Date();
  if (expiry <= now) return "Expired";
  return "Active";
}

// Format date for display (e.g., "Jul 28, 2026"), or "Never" for a
// no-expiry link (SC-004).
function formatDate(dateStr: string | null): string {
  if (dateStr === null) return "Never";
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// CreateDialog: Modal for entering link details
interface CreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  ns?: string;
  onLinkCreated?: (link: ShareLink) => void;
}

function CreateDialog({
  open,
  onOpenChange,
  serverName,
  ns,
  onLinkCreated,
}: CreateDialogProps) {
  const resourceTarget = useResourceTarget({ name: serverName, namespace: ns });
  const resourceClient = useResourceClient(resourceTarget);
  const { Shares } = resourceClient;
  const [expiryChoice, setExpiryChoice] = useState(DEFAULT_EXPIRY_CHOICE);
  const [customDate, setCustomDate] = useState("");
  const [canStart, setCanStart] = useState(false);

  const customDateValid = expiryChoice !== "custom" || isCustomDateValid(customDate);
  const showLongLivedWarning =
    expiryChoice === "custom" && customDate !== "" && isLongLivedCustomDate(customDate);

  const create = useMutation({
    mutationFn: () => {
      const body: ShareLinkCreateBody =
        expiryChoice === "never"
          ? { neverExpires: true, canStart }
          : expiryChoice === "custom"
            ? { expiresAt: customDateToExpiresAt(customDate), canStart }
            : {
                expiresAt: presetDaysToExpiresAt(PRESET_DAYS[expiryChoice]),
                canStart,
              };
      return Shares.create(serverName, body, ns);
    },
    onSuccess: (link) => {
      onOpenChange(false);
      onLinkCreated?.(link);
    },
  });

  // Reset state when dialog opens
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setExpiryChoice(DEFAULT_EXPIRY_CHOICE);
      setCustomDate("");
      setCanStart(false);
      create.reset();
    }
  }

  return (
    <Modal isOpen={open} onOpenChange={onOpenChange}>
      <ModalBackdrop
        isDismissable={!create.isPending}
        isKeyboardDismissDisabled={create.isPending}
      >
      <ModalContainer>
        <ModalDialog className="w-[480px] max-w-[480px]">
          <ModalHeader>
            <ModalHeading>Create share link for {serverName}</ModalHeading>
            <Description className="text-sm leading-[21px] text-muted">
              Anyone with this link can check the server&apos;s status and connection address
              without signing in.
            </Description>
          </ModalHeader>

          <ModalBody className="gap-4">
            <div className="flex flex-col gap-1">
              <Select
                value={expiryChoice}
                onChange={(key) => setExpiryChoice(String(key))}
              >
                <Label className="text-xs">Expires in</Label>
                <Select.Trigger>
                  <Select.Value className="text-[var(--field-placeholder)]" />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {EXPIRY_OPTIONS.map((opt) => (
                      <ListBoxItem key={opt.value} id={opt.value}>
                        {opt.label}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              {expiryChoice === "never" && (
                <p className="text-xs text-warning">This link works until you revoke it.</p>
              )}

              {expiryChoice === "custom" && (
                <>
                  <Label className="text-xs">Expires on</Label>
                  <div className="relative">
                    <Input
                      type="date"
                      aria-label="Expires on"
                      min={tomorrowISODate()}
                      value={customDate}
                      onChange={(e) => setCustomDate(e.target.value)}
                      className="date-input--modal pr-9"
                    />
                    <CalendarIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  </div>
                  {showLongLivedWarning && (
                    <p className="text-xs text-warning">
                      Long-lived link — it stays valid for over a year unless you revoke it.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-3">
              <Switch
                isSelected={canStart}
                onChange={setCanStart}
                aria-label="Allow starting the server"
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
              <div className="flex-1">
                <Label className="block text-sm">Allow starting the server</Label>
                <Description className="block text-xs text-muted">
                  The link holder can wake {serverName} from asleep. Without this, they can
                  only view its status.
                </Description>
              </div>
            </div>

            {create.isError && (
              <div className="rounded-lg bg-danger/10 p-3 text-sm text-danger">
                {errorText(create.error, "Failed to create link")}
              </div>
            )}
          </ModalBody>

          <ModalFooter className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-[5px] text-[13px]"
              onPress={() => onOpenChange(false)}
              isDisabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="gap-[5px] text-[13px]"
              isDisabled={create.isPending || !customDateValid}
              onPress={() => create.mutate()}
            >
              <Link2 className="h-3.5 w-3.5" />
              {create.isPending ? "Creating…" : "Create link"}
            </Button>
          </ModalFooter>
        </ModalDialog>
      </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}

// CreatedDialog: Modal showing the generated link with copy button
interface CreatedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  link: ShareLink | null;
}

function CreatedDialog({ open, onOpenChange, link }: CreatedDialogProps) {
  const [copied, setCopied] = useState(false);

  if (!link?.token) return null;

  const url = `${window.location.origin}/share/${link.token}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail if clipboard is not available
    }
  };

  return (
    <Modal isOpen={open} onOpenChange={onOpenChange}>
      <ModalBackdrop isDismissable>
        <ModalContainer>
          <ModalDialog className="w-[480px] max-w-[480px]">
            <ModalHeader>
              <ModalHeading>Share link created</ModalHeading>
              <Description className="text-sm text-muted">
                Send this to your friend. It works without a Gameplane account.
              </Description>
            </ModalHeader>

            <ModalBody className="gap-4">

              <div className="rounded-lg border-2 border-warning bg-warning/10 p-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-5 w-5 shrink-0 text-warning-soft-foreground" />
                  <div className="text-sm text-warning-soft-foreground">
                    <strong>You will not see this link again</strong>
                    <p className="mt-1">
                      Gameplane stores only a one-way hash of the token, so it can&apos;t be shown
                      or recovered after you close this dialog. Copy it now.
                    </p>
                  </div>
                </div>
              </div>

              <div className="relative rounded-lg border border-divider bg-surface p-2.5 px-3.5 pr-10">
                <div className="break-all font-mono text-[13px] text-foreground">{url}</div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1 h-7 w-7 min-w-0 p-0"
                  aria-label="Copy URL"
                  onPress={handleCopy}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </ModalBody>

            <ModalFooter className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-[5px] text-[13px]"
                onPress={handleCopy}
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? "Copied!" : "Copy link"}
              </Button>
              <Button
                size="sm"
                variant="primary"
                className="gap-[5px] text-[13px]"
                onPress={() => onOpenChange(false)}
              >
                Done
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}

// RevokeDialog: AlertDialog for confirming revocation
interface RevokeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linkId: string | null;
  serverName: string;
  ns?: string;
  onRevoked?: () => void;
}

function RevokeDialog({
  open,
  onOpenChange,
  linkId,
  serverName,
  ns,
  onRevoked,
}: RevokeDialogProps) {
  const resourceTarget = useResourceTarget({ name: serverName, namespace: ns });
  const resourceClient = useResourceClient(resourceTarget);
  const { Shares } = resourceClient;
  const revoke = useMutation({
    mutationFn: () => (linkId ? Shares.revoke(serverName, linkId, ns) : Promise.reject()),
    onSuccess: () => {
      onOpenChange(false);
      onRevoked?.();
    },
  });

  return (
    <AlertDialog isOpen={open} onOpenChange={onOpenChange}>
      <AlertDialogBackdrop
        isDismissable={!revoke.isPending}
        isKeyboardDismissDisabled={revoke.isPending}
      >
      <AlertDialogContainer>
        <AlertDialogDialog className="w-[440px] max-w-[440px] gap-0 rounded-[12px] p-5">
          <AlertDialogHeader className="m-0 p-0">
            <div className="flex items-center gap-3">
              <AlertDialogIcon status="danger" className="shrink-0">
                <AlertCircle className="h-5 w-5" />
              </AlertDialogIcon>
              <AlertDialogHeading>Revoke this share link?</AlertDialogHeading>
            </div>
          </AlertDialogHeader>

          <AlertDialogBody className="m-0 p-0 pt-4">
            <div className="space-y-4">
              <Description className="text-sm leading-[21px] text-muted">
                Anyone using this link will immediately lose access to {serverName}&apos;s status
                page. This action cannot be undone.
              </Description>
              {revoke.isError && (
                <div className="rounded-lg bg-danger/10 p-3 text-sm text-danger">
                  {errorText(revoke.error, "Failed to revoke link")}
                </div>
              )}
            </div>
          </AlertDialogBody>

          <AlertDialogFooter className="m-0 flex items-center justify-end gap-2 p-0 pt-5">
            <Button
              variant="ghost"
              size="sm"
              isDisabled={revoke.isPending}
              onPress={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              isDisabled={revoke.isPending}
              onPress={() => revoke.mutate()}
            >
              {revoke.isPending ? "Revoking…" : "Revoke link"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogDialog>
      </AlertDialogContainer>
      </AlertDialogBackdrop>
    </AlertDialog>
  );
}

// Main component
export function ShareLinksSection({ name, ns }: ShareLinksProps) {
  const resourceTarget = useResourceTarget({ name, namespace: ns });
  const resourceClient = useResourceClient(resourceTarget);
  const access = useResourceAccess();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createdLink, setCreatedLink] = useState<ShareLink | null>(null);
  const [createdOpen, setCreatedOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const { data: links, isLoading } = useQuery({
    queryKey: resourceKey(resourceTarget, "sharelinks", name, ns),
    queryFn: ({ signal }) => resourceClient.withSignal(signal).Shares.list(name, ns),
    enabled: !!name,
  });

  const handleLinkCreated = (link: ShareLink) => {
    setCreatedLink(link);
    setCreatedOpen(true);
    void qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "sharelinks", name, ns) });
  };

  const handleRevoked = () => {
    void qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "sharelinks", name, ns) });
  };

  const empty = !isLoading && (!links || links.length === 0);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">Share links</h3>
          <p className="mt-1 text-sm text-muted">
            Let people without a Gameplane account check this server&apos;s status and connection
            address. Only the owner can create or revoke links.
          </p>
        </div>
        <Button variant="primary" size="sm" isDisabled={!access?.isOwner} onPress={() => setCreateOpen(true)}>
          <Link2 className="h-4 w-4" />
          Create link
        </Button>
      </div>

      {empty ? (
        <div className="rounded-lg border border-dashed border-divider p-8 text-center">
          <Link2 className="mx-auto h-12 w-12 text-muted" />
          <h4 className="mt-3 font-medium">No share links yet</h4>
          <p className="mt-1 text-sm text-muted">
            Create a link so a friend without a Gameplane account can check this server&apos;s
            status and connect — without giving them access to the dashboard.
          </p>
          <Button
            variant="primary"
            size="sm"
            className="mt-4"
            isDisabled={!access?.isOwner} onPress={() => setCreateOpen(true)}
          >
            <Link2 className="h-4 w-4" />
            Create link
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-divider">
          <Table.Root className="table--mono">
            <Table.Content aria-label="Share links" keyboardNavigationBehavior="arrow">
              <Table.Header>
                <Table.Column isRowHeader>Created</Table.Column>
                <Table.Column>Expires</Table.Column>
                <Table.Column>Can start</Table.Column>
                <Table.Column>Status</Table.Column>
                <Table.Column />
              </Table.Header>
              <Table.Body>
                {links?.map((link) => (
                  <Table.Row key={link.id}>
                    <Table.Cell>{formatDate(link.createdAt)}</Table.Cell>
                    <Table.Cell>{formatDate(link.expiresAt)}</Table.Cell>
                    <Table.Cell>
                      <Chip
                        variant="soft"
                        size="sm"
                        className={link.canStart ? "text-success" : "text-foreground"}
                      >
                        {link.canStart ? "Can start" : "View only"}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>
                      <Chip
                        variant="soft"
                        size="sm"
                        color={statusColor(getLinkStatus(link.expiresAt, link.revokedAt))}
                      >
                        {getLinkStatus(link.expiresAt, link.revokedAt)}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>
                      {getLinkStatus(link.expiresAt, link.revokedAt) === "Active" ? (
                        <Button
                          variant="danger-soft"
                          size="sm"
                          onPress={() => {
                            if (!access?.isOwner) return;
                            setRevokeId(link.id);
                            setRevokeOpen(true);
                          }}
                        >
                          Revoke
                        </Button>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.Root>
        </div>
      )}

      <CreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        serverName={name}
        ns={ns}
        onLinkCreated={handleLinkCreated}
      />

      <CreatedDialog open={createdOpen} onOpenChange={setCreatedOpen} link={createdLink} />

      <RevokeDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        linkId={revokeId}
        serverName={name}
        ns={ns}
        onRevoked={handleRevoked}
      />
    </div>
  );
}
