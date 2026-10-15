import { useMemo, useState, type ReactNode } from "react";
import { useInstallation } from "@/lib/useInstallation";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Button,
  Card,
  Input,
  Tabs,
  Tab as TabComponent,
  Table,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownPopover,
  DropdownSection,
  DropdownItem,
  Modal,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter,
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContainer,
  Alert,
  Select,
  ListBox,
  ListBoxItem,
} from "@heroui/react";
import {
  Bot,
  Fingerprint,
  KeyRound,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  ScrollText,
  Search,
  ShieldCheck,
  Trash2,
  UsersRound,
} from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { RoleEditorModal } from "@/components/ui/RoleEditorModal";
import { InviteUserDialog } from "@/components/ui/admin/InviteUserDialog";
import { EditUserDialog } from "@/components/ui/admin/EditUserDialog";
import { ResetPasswordDialog } from "@/components/ui/admin/ResetPasswordDialog";
import { NetworksTab } from "@/routes/UsersNetworks";
import { APIError } from "@/lib/api";
import { useMe, can } from "@/lib/auth";
import {
  Users as UsersAPI,
  Roles as RolesAPI,
  Clusters,
  type UserUpdate,
} from "@/lib/endpoints";
import { formatRelative } from "@/lib/utils";
import type { ExtendedUser, Role, RoleBinding } from "@/types";

type TabKey = "users" | "roles" | "networks" | "service" | "idp";

const TABS: { id: TabKey; label: string; icon: ReactNode }[] = [
  { id: "users", label: "Users", icon: <UsersRound className="h-4 w-4" /> },
  { id: "roles", label: "Roles", icon: <ShieldCheck className="h-4 w-4" /> },
  { id: "networks", label: "Networks", icon: <Network className="h-4 w-4" /> },
  { id: "service", label: "Service accounts", icon: <Bot className="h-4 w-4" /> },
  { id: "idp", label: "Identity providers", icon: <Fingerprint className="h-4 w-4" /> },
];

const roleColor: Record<string, string> = {
  admin: "bg-warning/15 text-warning",
  operator: "bg-violet/15 text-violet",
  viewer: "bg-default/60 text-muted",
};

function apiErrorText(error: unknown): string | undefined {
  if (!error) return undefined;
  return error instanceof APIError
    ? error.body || `Request failed (${error.status})`
    : (error as Error).message;
}

function roleGrantsUserManagement(roles: Role[], name: string): boolean {
  const r = roles.find((x) => x.name === name);
  return !!r && (r.permissions.includes("*") || r.permissions.includes("users:manage"));
}

function useRolesQuery() {
  return useQuery({ queryKey: ["roles"], queryFn: () => RolesAPI.list() });
}

