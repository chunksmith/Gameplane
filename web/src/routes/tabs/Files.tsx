import { useResourceClient, useResourceAccess, useResourceTarget, resourceKey, type ResourceTarget } from "@/lib/resourceTarget";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Checkbox,
  Input,
} from "@heroui/react";
import Editor from "@monaco-editor/react";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  FileArchive,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  House,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import type { FileEntry } from "@/lib/endpoints";
import { cn, formatBytes, formatRelative } from "@/lib/utils";

const ROOT = "/";
const ROOT_ENTRY: FileEntry = { name: "", path: ROOT, size: 0, dir: true };
const AUTOSAVE_DELAY_MS = 800;
const ARCHIVE_PATTERN = /\.(zip|tar|gz|tgz|rar|7z|jar)$/i;
const LIST_REFRESH_MS = 5_000;
const MAX_UPLOAD_FILES = 64;
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const SIZE_CACHE_MS = 60_000;

interface ViewProps {
  resourceTarget: ResourceTarget;
  path: string;
  onNavigate: (path: string) => void;
}

export function FilesTab({ name, ns, path, onNavigate }: { name: string; ns?: string; path: string; onNavigate: (path: string) => void }) {
  const resourceTarget = useResourceTarget({ name, namespace: ns });
  return <FilesBrowser key={JSON.stringify(resourceKey(resourceTarget, "file-editor"))} resourceTarget={resourceTarget} path={normalize(path)} onNavigate={onNavigate} />;
}

