import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Button, Card, Input, Label, ListBox, ListBoxItem, Select } from "@heroui/react";
import { ArrowLeft, Check, KeyRound, Network as NetworkIcon, Plus, Server, Trash2, UsersRound, X } from "lucide-react";
import { defineMessages } from "react-intl";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { GameIcon } from "@/components/ui/GameIcon";
import { ResetPasswordDialog } from "@/components/ui/admin/ResetPasswordDialog";
import { NamespaceGrants, DeleteUserDialog, roleGrantsUserManagement } from "@/routes/Users";
import { NETWORK_ANNOTATION } from "@/lib/annotations";
import { useMe } from "@/lib/auth";
import { useFleetGameCodes, useFleetServers, templateKey, type FleetItem } from "@/lib/fleet";
import { errorTextIntl } from "@/lib/errors";
import { PermissionChips } from "@/lib/permissions";
import { Networks, Roles, ServerGrants, Users, type UserUpdate } from "@/lib/endpoints";
import { formatRelative } from "@/lib/utils";
import { useOptionalIntl } from "@/lib/i18n/format";
import type { GameServer, Network, ServerGrant } from "@/types";

const PROVIDER_MESSAGES = defineMessages({
  local: { id: "web.routes.user_edit.provider_local", defaultMessage: "Local", description: "User edit: chip for an account that signs in with a local password; keep it short" },
  oidc: { id: "web.routes.user_edit.provider_oidc", defaultMessage: "OIDC", description: "User edit: chip for an account that signs in through OIDC; keep it short" },
  pending: { id: "web.routes.user_edit.provider_pending", defaultMessage: "Pending", description: "User edit: chip for an invited account that has not signed in yet; keep it short" },
});

const SECTIONS = [
  { id: "profile", label: { id: "web.routes.user_edit.section_profile", defaultMessage: "Profile", description: "User edit: section navigation link to the profile card; keep it short" } },
  { id: "role", label: { id: "web.routes.user_edit.section_role", defaultMessage: "Role", description: "User edit: section navigation link to the role and cluster grants card; keep it short" } },
  { id: "servers", label: { id: "web.routes.user_edit.section_servers", defaultMessage: "Servers", description: "User edit: section navigation link to the server access card; keep it short" } },
  { id: "networks", label: { id: "web.routes.user_edit.section_networks", defaultMessage: "Networks", description: "User edit: section navigation link to the networks card; keep it short" } },
  { id: "danger", label: { id: "web.routes.user_edit.section_danger", defaultMessage: "Danger zone", description: "User edit: section navigation link to the danger zone card; keep it short" } },
] as const;

const DEFAULT_GRANT: string[] = ["servers:console"];

interface Draft {
  displayName?: string;
  email?: string;
  role?: string;
}

interface ServerRow {
  cluster: string;
  namespace: string;
  server: string;
  game?: string;
  via?: string;
  permissions: string[];
  direct: boolean;
}

interface Membership {
  name: string;
  permissions: string[];
}

const serverKey = (cluster: string, namespace: string, name: string) => JSON.stringify([cluster, namespace, name]);