export function UsersPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const canAudit = can(me, "audit:read");
  const [tab, setTab] = useState<TabKey>("users");
  const [q, setQ] = useState("");
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<ExtendedUser | null>(null);
  const [resetting, setResetting] = useState<ExtendedUser | null>(null);
  const [deleting, setDeleting] = useState<ExtendedUser | null>(null);

  const { data: users = [], error } = useQuery({
    queryKey: ["users"],
    queryFn: () => UsersAPI.list(),
  });
  const { data: roles = [] } = useRolesQuery();

  const counts = useMemo(
    () => ({
      users: users.length,
      roles: roles.length,
    }),
    [users, roles],
  );

  const visible = users.filter((u) => {
    if (q) {
      const s = q.toLowerCase();
      return (
        u.username.toLowerCase().includes(s) ||
        (u.email ?? "").toLowerCase().includes(s) ||
        (u.displayName ?? "").toLowerCase().includes(s)
      );
    }
    return true;
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["users"] });
  };

  const create = useMutation({
    mutationFn: UsersAPI.create,
    onSuccess: () => {
      invalidate();
      setInviting(false);
    },
  });
  const save = useMutation({
    mutationFn: ({ id, body }: { id: number; body: UserUpdate }) => UsersAPI.update(id, body),
    onSuccess: () => {
      invalidate();
      setEditing(null);
    },
  });
  const reset = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      UsersAPI.resetPassword(id, password),
    onSuccess: () => setResetting(null),
  });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Users & RBAC"
        description="Manage access to the Gameplane control plane."
        actions={
          <div className="flex items-center gap-2">
            {canAudit && (
              <Link
                to="/admin/audit"
                className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface"
              >
                <ScrollText className="h-4 w-4" /> Audit log
              </Link>
            )}
            <Button onPress={() => setInviting(true)} variant="primary">
              <Plus className="h-4 w-4" /> Invite user
            </Button>
          </div>
        }
      />

      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => setTab(key as TabKey)}
        variant="secondary"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="-mx-1 flex min-w-0 overflow-x-auto px-1">
            <Tabs.List aria-label="Users and access sections" className="servers-status-filter">
              {TABS.map((t) => (
                <TabComponent key={t.id} id={t.id}>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    {t.icon}
                    {t.label}
                    {(t.id === "users" || t.id === "roles") && (
                      <span aria-hidden="true" className="servers-status-filter__count rounded-[4px] bg-foreground/10 px-1.5 py-0.5 text-xs leading-none">{counts[t.id]}</span>
                    )}
                  </span>
                </TabComponent>
              ))}
            </Tabs.List>
          </div>
          {tab === "users" && (
            <div className="relative w-full sm:ml-auto sm:w-64 sm:shrink-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input
                className="pl-9"
                placeholder={tab === "users" ? "Search users…" : "Search…"}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search users"
              />
            </div>
          )}
        </div>

        <Tabs.Panel id="users">
            {error instanceof APIError && (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Title>Failed to load users.</Alert.Title>
                {error.body && <Alert.Description>{error.body}</Alert.Description>}
              </Alert>
            )}

            <div className="overflow-hidden rounded-lg border border-border bg-card">
            <Table.Root className="bg-transparent">
              <Table.ScrollContainer>
                <Table.Content aria-label="Users list" keyboardNavigationBehavior="arrow">
                  <Table.Header>
                    <Table.Column id="user" isRowHeader>User</Table.Column>
                    <Table.Column id="role">Role</Table.Column>
                    <Table.Column id="provider">Provider</Table.Column>
                    <Table.Column id="created">Created</Table.Column>
                    <Table.Column id="actions" className="text-right" aria-label="Actions" />
                  </Table.Header>
                  <Table.Body
                    renderEmptyState={() => <EmptyState icon={<UsersRound />} title="No entries." />}
                  >
                    {visible.map((u) => (
                  <Table.Row key={u.id}>
                    <Table.Cell>
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-xs text-accent">
                          {(u.displayName || u.username).slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-mono text-sm text-foreground">
                            {u.username}
                            {me && me.id === u.id && (
                              <span className="ml-2 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] text-foreground/70">
                                you
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[11px] text-foreground/60">
                            {u.displayName || u.email || "—"}
                          </div>
                          {u.email && u.displayName && u.displayName !== u.email && (
                            <div className="truncate text-[11px] text-foreground/60">{u.email}</div>
                          )}
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <span className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${roleColor[u.role] ?? "bg-default/60 text-muted"}`}>
                        {u.role}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="rounded-md px-2 py-0.5 text-[10px] font-medium uppercase text-muted ring-1 ring-border">
                        {u.provider === "oidc" ? "OIDC" : u.provider === "pending" ? "Pending" : "Local"}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="text-foreground/60">{formatRelative(u.createdAt)}</Table.Cell>
                    <Table.Cell>
                      <Dropdown>
                        <DropdownTrigger
                          className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-default-100 text-foreground/60 hover:text-foreground"
                          aria-label={`Actions for ${u.username}`}
                        >
                          <>
                            <MoreHorizontal className="h-4 w-4" />
                          </>
                        </DropdownTrigger>
                        <DropdownPopover>
                          <DropdownMenu aria-label={`Actions for ${u.username}`}>
                            <DropdownItem
                              key="edit"
                              onPress={() => setEditing(u)}
                            >
                              <div className="flex items-center gap-2">
                                <Pencil className="h-4 w-4" />
                                Edit user
                              </div>
                            </DropdownItem>
                            <DropdownItem
                              key="reset"
                              isDisabled={u.provider === "oidc"}
                              onPress={() => setResetting(u)}
                              aria-label={u.provider === "oidc" ? "Reset password: Account is OIDC-managed" : "Reset password"}
                            >
                              <div className="flex items-center gap-2" title={u.provider === "oidc" ? "Account is OIDC-managed" : undefined}>
                                <KeyRound className="h-4 w-4" />
                                Reset password
                              </div>
                            </DropdownItem>
                            <DropdownSection>
                              <DropdownItem
                                key="delete"
                                variant="danger"
                                isDisabled={Boolean(me && me.id === u.id)}
                                onPress={() => setDeleting(u)}
                              >
                                <div className="flex items-center gap-2">
                                  <Trash2 className="h-4 w-4" />
                                  Delete user
                                </div>
                              </DropdownItem>
                            </DropdownSection>
                          </DropdownMenu>
                        </DropdownPopover>
                      </Dropdown>
                    </Table.Cell>
                  </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table.Root>
            </div>
          </Tabs.Panel>

          <Tabs.Panel id="roles">
            <RolesTab />
          </Tabs.Panel>

          <Tabs.Panel id="networks">
            <NetworksTab />
          </Tabs.Panel>

          <Tabs.Panel id="service">
            <ServiceAccountsTab />
          </Tabs.Panel>

          <Tabs.Panel id="idp">
            <IdpTab />
          </Tabs.Panel>
      </Tabs>

      <InviteUserDialog
        open={inviting}
        onOpenChange={(open) => {
          if (!open) {
            setInviting(false);
            create.reset();
          }
        }}
        roles={roles.map((r) => r.name)}
        contactFieldsOptional
        disableSubmitUntilValid
        isLoading={create.isPending}
        apiError={apiErrorText(create.error)}
        submitLabel="Create user"
        onInvite={(username, displayName, email, password, role) => {
          create.mutate({
            username,
            displayName: displayName || undefined,
            email: email || undefined,
            password: password || undefined,
            role: role ?? "member",
          });
        }}
      />
      {editing && (
        <EditUserDialog
          key={editing.id}
          open
          onOpenChange={(open) => {
            if (!open) {
              setEditing(null);
              save.reset();
            }
          }}
          username={editing.username}
          displayName={editing.displayName ?? ""}
          email={editing.email ?? ""}
          role={editing.role}
          roles={roles.map((r) => r.name)}
          isMe={!!me && me.id === editing.id}
          roleGrantsUserManagement={(r) => roleGrantsUserManagement(roles, r)}
          isLoading={save.isPending}
          apiError={apiErrorText(save.error)}
          contactFieldsOptional
          extraContent={<NamespaceGrants userId={editing.id} roles={roles} />}
          onSave={(displayName, email, role) => {
            const dirty: UserUpdate = {};
            if (displayName !== (editing.displayName ?? "")) dirty.displayName = displayName;
            if (email !== (editing.email ?? "")) dirty.email = email;
            if (role !== editing.role) dirty.role = role;
            if (Object.keys(dirty).length === 0) return;
            save.mutate({ id: editing.id, body: dirty });
          }}
        />
      )}
      {resetting && (
        <ResetPasswordDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setResetting(null);
              reset.reset();
            }
          }}
          username={resetting.username}
          disableSubmitUntilValid
          isLoading={reset.isPending}
          apiError={apiErrorText(reset.error)}
          submitLabel="Set new password"
          onReset={(password) => reset.mutate({ id: resetting.id, password })}
        />
      )}
      {deleting && (
        <DeleteUserDialog
          user={deleting}
          isMe={!!me && me.id === deleting.id}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            invalidate();
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  const text =
    error instanceof APIError
      ? error.body || `Request failed (${error.status})`
      : (error as Error).message;
  return (
    <p role="alert" className="pt-2 text-xs text-danger">
      {text}
    </p>
  );
}

function DeleteUserDialog({
  user,
  isMe,
  onClose,
  onDeleted,
}: {
  user: ExtendedUser;
  isMe: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => UsersAPI.remove(user.id),
    onSuccess: onDeleted,
  });

  return (
    <AlertDialog isOpen onOpenChange={(open) => !open && onClose()}>
      <AlertDialogBackdrop isDismissable={!remove.isPending} isKeyboardDismissDisabled={remove.isPending}>
        <AlertDialogContainer>
          <Modal>
            <ModalDialog role="alertdialog" className="max-w-md">
              <ModalHeader>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger"><Trash2 className="h-5 w-5" /></span>
                <ModalHeading>Delete {user.username}?</ModalHeading>
              </ModalHeader>
              <ModalBody>
                {isMe ? (
                  <p className="text-sm text-danger">You can&apos;t delete your own account.</p>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm">
                      Their sessions will be revoked and they&apos;ll lose access immediately. This cannot be undone.
                    </p>
                    <ErrorLine error={remove.error} />
                  </div>
                )}
              </ModalBody>
              <ModalFooter className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={onClose}
                  isDisabled={remove.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  isDisabled={isMe || remove.isPending}
                  onPress={() => remove.mutate()}
                >
                  {isMe ? "Cannot delete" : "Delete user"}
                </Button>
              </ModalFooter>
            </ModalDialog>
          </Modal>
        </AlertDialogContainer>
      </AlertDialogBackdrop>
    </AlertDialog>
  );
}

function RolesTab() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: roles = [] } = useRolesQuery();
  const { data: catalog } = useQuery({
    queryKey: ["permission-catalog"],
    queryFn: () => RolesAPI.catalog(),
  });
  const canManage = can(me, "roles:manage");
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["roles"] });
  const groups = catalog?.groups ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {canManage && (
          <Button onPress={() => setCreating(true)} variant="primary">
            <Plus className="h-4 w-4" /> New role
          </Button>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {roles.map((r) => (
          <Card key={r.name} className="flex flex-col gap-3 border border-border p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"><ShieldCheck className="h-[18px] w-[18px]" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-sm font-medium">{r.name}</span>
                  {r.builtin && (
                    <span className="shrink-0 rounded-md bg-default/60 px-1.5 py-0.5 text-[10px] uppercase text-muted">
                      built-in
                    </span>
                  )}
                </div>
                <p className="min-h-8 pt-1 text-xs text-muted">{r.description || "—"}</p>
              </div>
            </div>
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3">
              <span className="rounded-full bg-default/60 px-2 py-0.5 text-[11px] text-muted">
                {r.permissions.includes("*")
                  ? "all permissions"
                  : `${r.permissions.length} permission${r.permissions.length === 1 ? "" : "s"}`}
              </span>
              {canManage && (
                <div className="flex gap-1">
                  {r.name !== "admin" && (
                    <Button variant="ghost" className="h-7 px-2 text-xs" onPress={() => setEditing(r)}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                  )}
                  {!r.builtin && (
                    <Button
                      variant="ghost"
                      className="h-7 px-2 text-xs text-danger"
                      onPress={() => setDeleting(r)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>

      {(creating || editing) && (
        <RoleEditorModal
          open
          onOpenChange={(open) => {
            if (!open) {
              setCreating(false);
              setEditing(null);
            }
          }}
          role={editing}
          groups={groups}
          onSaved={() => {
            refresh();
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <DeleteRoleDialog
          role={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            refresh();
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

function DeleteRoleDialog({
  role,
  onClose,
  onDeleted,
}: {
  role: Role;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => RolesAPI.remove(role.name),
    onSuccess: onDeleted,
  });

  return (
    <AlertDialog isOpen onOpenChange={(open) => !open && onClose()}>
      <AlertDialogBackdrop isDismissable={!remove.isPending} isKeyboardDismissDisabled={remove.isPending}>
        <AlertDialogContainer>
          <Modal>
            <ModalDialog role="alertdialog" className="max-w-md">
              <ModalHeader>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger"><Trash2 className="h-5 w-5" /></span>
                <ModalHeading>Delete role {role.name}?</ModalHeading>
              </ModalHeader>
              <ModalBody>
                <div className="space-y-2">
                  <p className="text-sm">
                    This can&apos;t be undone. Roles assigned to a user can&apos;t be deleted.
                  </p>
                  <ErrorLine error={remove.error} />
                </div>
              </ModalBody>
              <ModalFooter className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={onClose}
                  isDisabled={remove.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  isDisabled={remove.isPending}
                  onPress={() => remove.mutate()}
                >
                  Delete role
                </Button>
              </ModalFooter>
            </ModalDialog>
          </Modal>
        </AlertDialogContainer>
      </AlertDialogBackdrop>
    </AlertDialog>
  );
}

function NamespaceGrants({ userId, roles }: { userId: number; roles: Role[] }) {
  const installation = useInstallation();
  if (installation.isPending) return <p className="text-xs text-muted">Loading installation…</p>;
  if (installation.isError) return <p className="text-xs text-danger">Couldn&apos;t load installation capabilities.</p>;
  return <NamespaceGrantsForm userId={userId} roles={roles} standalone={installation.data.standalone} />;
}

function NamespaceGrantsForm({ userId, roles, standalone }: { userId: number; roles: Role[]; standalone: boolean }) {
  const qc = useQueryClient();
  const [roleName, setRoleName] = useState(
    roles.find((r) => r.name === "operator")?.name ?? roles[0]?.name ?? "",
  );
  const [cluster, setCluster] = useState(standalone ? "" : "local");
  const [namespace, setNamespace] = useState("");

  const { data: bindings = [], error: bindingsError } = useQuery({
    queryKey: ["user-bindings", userId],
    queryFn: () => UsersAPI.bindings(userId),
  });
  const { data: clusters, error: clustersError } = useQuery({
    queryKey: ["clusters"],
    queryFn: () => Clusters.list(),
  });
  const { data: catalog, error: catalogError } = useQuery({
    queryKey: ["permission-catalog"],
    queryFn: () => RolesAPI.catalog(),
  });
  const namespacedPermissions = new Set(
    catalog?.groups.flatMap((group) => group.permissions.filter((p) => p.namespaced).map((p) => p.key)) ?? [],
  );
  const allowsRemoteWideGrant = (name: string) => {
    const role = roles.find((r) => r.name === name);
    return !!role && !!catalog &&
      role.permissions.every((p) => ["cluster:read", "modules:read", "modules:manage", "templates:read", "templates:write"].includes(p) || namespacedPermissions.has(p));
  };
  const allNamespacesAllowed = !!cluster && cluster !== "local" && cluster !== "*" && allowsRemoteWideGrant(roleName);
  const scopeError = namespace.trim() === "*" && !allNamespacesAllowed
    ? cluster === "local"
      ? "The local primary role is managed above. Choose a namespace for an additional local grant."
      : "All namespaces requires a role containing only workload cluster permissions. Central administration permissions are not allowed."
    : undefined;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["user-bindings", userId] });

  const add = useMutation({
    mutationFn: (b: RoleBinding) => UsersAPI.addBinding(userId, b),
    onSuccess: () => {
      setNamespace("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (b: RoleBinding) => UsersAPI.removeBinding(userId, b.roleName, b.namespace, b.cluster ?? "local"),
    onSuccess: refresh,
  });

  return (
    <div className="space-y-2">
      <div className="text-[11px] leading-[14px] font-semibold uppercase tracking-wider text-muted">
        Cluster & namespace grants
      </div>
      <p className="text-xs text-foreground/60">
        {standalone ? "The primary role above manages panel access." : "The primary role above manages local access."} Additional grants apply only to their named cluster and namespace.
      </p>
      {bindings.length > 0 && (
        <ul className="space-y-1">
          {bindings.map((b) => {
            const bindingCluster = b.cluster ?? "local";
            const primary = bindingCluster === "local" && b.namespace === "*";
            const managed = primary || bindingCluster === "*" ||
              (b.namespace === "*" && !allowsRemoteWideGrant(b.roleName));
            return (
              <li key={`${bindingCluster}/${b.roleName}/${b.namespace}`} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono">{b.roleName}</span>
                <span className="text-foreground/60">in</span>
                <span className="font-mono">{b.namespace === "*" ? "all namespaces" : b.namespace}</span>
                <span className="text-foreground/60">on</span>
                <span className="font-mono">{standalone && primary ? "panel" : bindingCluster}</span>
                {managed ? (
                  <span className="ml-auto text-foreground/60">{primary ? "Primary role (managed above)" : "Managed outside this editor"}</span>
                ) : (
                  <button
                    type="button"
                    className="ml-auto rounded p-1 text-foreground/60 hover:text-danger disabled:opacity-50"
                    aria-label={`Remove ${b.roleName} in ${b.namespace} on ${bindingCluster}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(b)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <Select
          aria-label="Grant cluster"
          placeholder="Select a workload cluster"
          value={cluster}
          onChange={(v) => {
            setCluster(String(v));
            if (String(v) === "local" && namespace.trim() === "*") setNamespace("");
          }}
        >
          <Select.Trigger className="w-full items-center rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface/80">
            <Select.Value className="text-[var(--field-placeholder)]" />
            <Select.Indicator className="ml-auto h-4 w-4" />
          </Select.Trigger>
          <Select.Popover className="rounded border border-border">
            <ListBox className="p-0" aria-label="Grant cluster">
              {!standalone && <ListBoxItem id="local">Local cluster</ListBoxItem>}
              {(clusters?.items ?? []).filter((c) => c.name !== "local").map((c) => (
                <ListBoxItem key={c.name} id={c.name}>
                  {c.displayName ? `${c.displayName} (${c.name})` : c.name}
                </ListBoxItem>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <div data-grant-role>
          <Select
            aria-label="Grant role"
            value={roleName}
            onChange={(v) => setRoleName(String(v))}
          >
            <Select.Trigger className="w-full items-center rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface/80">
              <Select.Value className="text-[var(--field-placeholder)]" />
              <Select.Indicator className="ml-auto h-4 w-4" />
            </Select.Trigger>
            <Select.Popover className="rounded border border-border">
              <ListBox className="p-0" aria-label="Grant role">
                {roles.map((r) => (
                  <ListBoxItem key={r.name} id={r.name}>{r.name}</ListBoxItem>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-0 flex-1"
          style={{ height: 32 }}
          value={namespace}
          onChange={(e) => setNamespace(e.target.value)}
          placeholder="namespace"
          aria-label="Grant namespace"
        />
        <Button
          variant="ghost"
          size="sm"
          isDisabled={!allNamespacesAllowed}
          onPress={() => setNamespace("*")}
        >
          All namespaces
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-[13px]"
          isDisabled={!cluster || (standalone && !clusters?.items.some((item) => item.name === cluster)) || !roleName || !namespace.trim() || !!scopeError || !!clustersError || add.isPending}
          onPress={() => add.mutate({ roleName, namespace: namespace.trim(), cluster })}
        >
          Add
        </Button>
      </div>
      <p className="text-xs text-foreground/60">
        For remote node inventory, create a role in the Roles tab with “View nodes, version, and storage”, then grant it to all namespaces on that cluster.
      </p>
      {scopeError && <p role="alert" className="text-xs text-danger">{scopeError}</p>}
      <ErrorLine error={bindingsError || clustersError || catalogError || add.error || remove.error} />
    </div>
  );
}

function IdpTab() {
  return (
    <Card className="border border-border">
      <EmptyState icon={<Fingerprint />} title="Identity providers" hint="OIDC identity providers configured in Helm values appear here. UI configuration is tracked for v1.1." />
    </Card>
  );
}

function ServiceAccountsTab() {
  return (
    <Card className="border border-border">
      <EmptyState icon={<Bot />} title="Service accounts" hint="Service accounts (machine-to-machine API tokens) are tracked for v1.1." />
    </Card>
  );
}