function FilesBrowser({ resourceTarget, path, onNavigate }: ViewProps) {
  const { name, namespace: ns } = resourceTarget;
  const client = useResourceClient(resourceTarget);
  const parent = parentOf(path);
  const isRoot = path === ROOT;
  const parentListing = useQuery({
    queryKey: listKey(resourceTarget, parent),
    queryFn: ({ signal }) => client.withSignal(signal).Files.list(name, parent, ns),
    enabled: !isRoot,
  });
  const entry = isRoot ? ROOT_ENTRY : parentListing.data?.entries.find((item) => item.name === baseName(path));

  return (
    <div className="flex min-h-full flex-col gap-4 p-6">
      {entry?.dir ? (
        <DirectoryView key={path} resourceTarget={resourceTarget} path={path} onNavigate={onNavigate} />
      ) : entry ? (
        <FileEditor key={path} resourceTarget={resourceTarget} path={path} entry={entry} onNavigate={onNavigate} />
      ) : (
        <>
          <Breadcrumbs path={path} onNavigate={onNavigate} />
          {parentListing.error ? (
            <ErrorBanner err={parentListing.error} />
          ) : parentListing.isPending ? (
            <Spinner />
          ) : (
            <div className="grid flex-1 place-items-center rounded-lg border border-border bg-surface/50 p-10 text-center">
              <div className="space-y-3">
                <p className="text-sm text-muted">Nothing exists at this path.</p>
                <Button variant="secondary" size="sm" onPress={() => onNavigate(parent)}>
                  Open {parent === ROOT ? "root folder" : baseName(parent)}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DirectoryView({ resourceTarget, path, onNavigate }: ViewProps) {
  const canControl = useResourceAccess()?.canControl === true;
  const { name, namespace: ns } = resourceTarget;
  const client = useResourceClient(resourceTarget);
  const qc = useQueryClient();
  const queryKey = listKey(resourceTarget, path);
  const listing = useQuery({
    queryKey,
    queryFn: ({ signal }) => client.withSignal(signal).Files.list(name, path, ns),
    refetchInterval: LIST_REFRESH_MS,
  });
  const [error, setError] = useState<Error | null>(null);
  const [prompt, setPrompt] = useState<"file" | "folder" | "zip" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const entries = listing.data && sortEntries(listing.data.entries);
  const total = listing.data?.total ?? 0;
  const selection = entries?.filter((entry) => selected.has(entry.path)) ?? [];
  const allSelected = selection.length > 0 && selection.length === entries?.length;
  const selectionPaths =
    allSelected && selection.length > 1 && total === selection.length && path !== ROOT
      ? [path]
      : selection.map((entry) => entry.path);

  async function refresh() {
    void qc.invalidateQueries({ queryKey: ["fleet"] });
    void qc.invalidateQueries({ queryKey: sizeKey(resourceTarget) });
    await qc.invalidateQueries({ queryKey });
    setError(null);
  }

  function toggle(entryPath: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(entryPath)) next.add(entryPath);
      return next;
    });
  }

  function downloadSelection() {
    const single = selection.length === 1 ? selection[0] : undefined;
    download(
      single && !single.dir
        ? client.Files.downloadURL(name, single.path, ns)
        : client.Files.archiveURL(name, selectionPaths, ns),
    );
  }

  const create = useMutation({
    mutationFn: async ({ kind, entryName }: { kind: "file" | "folder"; entryName: string }) => {
      const target = joinPath(path, entryName);
      if (kind === "folder") await client.Files.mkdir(name, target, ns);
      else await client.Files.write(name, target, "", ns);
      return { kind, target };
    },
    onSuccess: async ({ kind, target }) => {
      setPrompt(null);
      await refresh();
      if (kind === "file") onNavigate(target);
    },
    onError: (err: Error) => setError(err),
  });

  const upload = useMutation({
    mutationFn: async (groups: Map<string, File[]>) => {
      for (const [dir, files] of groups) {
        const target = dir ? joinPath(path, dir) : path;
        if (files.length === 0) await client.Files.mkdir(name, target, ns);
        for (const batch of uploadBatches(files)) await client.Files.upload(name, target, batch, ns);
      }
    },
    onSuccess: refresh,
    onError: (err: Error) => setError(err),
  });

  const zip = useMutation({
    mutationFn: ({ entryName, paths }: { entryName: string; paths: string[] }) =>
      client.Files.zip(name, joinPath(path, entryName), paths, ns),
    onSuccess: async () => {
      setPrompt(null);
      setSelected(new Set());
      await refresh();
    },
    onError: (err: Error) => setError(err),
  });

  const removeSelected = useMutation({
    mutationFn: async (targets: FileEntry[]) => {
      for (const entry of targets) await client.Files.remove(name, entry.path, entry.dir, ns);
    },
    onSuccess: async () => {
      setConfirmBulkDelete(false);
      setSelected(new Set());
      await refresh();
    },
    onError: (err: Error) => {
      setConfirmBulkDelete(false);
      setError(err);
      void qc.invalidateQueries({ queryKey });
    },
  });

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!canControl) return;
    event.preventDefault();
    setDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (!canControl) return;
    void collectDropped(event.dataTransfer).then(
      (groups) => {
        if (groups.size > 0) upload.mutate(groups);
      },
      (err: unknown) => setError(err instanceof Error ? err : new Error(String(err))),
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Breadcrumbs path={path} onNavigate={onNavigate} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            aria-label="Refresh"
            onPress={() => {
              void qc.invalidateQueries({ queryKey: sizeKey(resourceTarget) });
              void listing.refetch();
            }}
          >
            <RefreshCw className={cn("h-4 w-4", listing.isFetching && "animate-spin")} />
          </Button>
          <Button variant="secondary" size="sm" isDisabled={!canControl} onPress={() => setPrompt("folder")}>
            <FolderPlus className="h-4 w-4" /> New folder
          </Button>
          {upload.isPending && (
            <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Uploading…
            </span>
          )}
          <Button variant="primary" size="sm" isDisabled={!canControl} onPress={() => setPrompt("file")}>
            <FilePlus className="h-4 w-4" /> New file
          </Button>
        </div>
      </div>

      {error && <ErrorBanner err={error} onDismiss={() => setError(null)} />}

      {selection.length > 0 && (
        <div
          role="toolbar"
          aria-label="Selection actions"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-4 py-2"
        >
          <span className="text-sm font-medium text-foreground">{selection.length.toLocaleString()} selected</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onPress={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button variant="secondary" size="sm" onPress={downloadSelection}>
              <Download className="h-4 w-4" /> Download
            </Button>
            <Button variant="secondary" size="sm" isDisabled={!canControl} onPress={() => setPrompt("zip")}>
              <FileArchive className="h-4 w-4" /> Zip
            </Button>
            <Button variant="danger" size="sm" isDisabled={!canControl} onPress={() => setConfirmBulkDelete(true)}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </div>
        </div>
      )}

      <div
        data-testid="files-dropzone"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "relative overflow-hidden rounded-lg border border-border bg-surface/50 transition-colors",
          dragging && "border-primary",
        )}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs font-medium text-muted">
          <SelectBox
            label="Select all"
            isSelected={allSelected}
            isIndeterminate={selection.length > 0 && !allSelected}
            isDisabled={!entries?.length}
            onChange={() => setSelected(allSelected ? new Set() : new Set(entries?.map((entry) => entry.path)))}
          />
          <span className="flex-1 pl-7">Name</span>
          <span className="w-24 text-right">Size</span>
          <span className="hidden w-28 text-right md:block">Modified</span>
          <span className="w-[4.5rem]" />
        </div>
        {listing.error ? (
          <div className="p-4">
            <ErrorBanner err={listing.error} />
          </div>
        ) : !entries ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">This folder is empty.</p>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li
                key={entry.path}
                className={cn(
                  "group flex items-center gap-3 border-b border-border pl-4 last:border-b-0 hover:bg-surface",
                  selected.has(entry.path) && "bg-surface",
                )}
              >
                <SelectBox label={`Select ${entry.name}`} isSelected={selected.has(entry.path)} onChange={() => toggle(entry.path)} />
                <button
                  type="button"
                  onClick={() => onNavigate(entry.path)}
                  className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-4 text-left text-sm"
                >
                  <EntryIcon entry={entry} />
                  <span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
                  <span className="w-24 shrink-0 text-right text-xs text-muted">
                    {entry.dir ? <DirSize resourceTarget={resourceTarget} path={entry.path} /> : formatBytes(entry.size)}
                  </span>
                  <span className="hidden w-28 shrink-0 text-right text-xs text-muted md:block">{formatRelative(entry.modTime)}</span>
                </button>
                <div className="flex w-[4.5rem] shrink-0 justify-end gap-1 pr-2 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    aria-label={`Download ${entry.name}`}
                    onPress={() =>
                      download(
                        entry.dir
                          ? client.Files.archiveURL(name, [entry.path], ns)
                          : client.Files.downloadURL(name, entry.path, ns),
                      )
                    }
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${entry.name}`}
                    isDisabled={!canControl}
                    onPress={() => setConfirmDelete(entry)}
                    className="text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {entries && total > entries.length && (
          <p role="status" className="border-t border-border px-4 py-3 text-center text-xs text-muted">
            Showing {entries.length.toLocaleString()} of {total.toLocaleString()} entries. The file list limit is set in Settings → General.
          </p>
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background/80 text-sm font-medium text-primary">
            <Upload className="h-4 w-4" /> Drop files to upload
          </div>
        )}
      </div>
      {canControl && (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Upload className="h-3.5 w-3.5" /> Drag files or folders onto the list to upload them here.
        </p>
      )}

      {confirmDelete && (
        <DeleteDialog
          resourceTarget={resourceTarget}
          entry={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onDeleted={() => {
            setConfirmDelete(null);
            setError(null);
          }}
          onError={setError}
        />
      )}
      {confirmBulkDelete && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmBulkDelete(false)}
          title={`Delete ${selection.length.toLocaleString()} ${selection.length === 1 ? "item" : "items"}?`}
          description="This permanently removes the selected files and folders, including everything inside the folders, from the server's data volume. This action cannot be undone."
          destructive
          confirmLabel="Delete"
          busy={removeSelected.isPending}
          onConfirm={() => removeSelected.mutate(selection)}
        />
      )}
      <NamePromptDialog
        open={prompt === "folder"}
        onOpenChange={(open) => setPrompt(open ? "folder" : null)}
        title="New folder"
        label="Folder name"
        placeholder="my-folder"
        confirmLabel="Create"
        busy={create.isPending}
        onSubmit={(entryName) => create.mutate({ kind: "folder", entryName })}
      />
      <NamePromptDialog
        open={prompt === "file"}
        onOpenChange={(open) => setPrompt(open ? "file" : null)}
        title="New file"
        label="File name"
        placeholder="config.yaml"
        confirmLabel="Create"
        busy={create.isPending}
        onSubmit={(entryName) => create.mutate({ kind: "file", entryName })}
      />
      <NamePromptDialog
        open={prompt === "zip"}
        onOpenChange={(open) => setPrompt(open ? "zip" : null)}
        title="Create zip archive"
        label="Archive name"
        placeholder="archive.zip"
        initialValue={archiveName(entries ?? [], selection)}
        confirmLabel="Create"
        busy={zip.isPending}
        onSubmit={(entryName) => zip.mutate({ entryName, paths: selectionPaths })}
      />
    </>
  );
}

function FileEditor({ resourceTarget, path, entry, onNavigate }: ViewProps & { entry: FileEntry }) {
  const canControl = useResourceAccess()?.canControl === true;
  const { name, namespace: ns } = resourceTarget;
  const client = useResourceClient(resourceTarget);
  const qc = useQueryClient();
  const content = useQuery({
    queryKey: resourceKey(resourceTarget, "file-content", name, path, ns),
    queryFn: ({ signal }) => client.withSignal(signal).Files.read(name, path, ns),
    gcTime: 0,
    staleTime: Infinity,
  });
  const [draft, setDraft] = useState<{ value: string; saved: string } | null>(null);
  const [failed, setFailed] = useState<{ body: string; error: Error } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const flush = useRef(() => {});
  const deleted = useRef(false);
  if (draft === null && content.data !== undefined) setDraft({ value: content.data, saved: content.data });
  const dirty = draft !== null && draft.value !== draft.saved;

  const { mutate: save, isPending: saving } = useMutation({
    scope: { id: JSON.stringify(resourceKey(resourceTarget, "file-save", path)) },
    mutationFn: (body: string) => client.Files.write(name, path, body, ns),
    onSuccess: (_data, body) => {
      setFailed(null);
      setDraft((current) => current && { ...current, saved: body });
      void qc.invalidateQueries({ queryKey: ["fleet"] });
      void qc.invalidateQueries({ queryKey: listKey(resourceTarget, parentOf(path)), refetchType: "none" });
    },
    onError: (err: Error, body) => setFailed({ body, error: err }),
  });

  useEffect(() => {
    if (!canControl || !draft || !dirty || saving || confirmDelete || draft.value === failed?.body) return;
    const timer = window.setTimeout(() => {
      if (!deleted.current) save(draft.value);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [canControl, draft, dirty, saving, confirmDelete, failed, save]);

  useEffect(() => {
    flush.current = () => {
      if (canControl && draft && dirty && !deleted.current) save(draft.value);
    };
  });

  useEffect(() => () => flush.current(), []);

  useEffect(() => {
    if (!canControl || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [canControl, dirty]);

  const saveState = !canControl
    ? "Read only"
    : failed && failed.body === draft?.value
      ? "Save failed"
      : dirty || saving ? "Saving…" : "Saved";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Breadcrumbs path={path} onNavigate={onNavigate} />
        <div className="flex items-center gap-2">
          {draft && (
            <span role="status" className="flex items-center gap-1.5 pr-1 text-xs text-muted">
              {SAVE_ICONS[saveState]} {saveState}
            </span>
          )}
          <Button variant="secondary" size="sm" onPress={() => download(client.Files.downloadURL(name, path, ns))}>
            <Download className="h-4 w-4" /> Download
          </Button>
          <Button variant="danger" size="sm" isDisabled={!canControl} onPress={() => setConfirmDelete(true)}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>
      </div>

      {failed && <ErrorBanner err={failed.error} onDismiss={() => setFailed(null)} />}
      {error && <ErrorBanner err={error} onDismiss={() => setError(null)} />}

      <div className="relative min-h-[60vh] flex-1 overflow-hidden rounded-lg border border-border bg-background">
        {content.error ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-sm text-danger">{content.error.message}</div>
        ) : draft === null ? (
          <Spinner />
        ) : (
          <Editor
            wrapperProps={{ style: { display: "flex", position: "absolute", inset: 0 } }}
            theme="vs-dark"
            language={guessLang(entry.name)}
            value={draft.value}
            onChange={(next) => setDraft((current) => current && { ...current, value: next ?? "" })}
            onMount={(editor, monaco) => editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => undefined)}
            options={{
              minimap: { enabled: false },
              fontFamily: "JetBrains Mono",
              readOnly: !canControl,
            }}
          />
        )}
      </div>

      {confirmDelete && (
        <DeleteDialog
          resourceTarget={resourceTarget}
          entry={entry}
          onClose={() => setConfirmDelete(false)}
          onDeleted={() => {
            deleted.current = true;
            onNavigate(parentOf(path));
          }}
          onError={setError}
        />
      )}
    </>
  );
}

const SAVE_ICONS: Record<string, ReactNode> = {
  "Read only": null,
  "Save failed": <CircleAlert className="h-3.5 w-3.5 text-danger" />,
  "Saving…": <Loader2 className="h-3.5 w-3.5 animate-spin" />,
  Saved: <CircleCheck className="h-3.5 w-3.5 text-success" />,
};

function DeleteDialog({
  resourceTarget,
  entry,
  onClose,
  onDeleted,
  onError,
}: {
  resourceTarget: ResourceTarget;
  entry: FileEntry;
  onClose: () => void;
  onDeleted: () => void;
  onError: (err: Error) => void;
}) {
  const { name, namespace: ns } = resourceTarget;
  const client = useResourceClient(resourceTarget);
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => client.Files.remove(name, entry.path, entry.dir, ns),
    onSuccess: async () => {
      onDeleted();
      void qc.invalidateQueries({ queryKey: ["fleet"] });
      await qc.invalidateQueries({ queryKey: listKey(resourceTarget, parentOf(entry.path)) });
    },
    onError,
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${entry.name}?`}
      description={
        entry.dir
          ? "This permanently removes the folder and everything inside it from the server's data volume. This action cannot be undone."
          : "This permanently removes the file from the server's data volume. This action cannot be undone."
      }
      destructive
      confirmLabel="Delete"
      busy={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );
}

function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const segments = path.split("/").filter(Boolean);
  return (
    <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        aria-label="Root folder"
        onClick={() => onNavigate(ROOT)}
        className="rounded p-1 text-muted hover:bg-surface hover:text-foreground"
      >
        <House className="h-4 w-4" />
      </button>
      {segments.map((segment, index) => {
        const target = `/${segments.slice(0, index + 1).join("/")}`;
        const last = index === segments.length - 1;
        return (
          <span key={target} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
            <button
              type="button"
              aria-current={last ? "page" : undefined}
              onClick={() => onNavigate(target)}
              className={cn(
                "truncate rounded px-1.5 py-0.5 font-mono",
                last ? "font-medium text-foreground" : "text-muted hover:bg-surface hover:text-foreground",
              )}
            >
              {segment}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  if (entry.dir) return <Folder className="h-4 w-4 shrink-0 text-primary" />;
  const Icon = ARCHIVE_PATTERN.test(entry.name) ? FileArchive : FileText;
  return <Icon className="h-4 w-4 shrink-0 text-muted" />;
}

function Spinner() {
  return (
    <div className="grid flex-1 place-items-center py-10">
      <Loader2 className="h-5 w-5 animate-spin text-muted" />
    </div>
  );
}

function SelectBox({
  label,
  isSelected,
  isIndeterminate,
  isDisabled,
  onChange,
}: {
  label: string;
  isSelected: boolean;
  isIndeterminate?: boolean;
  isDisabled?: boolean;
  onChange: () => void;
}) {
  return (
    <Checkbox
      aria-label={label}
      isSelected={isSelected}
      isIndeterminate={isIndeterminate}
      isDisabled={isDisabled}
      onChange={onChange}
      className="shrink-0"
    >
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
      </Checkbox.Content>
    </Checkbox>
  );
}

function DirSize({ resourceTarget, path }: { resourceTarget: ResourceTarget; path: string }) {
  const client = useResourceClient(resourceTarget);
  const size = useQuery({
    queryKey: sizeKey(resourceTarget, path),
    queryFn: ({ signal }) => client.withSignal(signal).Files.size(resourceTarget.name, path, resourceTarget.namespace),
    staleTime: SIZE_CACHE_MS,
    retry: false,
  });
  if (size.isPending) return <Loader2 aria-label="Calculating size" className="ml-auto h-3.5 w-3.5 animate-spin" />;
  return size.data === undefined ? "—" : formatBytes(size.data);
}

interface NamePromptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel: string;
  busy?: boolean;
  onSubmit: (value: string) => void;
}

function NamePromptDialog({
  open,
  onOpenChange,
  title,
  label,
  placeholder,
  initialValue,
  confirmLabel,
  busy,
  onSubmit,
}: NamePromptProps) {
  const [value, setValue] = useState("");
  // Clear the input whenever the dialog transitions to open. Adjusted
  // directly during render (not in an effect), gated on the previous
  // `open` value tracked in state.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setValue(initialValue ?? "");
  }
  const trimmed = value.trim();
  // Reject empty, slashes, and dot-only names — keeps the prompt aligned with
  // what the agent's resolve() will accept anyway, so users get instant feedback.
  const valid = trimmed.length > 0 && !trimmed.includes("/") && trimmed !== "." && trimmed !== "..";
  // Explain a rejected name instead of only disabling Create (design oMuyw).
  const showError = trimmed.length > 0 && !valid;
  return (
    <Modal isOpen={open} onOpenChange={onOpenChange}>
      <ModalBackdrop isDismissable={!busy}>
        <ModalContainer>
          <ModalDialog>
            <ModalHeader className="flex flex-col gap-1">{title}</ModalHeader>
            <ModalBody>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (valid && !busy) onSubmit(trimmed);
                }}
                className="space-y-4"
              >
                <div>
                  <label className="block pb-2 text-xs text-default-500">{label}</label>
                  <Input
                    autoFocus
                    value={value}
                    placeholder={placeholder}
                    onChange={(e) => setValue(e.target.value)}
                    spellCheck={false}
                    aria-invalid={showError || undefined}
                    aria-describedby={showError ? "name-prompt-error" : undefined}
                    className={cn(showError && "border-danger")}
                  />
                  {showError && (
                    <p id="name-prompt-error" className="pt-1 text-xs text-danger">
                      {'Names can\'t contain "/" or be "." or "..".'}
                    </p>
                  )}
                </div>
              </form>
            </ModalBody>
            <ModalFooter>
              <Button
                variant="ghost"
                onPress={() => onOpenChange(false)}
                isDisabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                isDisabled={!valid || busy}
                onPress={() => {
                  if (valid && !busy) onSubmit(trimmed);
                }}
              >
                {busy ? "Working…" : confirmLabel}
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}

function listKey(target: ResourceTarget, dir: string) {
  return resourceKey(target, "files", target.name, dir, target.namespace);
}

function sizeKey(target: ResourceTarget, ...path: string[]) {
  return resourceKey(target, "file-size", ...path);
}

function archiveName(entries: FileEntry[], selection: FileEntry[]): string {
  const stem = selection.length === 1 ? selection[0].name : "archive";
  const taken = new Set(entries.map((entry) => entry.name));
  let candidate = `${stem}.zip`;
  for (let index = 2; taken.has(candidate); index++) candidate = `${stem}-${index}.zip`;
  return candidate;
}

function normalize(path: string): string {
  return `/${path.split("/").filter(Boolean).join("/")}`;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? ROOT : path.slice(0, index);
}

function joinPath(dir: string, name: string): string {
  return dir === ROOT ? `/${name}` : `${dir}/${name}`;
}

async function collectDropped(dataTransfer: DataTransfer): Promise<Map<string, File[]>> {
  const groups = new Map<string, File[]>();
  const items = Array.from((dataTransfer.items as DataTransferItemList | undefined) ?? []);
  const entries = items.map((item) => item.webkitGetAsEntry()).filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) {
    const files = Array.from(dataTransfer.files);
    if (files.length > 0) groups.set("", files);
    return groups;
  }
  await Promise.all(entries.map((entry) => collectEntry(entry, "", groups)));
  return groups;
}

async function collectEntry(entry: FileSystemEntry, dir: string, groups: Map<string, File[]>): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
    return;
  }
  const folder = dir ? `${dir}/${entry.name}` : entry.name;
  if (!groups.has(folder)) groups.set(folder, []);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  let children: FileSystemEntry[];
  do {
    children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    await Promise.all(children.map((child) => collectEntry(child, folder, groups)));
  } while (children.length > 0);
}

function uploadBatches(files: File[]): File[][] {
  const batches: File[][] = [];
  let bytes = 0;
  for (const file of files) {
    const current = batches.at(-1);
    if (!current || current.length === MAX_UPLOAD_FILES || bytes + file.size > MAX_UPLOAD_BYTES) {
      batches.push([file]);
      bytes = file.size;
    } else {
      current.push(file);
      bytes += file.size;
    }
  }
  return batches;
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) =>
    Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}

function download(url: string) {
  window.location.href = url;
}

function guessLang(name: string): string {
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".properties")) return "ini";
  if (name.endsWith(".toml")) return "toml";
  if (name.endsWith(".sh")) return "shell";
  if (name.endsWith(".js") || name.endsWith(".ts")) return "typescript";
  if (name.endsWith(".md")) return "markdown";
  return "plaintext";
}