export function UserEditPage() {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { id } = useParams({ from: "/app-layout/users/$id" });
  const userId = Number(id);
  const { data: me } = useMe();
  const { data: users = [], isPending: usersPending } = useQuery({ queryKey: ["users"], queryFn: () => Users.list() });
  const { data: roles = [] } = useQuery({ queryKey: ["roles"], queryFn: () => Roles.list() });
  const { data: grants = [] } = useQuery({ queryKey: ["server-grants", userId], queryFn: () => ServerGrants.list(userId) });
  const { data: networks = [] } = useQuery({ queryKey: ["networks"], queryFn: () => Networks.list() });
  const fleet = useFleetServers();
  const fleetItems: FleetItem<GameServer>[] = fleet.data?.items ?? [];
  const { gameCodes, byName } = useFleetGameCodes(fleetItems);

  const [draft, setDraft] = useState<Draft>({});
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [serverQuery, setServerQuery] = useState("");
  const [selected, setSelected] = useState<Map<string, FleetItem<GameServer>>>(new Map());
  const [grantPermissions, setGrantPermissions] = useState<string[]>(DEFAULT_GRANT);
  const [joinName, setJoinName] = useState("");
  const [joinPermissions, setJoinPermissions] = useState<string[]>(DEFAULT_GRANT);

  const user = users.find((candidate) => candidate.id === userId);
  const invalidateGrants = () => void qc.invalidateQueries({ queryKey: ["server-grants", userId] });
  const invalidateNetworks = () => void qc.invalidateQueries({ queryKey: ["networks"] });

  const save = useMutation({
    mutationFn: (body: UserUpdate) => Users.update(userId, body),
    onSuccess: () => {
      setDraft({});
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const reset = useMutation({
    mutationFn: (password: string) => Users.resetPassword(userId, password),
    onSuccess: () => setResetting(false),
  });
  const putGrant = useMutation({
    mutationFn: (grant: ServerGrant) => ServerGrants.put(grant),
    onSuccess: invalidateGrants,
  });
  const removeGrant = useMutation({
    mutationFn: (row: ServerRow) => ServerGrants.remove({ userId, cluster: row.cluster, namespace: row.namespace, server: row.server }),
    onSuccess: invalidateGrants,
  });
  const addGrants = useMutation({
    mutationFn: (items: FleetItem<GameServer>[]) => Promise.all(items.map((item) => ServerGrants.put({
      userId,
      cluster: item.target.cluster,
      namespace: item.target.namespace,
      server: item.target.name,
      permissions: grantPermissions,
    }))),
    onSuccess: () => {
      invalidateGrants();
      setAdding(false);
      setSelected(new Map());
      setServerQuery("");
    },
  });
  const setMembership = useMutation({
    mutationFn: ({ name, permissions }: { name: string; permissions: string[] }) => Networks.addMember(name, userId, permissions),
    onSuccess: invalidateNetworks,
  });
  const removeMembership = useMutation({
    mutationFn: (name: string) => Networks.removeMember(name, userId),
    onSuccess: invalidateNetworks,
  });
  const joinNetwork = useMutation({
    mutationFn: () => Networks.addMember(joinName, userId, joinPermissions),
    onSuccess: () => {
      invalidateNetworks();
      setJoinName("");
    },
  });

  if (usersPending) return null;

  if (!user) {
    return (
      <div className="space-y-6 p-6">
        <Link to="/users" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.user_edit.back_to_users", defaultMessage: "Back to users", description: "User edit: link that returns to the users list; keep it short" })}
        </Link>
        <Card className="border border-border">
          <EmptyState icon={<UsersRound />} title={intl.formatMessage({ id: "web.routes.user_edit.user_not_found", defaultMessage: "User not found", description: "User edit: empty state title when no user matches the id in the URL" })} />
        </Card>
      </div>
    );
  }

  const isMe = me?.id === userId;
  const displayName = draft.displayName ?? user.displayName;
  const email = draft.email ?? user.email;
  const role = draft.role ?? user.role;
  const profileBody: UserUpdate = {
    ...(displayName !== user.displayName ? { displayName } : {}),
    ...(email !== user.email ? { email } : {}),
    ...(role !== user.role ? { role } : {}),
  };
  const dirty = Object.keys(profileBody).length > 0;
  const wouldDemoteSelf = isMe && role !== user.role && !roleGrantsUserManagement(roles, role);

  const memberships: Membership[] = networks
    .filter((network) => network.members.some((member) => member.id === userId))
    .map((network) => ({ name: network.name, permissions: network.members.find((member) => member.id === userId)?.permissions ?? [] }));
  const directKeys = new Set(grants.map((grant) => serverKey(grant.cluster, grant.namespace, grant.server)));
  const directRows: ServerRow[] = grants.map((grant) => ({
    cluster: grant.cluster,
    namespace: grant.namespace,
    server: grant.server,
    game: fleetItems.find((item) => serverKey(item.target.cluster, item.target.namespace, item.target.name) === serverKey(grant.cluster, grant.namespace, grant.server))?.resource.spec.templateRef.name,
    permissions: grant.permissions,
    direct: true,
  }));
  const networkRows: ServerRow[] = fleetItems.flatMap((item) => {
    const membership = memberships.find((candidate) => candidate.name === item.resource.metadata.annotations?.[NETWORK_ANNOTATION]);
    if (!membership || directKeys.has(serverKey(item.target.cluster, item.target.namespace, item.target.name))) return [];
    return [{
      cluster: item.target.cluster,
      namespace: item.target.namespace,
      server: item.target.name,
      game: item.resource.spec.templateRef.name,
      via: membership.name,
      permissions: membership.permissions,
      direct: false,
    }];
  });
  const serverRows = [...directRows, ...networkRows];
  const candidates = fleetItems.filter((item) => {
    if (directKeys.has(serverKey(item.target.cluster, item.target.namespace, item.target.name))) return false;
    return item.target.name.toLowerCase().includes(serverQuery.trim().toLowerCase());
  });
  const joinable = networks.filter((network: Network) => !memberships.some((membership) => membership.name === network.name));
  const grantError = putGrant.error ?? removeGrant.error ?? addGrants.error;
  const networkError = setMembership.error ?? removeMembership.error ?? joinNetwork.error;

  const toggleSelected = (item: FleetItem<GameServer>) => {
    const key = serverKey(item.target.cluster, item.target.namespace, item.target.name);
    const next = new Map(selected);
    if (next.has(key)) next.delete(key);
    else next.set(key, item);
    setSelected(next);
  };

  const dirtyNote = intl.formatMessage({ id: "web.routes.user_edit.unsaved_changes", defaultMessage: "Unsaved changes", description: "User edit: label in the sticky save bar when the profile or role has unsaved edits" });

  return (
    <div className="space-y-6 p-6 pb-24">
      <Link to="/users" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.user_edit.back_to_users", defaultMessage: "Back to users", description: "User edit: link that returns to the users list; keep it short" })}
      </Link>
      <PageHeader
        title={intl.formatMessage({ id: "web.routes.user_edit.edit_user", defaultMessage: "Edit user", description: "User edit: page title for editing one user account" })}
        description={intl.formatMessage({ id: "web.routes.user_edit.edit_user_description", defaultMessage: "Update the profile, role and server access for this account.", description: "User edit: description under the page title" })}
        actions={
          <Button variant="outline" onPress={() => setResetting(true)} isDisabled={user.provider === "oidc"}>
            <KeyRound className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.user_edit.reset_password", defaultMessage: "Reset password", description: "User edit: button that opens the reset-password dialog; disabled for OIDC-managed accounts; keep it short" })}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <Card className="flex flex-col gap-4 border border-border p-6">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-sm text-accent">
                {(user.displayName || user.username).slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0">
                <div className="truncate text-base font-semibold">{user.displayName || user.username}</div>
                <div className="truncate font-mono text-xs text-muted">{intl.formatMessage({ id: "web.routes.user_edit.username_handle", defaultMessage: "@{username}", description: "User edit: @-prefixed username shown under the display name; {username} is the account username" }, { username: user.username })}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <span className="rounded-full bg-default/60 px-2 py-0.5 text-[11px] text-muted">{role}</span>
              <span className="rounded-full bg-default/60 px-2 py-0.5 text-[11px] text-muted">
                {user.provider === "oidc"
                  ? intl.formatMessage(PROVIDER_MESSAGES.oidc)
                  : user.provider === "pending"
                    ? intl.formatMessage(PROVIDER_MESSAGES.pending)
                    : intl.formatMessage(PROVIDER_MESSAGES.local)}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <dt className="text-muted">{intl.formatMessage({ id: "web.routes.user_edit.created", defaultMessage: "Created", description: "User edit: profile card label for when the account was created" })}</dt>
              <dd className="text-right">{formatRelative(user.createdAt, intl)}</dd>
              <dt className="text-muted">{intl.formatMessage({ id: "web.routes.user_edit.servers", defaultMessage: "Servers", description: "User edit: profile card label for the number of servers the user can access" })}</dt>
              <dd className="text-right">{serverRows.length}</dd>
              <dt className="text-muted">{intl.formatMessage({ id: "web.routes.user_edit.networks", defaultMessage: "Networks", description: "User edit: profile card label for the number of networks the user belongs to" })}</dt>
              <dd className="text-right">{memberships.length}</dd>
            </dl>
          </Card>
          <nav aria-label={intl.formatMessage({ id: "web.routes.user_edit.sections", defaultMessage: "Sections", description: "User edit: accessible name of the section navigation; not visible on screen" })} className="flex gap-1 overflow-x-auto lg:flex-col">
            {SECTIONS.map((section) => (
              <a key={section.id} href={`#${section.id}`} className="shrink-0 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface hover:text-foreground">
                {intl.formatMessage(section.label)}
              </a>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 space-y-6">
          <Card id="profile" className="space-y-4 border border-border p-6">
            <SectionHeader
              title={intl.formatMessage({ id: "web.routes.user_edit.profile", defaultMessage: "Profile", description: "User edit: title of the profile card" })}
              description={intl.formatMessage({ id: "web.routes.user_edit.profile_description", defaultMessage: "Name and contact details shown across the dashboard.", description: "User edit: description of the profile card" })}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="user-edit-display-name" className="text-xs">{intl.formatMessage({ id: "web.routes.user_edit.display_name", defaultMessage: "Display name", description: "User edit: label of the display name input" })}</Label>
                <Input id="user-edit-display-name" value={displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="user-edit-email" className="text-xs">{intl.formatMessage({ id: "web.routes.user_edit.email", defaultMessage: "Email", description: "User edit: label of the email input" })}</Label>
                <Input id="user-edit-email" type="email" value={email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label className="text-xs">{intl.formatMessage({ id: "web.routes.user_edit.username", defaultMessage: "Username", description: "User edit: label of the read-only username field" })}</Label>
                <Input value={user.username} readOnly disabled className="font-mono" />
              </div>
            </div>
          </Card>

          <Card id="role" className="space-y-4 border border-border p-6">
            <SectionHeader
              title={intl.formatMessage({ id: "web.routes.user_edit.role_and_cluster_grants", defaultMessage: "Role and cluster grants", description: "User edit: title of the role card" })}
              description={intl.formatMessage({ id: "web.routes.user_edit.role_description", defaultMessage: "The primary role applies across the cluster; namespace grants refine it.", description: "User edit: description of the role card" })}
            />
            <div className="flex flex-col gap-1.5">
              <Select value={role} onChange={(value) => setDraft({ ...draft, role: String(value) })} className="flex flex-col gap-1.5">
                <Label className="text-xs">{intl.formatMessage({ id: "web.routes.user_edit.primary_role", defaultMessage: "Primary role (cluster-wide)", description: "User edit: label of the primary role dropdown; the role applies across the whole cluster" })}</Label>
                <Select.Trigger className="w-full items-center rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface/80">
                  <Select.Value />
                  <Select.Indicator className="ml-auto h-4 w-4" />
                </Select.Trigger>
                <Select.Popover className="rounded border border-border">
                  <ListBox className="p-0" aria-label={intl.formatMessage({ id: "web.routes.user_edit.primary_role_options", defaultMessage: "Primary role options", description: "User edit: accessible name of the list of roles; not visible on screen" })}>
                    {roles.map((r) => (
                      <ListBoxItem key={r.name} id={r.name}>{r.name}</ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              {wouldDemoteSelf && (
                <p className="pt-1 text-[11px] text-danger">{intl.formatMessage({ id: "web.routes.user_edit.cannot_remove_own_user_management", defaultMessage: "You can’t remove your own ability to manage users.", description: "User edit: warning under the role dropdown when the change would remove the signed-in user's own ability to manage users" })}</p>
              )}
            </div>
            <NamespaceGrants userId={userId} roles={roles} />
          </Card>

          <Card id="servers" className="space-y-4 border border-border p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <SectionHeader
                title={intl.formatMessage({ id: "web.routes.user_edit.server_access", defaultMessage: "Server access", description: "User edit: title of the server access card" })}
                description={intl.formatMessage({ id: "web.routes.user_edit.server_access_description", defaultMessage: "Direct grants and servers reached through a network membership.", description: "User edit: description of the server access card" })}
              />
              <Button variant="outline" size="sm" onPress={() => setAdding((open) => !open)}>
                <Plus className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.user_edit.add_servers", defaultMessage: "Add servers", description: "User edit: button that opens the panel for granting this user access to servers; keep it short" })}
              </Button>
            </div>

            {adding && (
              <div className="space-y-3 rounded-xl border border-border p-4">
                <Input
                  aria-label={intl.formatMessage({ id: "web.routes.user_edit.search_servers", defaultMessage: "Search servers", description: "User edit: accessible name and placeholder of the server search field in the add-servers panel" })}
                  placeholder={intl.formatMessage({ id: "web.routes.user_edit.search_servers", defaultMessage: "Search servers", description: "User edit: accessible name and placeholder of the server search field in the add-servers panel" })}
                  value={serverQuery}
                  onChange={(e) => setServerQuery(e.target.value)}
                />
                {selected.size > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {[...selected.values()].map((item) => (
                      <button
                        key={serverKey(item.target.cluster, item.target.namespace, item.target.name)}
                        type="button"
                        onClick={() => toggleSelected(item)}
                        className="inline-flex h-7 items-center gap-1 rounded-full bg-accent/10 px-2.5 text-xs font-medium text-accent"
                      >
                        {item.target.name}
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                )}
                <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {candidates.map((item) => {
                    const key = serverKey(item.target.cluster, item.target.namespace, item.target.name);
                    const isSelected = selected.has(key);
                    return (
                      <li key={key}>
                        <button type="button" onClick={() => toggleSelected(item)} aria-pressed={isSelected} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-surface">
                          <span className="min-w-0 truncate font-mono">{item.target.name}</span>
                          <span className="text-xs text-muted">{intl.formatMessage({ id: "web.routes.user_edit.cluster_namespace", defaultMessage: "{cluster} / {namespace}", description: "User edit: cluster and namespace of a candidate server; {cluster} is the cluster and {namespace} the namespace" }, { cluster: item.target.cluster, namespace: item.target.namespace })}</span>
                          {isSelected ? <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" /> : <Plus className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <PermissionChips
                  label={intl.formatMessage({ id: "web.routes.user_edit.new_grant_permissions", defaultMessage: "Permissions for new server grants", description: "User edit: accessible name of the permission chips for servers about to be granted; not visible on screen" })}
                  value={grantPermissions}
                  onChange={setGrantPermissions}
                />
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button variant="ghost" size="sm" onPress={() => { setAdding(false); setSelected(new Map()); }}>
                    {intl.formatMessage({ id: "web.routes.user_edit.cancel", defaultMessage: "Cancel", description: "User edit: button that closes a panel without making changes; keep it short" })}
                  </Button>
                  <Button variant="primary" size="sm" isDisabled={selected.size === 0 || addGrants.isPending} onPress={() => addGrants.mutate([...selected.values()])}>
                    {intl.formatMessage({ id: "web.routes.user_edit.grant_access", defaultMessage: "Grant access to {count, plural, one {# server} other {# servers}}", description: "User edit: button that grants the selected servers; {count} is the number of selected servers" }, { count: selected.size })}
                  </Button>
                </div>
              </div>
            )}

            {grantError && <p role="alert" className="text-xs text-danger">{errorTextIntl(intl, grantError)}</p>}

            {serverRows.length === 0 ? (
              <EmptyState icon={<Server />} title={intl.formatMessage({ id: "web.routes.user_edit.no_servers", defaultMessage: "No servers yet", description: "User edit: empty state when the user has no direct grants and no network servers" })} />
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {serverRows.map((row) => {
                  const template = row.game ? byName.get(templateKey(row.cluster, row.game)) : undefined;
                  return (
                    <li key={serverKey(row.cluster, row.namespace, row.server)} className={`flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center ${row.direct ? "" : "opacity-60"}`}>
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <GameIcon game={row.game} icon={template?.spec.icon} code={row.game ? gameCodes.get(templateKey(row.cluster, row.game)) : undefined} size="sm" />
                        <div className="min-w-0">
                          <div className="truncate font-mono text-sm">{row.server}</div>
                          <div className="truncate font-mono text-[11px] text-muted">
                            {intl.formatMessage({ id: "web.routes.user_edit.server_meta", defaultMessage: "{game} · {cluster}", description: "User edit: secondary line under a server name showing its game and cluster; {game} is the game and {cluster} the cluster name" }, { game: row.game ?? intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" }), cluster: row.cluster })}
                          </div>
                        </div>
                      </div>
                      <span className="w-fit rounded-full bg-default/60 px-2 py-0.5 text-[11px] text-muted">
                        {row.direct
                          ? intl.formatMessage({ id: "web.routes.user_edit.source_direct", defaultMessage: "Direct", description: "User edit: source chip for a server granted directly to the user; keep it short" })
                          : intl.formatMessage({ id: "web.routes.user_edit.source_network", defaultMessage: "via {network}", description: "User edit: source chip for a server reached through a network; {network} is the network name" }, { network: row.via ?? "" })}
                      </span>
                      <div className="md:w-72">
                        <PermissionChips
                          label={intl.formatMessage({ id: "web.routes.user_edit.server_permissions", defaultMessage: "Permissions for {server}", description: "User edit: accessible name of the permission chips for one server row; {server} is the server name" }, { server: row.server })}
                          value={row.permissions}
                          isDisabled={!row.direct || putGrant.isPending}
                          onChange={row.direct ? (next) => putGrant.mutate({ userId, cluster: row.cluster, namespace: row.namespace, server: row.server, permissions: next }) : undefined}
                        />
                      </div>
                      {row.direct ? (
                        <Button variant="ghost" size="sm" className="text-danger" onPress={() => removeGrant.mutate(row)} isDisabled={removeGrant.isPending}>
                          <Trash2 className="h-3.5 w-3.5" /> {intl.formatMessage({ id: "web.routes.user_edit.remove", defaultMessage: "Remove", description: "User edit: button that removes a direct server grant; keep it short" })}
                        </Button>
                      ) : (
                        <Link to="/users/networks/$name" params={{ name: row.via ?? "" }} className="text-sm text-accent hover:underline">
                          {intl.formatMessage({ id: "web.routes.user_edit.open", defaultMessage: "Open", description: "User edit: link to the network that grants access to a server; keep it short" })}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card id="networks" className="space-y-4 border border-border p-6">
            <SectionHeader
              title={intl.formatMessage({ id: "web.routes.user_edit.networks_title", defaultMessage: "Networks", description: "User edit: title of the networks card" })}
              description={intl.formatMessage({ id: "web.routes.user_edit.networks_description", defaultMessage: "Membership grants access to every server assigned to the network.", description: "User edit: description of the networks card" })}
            />
            {memberships.length === 0 ? (
              <EmptyState icon={<NetworkIcon />} title={intl.formatMessage({ id: "web.routes.user_edit.not_in_any_network", defaultMessage: "Not in any network", description: "User edit: empty state when the user belongs to no network" })} />
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {memberships.map((membership) => {
                  const serversInNetwork = fleetItems.filter((item) => item.resource.metadata.annotations?.[NETWORK_ANNOTATION] === membership.name).length;
                  return (
                    <li key={membership.name} className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"><NetworkIcon className="h-4 w-4" /></span>
                        <div className="min-w-0">
                          <Link to="/users/networks/$name" params={{ name: membership.name }} className="block truncate font-mono text-sm hover:underline">{membership.name}</Link>
                          <div className="text-[11px] text-muted">
                            {intl.formatMessage({ id: "web.routes.user_edit.network_server_count", defaultMessage: "{count, plural, one {# server} other {# servers}}", description: "User edit: server count under a network name; {count} is the number of servers in the network" }, { count: serversInNetwork })}
                          </div>
                        </div>
                      </div>
                      <div className="md:w-72">
                        <PermissionChips
                          label={intl.formatMessage({ id: "web.routes.user_edit.network_permissions", defaultMessage: "Permissions in {network}", description: "User edit: accessible name of the permission chips for the membership in one network; {network} is the network name" }, { network: membership.name })}
                          value={membership.permissions}
                          isDisabled={setMembership.isPending}
                          onChange={(next) => setMembership.mutate({ name: membership.name, permissions: next })}
                        />
                      </div>
                      <Button variant="ghost" size="sm" className="text-danger" onPress={() => removeMembership.mutate(membership.name)} isDisabled={removeMembership.isPending}>
                        <X className="h-3.5 w-3.5" /> {intl.formatMessage({ id: "web.routes.user_edit.remove_membership", defaultMessage: "Remove", description: "User edit: button that removes the user from a network; keep it short" })}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {joinable.length > 0 && (
              <div className="space-y-3 rounded-xl border border-dashed border-border p-4">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <Select
                    aria-label={intl.formatMessage({ id: "web.routes.user_edit.network_to_join", defaultMessage: "Network to join", description: "User edit: accessible name of the dropdown that picks a network to add the user to" })}
                    placeholder={intl.formatMessage({ id: "web.routes.user_edit.choose_network", defaultMessage: "Choose a network", description: "User edit: placeholder of the dropdown that picks a network to add the user to" })}
                    value={joinName}
                    onChange={(value) => setJoinName(String(value))}
                  >
                    <Select.Trigger className="w-full items-center rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface/80">
                      <Select.Value />
                      <Select.Indicator className="ml-auto h-4 w-4" />
                    </Select.Trigger>
                    <Select.Popover className="rounded border border-border">
                      <ListBox className="p-0">
                        {joinable.map((network) => (
                          <ListBoxItem key={network.name} id={network.name}>{network.name}</ListBoxItem>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                  <Button variant="outline" size="sm" isDisabled={!joinName || joinNetwork.isPending} onPress={() => joinNetwork.mutate()}>
                    <Plus className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.user_edit.add_to_network", defaultMessage: "Add to network", description: "User edit: button that adds the user to the chosen network; keep it short" })}
                  </Button>
                </div>
                <PermissionChips
                  label={intl.formatMessage({ id: "web.routes.user_edit.new_membership_permissions", defaultMessage: "Permissions for the new network membership", description: "User edit: accessible name of the permission chips for a network membership about to be added; not visible on screen" })}
                  value={joinPermissions}
                  onChange={setJoinPermissions}
                />
              </div>
            )}
            {networkError && <p role="alert" className="text-xs text-danger">{errorTextIntl(intl, networkError)}</p>}
          </Card>

          <Card id="danger" className="flex flex-col gap-4 border border-danger/40 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-danger">{intl.formatMessage({ id: "web.routes.user_edit.danger_zone", defaultMessage: "Danger zone", description: "User edit: title of the danger zone card" })}</h2>
              <p className="text-sm text-muted">{intl.formatMessage({ id: "web.routes.user_edit.danger_description", defaultMessage: "Deleting a user revokes their sessions and removes every grant. This cannot be undone.", description: "User edit: description of the danger zone card" })}</p>
            </div>
            <Button variant="danger" onPress={() => setDeleting(true)}>
              <Trash2 className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.user_edit.delete_user", defaultMessage: "Delete user", description: "User edit: button that opens the delete dialog for this user; keep it short" })}
            </Button>
          </Card>
        </div>
      </div>

      {dirty && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 shadow-lg">
          <div className="min-w-0">
            <div className="text-sm font-medium">{dirtyNote}</div>
            {(save.error || wouldDemoteSelf) && (
              <p role="alert" className="text-xs text-danger">{save.error ? errorTextIntl(intl, save.error) : intl.formatMessage({ id: "web.routes.user_edit.cannot_remove_own_user_management", defaultMessage: "You can’t remove your own ability to manage users.", description: "User edit: warning under the role dropdown when the change would remove the signed-in user's own ability to manage users" })}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onPress={() => setDraft({})} isDisabled={save.isPending}>
              {intl.formatMessage({ id: "web.routes.user_edit.discard", defaultMessage: "Discard", description: "User edit: button that throws away unsaved profile and role changes; keep it short" })}
            </Button>
            <Button variant="primary" size="sm" isDisabled={save.isPending || wouldDemoteSelf} onPress={() => save.mutate(profileBody)}>
              {save.isPending
                ? intl.formatMessage({ id: "web.routes.user_edit.saving", defaultMessage: "Saving…", description: "User edit: save button label while the profile update is in progress" })
                : intl.formatMessage({ id: "web.routes.user_edit.save_changes", defaultMessage: "Save changes", description: "User edit: button that saves the profile and role changes" })}
            </Button>
          </div>
        </div>
      )}

      {resetting && (
        <ResetPasswordDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setResetting(false);
              reset.reset();
            }
          }}
          username={user.username}
          disableSubmitUntilValid
          isLoading={reset.isPending}
          apiError={reset.error ? errorTextIntl(intl, reset.error) : undefined}
          submitLabel={intl.formatMessage({ id: "web.routes.user_edit.set_new_password", defaultMessage: "Set new password", description: "User edit: submit button label in the reset-password dialog" })}
          onReset={(password) => reset.mutate(password)}
        />
      )}
      {deleting && (
        <DeleteUserDialog
          user={user}
          isMe={isMe}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            void qc.invalidateQueries({ queryKey: ["users"] });
            void navigate({ to: "/users" });
          }}
        />
      )}
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className="space-y-1">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-muted">{description}</p>
    </div>
  );
}
