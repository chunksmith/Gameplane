import { useResourceClient, useResourceAccess, useResourceTarget, resourceKey, type ResourceTarget } from "@/lib/resourceTarget";
import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
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
  List,
  ListTree,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { FileAssistant } from "@/routes/tabs/FileAssistant";
import type { FileEntry, ResourceClient } from "@/lib/endpoints";
import { cn, formatBytes, formatRelative } from "@/lib/utils";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";
import { defineMessages } from "react-intl";

const ROOT = "/";
const ROOT_ENTRY: FileEntry = { name: "", path: ROOT, size: 0, dir: true };
const AUTOSAVE_DELAY_MS = 800;
const ARCHIVE_PATTERN = /\.(zip|tar|gz|tgz|rar|7z|jar)$/i;
const LIST_REFRESH_MS = 5_000;
const MAX_UPLOAD_FILES = 64;
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const SIZE_CACHE_MS = 60_000;
const VIEW_STORAGE_KEY = "gameplane.files.view";

type FilesView = "list" | "tree";

const FILES_MESSAGES = defineMessages({
  root_folder: { id: "web.routes.tabs.files.root_folder", defaultMessage: "root folder", description: "Files: lowercase name of the server data root, used in the open-folder button when the parent of a missing path is the root" },
  root_folder_label: { id: "web.routes.tabs.files.root_folder_label", defaultMessage: "Root folder", description: "Files: accessible label of the breadcrumb button that jumps to the server data root" },
  nothing_exists: { id: "web.routes.tabs.files.nothing_exists_at_this_path", defaultMessage: "Nothing exists at this path.", description: "Files tab: text shown when nothing exists at the current path" },
  refresh: { id: "web.routes.tabs.files.refresh", defaultMessage: "Refresh", description: "Files tab: icon-only button that reloads the file list; read by screen readers; keep it short" },
  new_folder: { id: "web.routes.tabs.files.new_folder", defaultMessage: "New folder", description: "Files tab: button that opens the prompt to create a new folder, and the title of that prompt dialog; keep it short" },
  new_file: { id: "web.routes.tabs.files.new_file", defaultMessage: "New file", description: "Files tab: button that opens the prompt to create a new file, and the title of that prompt dialog; keep it short" },
  uploading: { id: "web.routes.tabs.files.uploading", defaultMessage: "Uploading…", description: "Files tab: status shown beside the folder buttons while files are being uploaded" },
  selection_actions: { id: "web.routes.tabs.files.selection_actions", defaultMessage: "Selection actions", description: "Files tab: accessible label of the toolbar with actions for the selected files; not shown as text" },
  clear: { id: "web.routes.tabs.files.clear", defaultMessage: "Clear", description: "Files tab: button that clears the current file selection; keep it short" },
  download: { id: "web.routes.tabs.files.download", defaultMessage: "Download", description: "Files tab: button that downloads the selected file to the user's computer; keep it short" },
  zip: { id: "web.routes.tabs.files.zip", defaultMessage: "Zip", description: "Files tab: button that packs the selected files and folders into a zip archive; keep it short" },
  delete: { id: "web.routes.tabs.files.delete", defaultMessage: "Delete", description: "Files tab: red button that deletes the selected file or folder, and the confirm button of the delete dialog; keep it short" },
  select_all: { id: "web.routes.tabs.files.select_all", defaultMessage: "Select all", description: "Files tab: checkbox in the list header that selects every entry; read by screen readers" },
  column_name: { id: "web.routes.tabs.files.column_name", defaultMessage: "Name", description: "Files tab: column heading of the file name in the file list" },
  column_size: { id: "web.routes.tabs.files.column_size", defaultMessage: "Size", description: "Files tab: column heading of the file size in the file list" },
  column_modified: { id: "web.routes.tabs.files.column_modified", defaultMessage: "Modified", description: "Files tab: column heading of the last modified time in the file list" },
  this_folder_is_empty: { id: "web.routes.tabs.files.this_folder_is_empty", defaultMessage: "This folder is empty.", description: "Files tab: text shown in the file list when the current folder has no entries" },
  delete_file_body: { id: "web.routes.tabs.files.delete_file_body", defaultMessage: "This permanently removes the file from the server's data volume. This action cannot be undone.", description: "Files: body of the confirm dialog for deleting a file" },
  delete_folder_body: { id: "web.routes.tabs.files.delete_folder_body", defaultMessage: "This permanently removes the folder and everything inside it from the server's data volume. This action cannot be undone.", description: "Files: body of the confirm dialog for deleting a folder" },
  delete_selected_body: { id: "web.routes.tabs.files.delete_selected_body", defaultMessage: "This permanently removes the selected files and folders, including everything inside the folders, from the server's data volume. This action cannot be undone.", description: "Files: body of the confirm dialog for deleting the selected files and folders" },
  drop_files_to_upload: { id: "web.routes.tabs.files.drop_files_to_upload", defaultMessage: "Drop files to upload", description: "Files tab: text shown over the file list while files are dragged onto it" },
  drag_files_hint: { id: "web.routes.tabs.files.drag_files_hint", defaultMessage: "Drag files or folders onto the list to upload them here.", description: "Files tab: hint under the file list saying files or folders can be dragged in to upload them" },
  folder_name: { id: "web.routes.tabs.files.folder_name", defaultMessage: "Folder name", description: "Files tab: field label for the name of a new folder in the new folder prompt" },
  file_name: { id: "web.routes.tabs.files.file_name", defaultMessage: "File name", description: "Files tab: field label for the name of a new file in the new file prompt" },
  my_folder: { id: "web.routes.tabs.files.my_folder", defaultMessage: "my-folder", description: "Files tab: example placeholder in the new folder name field; an example name, not a default" },
  config_yaml: { id: "web.routes.tabs.files.config_yaml", defaultMessage: "config.yaml", description: "Files tab: example placeholder in the new file name field; an example name, not a default" },
  create: { id: "web.routes.tabs.files.create", defaultMessage: "Create", description: "Files tab: confirm button of the new file and new folder prompts that creates the item; keep it short" },
  create_zip_archive: { id: "web.routes.tabs.files.create_zip_archive", defaultMessage: "Create zip archive", description: "Files tab: title of the prompt for naming a zip archive of the selected items" },
  archive_name: { id: "web.routes.tabs.files.archive_name", defaultMessage: "Archive name", description: "Files tab: field label for the name of a new zip archive in the zip prompt" },
  archive_zip: { id: "web.routes.tabs.files.archive_zip", defaultMessage: "archive.zip", description: "Files tab: example placeholder in the archive name field; an example name, not a default" },
  cancel: { id: "web.routes.tabs.files.cancel", defaultMessage: "Cancel", description: "Files tab: button in the name prompt dialog that closes it without creating anything; keep it short" },
  working: { id: "web.routes.tabs.files.working", defaultMessage: "Working…", description: "Files: label of the dialog submit button while the request is running" },
  names_invalid: { id: "web.routes.tabs.files.names_can_t_contain_or_be_or", defaultMessage: "Names can't contain \"/\" or be \".\" or \"..\".", description: "Files tab: validation error under a file or folder name field when the name contains a slash or is a single or double dot" },
  path: { id: "web.routes.tabs.files.path", defaultMessage: "Path", description: "Files tab: accessible label of the breadcrumb path navigation; not shown as text" },
  calculating_size: { id: "web.routes.tabs.files.calculating_size", defaultMessage: "Calculating size", description: "Files tab: accessible label of the spinner shown while a folder size is being calculated" },
  empty_value: { id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" },
  file_view: { id: "web.routes.tabs.files.file_view", defaultMessage: "File view", description: "Files tab: accessible label of the List and Tree view switch; not shown as text" },
  view_list: { id: "web.routes.tabs.files.view_list", defaultMessage: "List", description: "Files tab: button of the view switch that shows the files of one folder as a list; keep it short" },
  view_tree: { id: "web.routes.tabs.files.view_tree", defaultMessage: "Tree", description: "Files tab: button of the view switch that shows a folder tree beside the files; keep it short" },
  folder_tree: { id: "web.routes.tabs.files.folder_tree", defaultMessage: "Folder tree", description: "Files tab: accessible label of the folder tree panel shown beside the files in tree view; not shown as text" },
  tree_load_failed: { id: "web.routes.tabs.files.tree_load_failed", defaultMessage: "Could not load", description: "Files tab: muted text in the folder tree where a folder's contents could not be loaded" },
  tree_drop_hint: { id: "web.routes.tabs.files.tree_drop_hint", defaultMessage: "Drop files or folders here to upload", description: "Files tab: hint at the bottom of the folder tree saying files or folders can be dropped in to upload them" },
  ask_claude: { id: "web.routes.tabs.files.ask_claude", defaultMessage: "Ask Claude", description: "Files tab: icon-only button beside the List and Tree switch that opens the Claude chat next to the open file or folder; read by screen readers; keep it short" },
  open_files: { id: "web.routes.tabs.files.open_files", defaultMessage: "Open files", description: "Files tab: accessible label of the row of tabs above the editor in tree view, one tab per open file; not shown as text" },
});

const SAVE_STATES = defineMessages({
  read_only: { id: "web.routes.tabs.files.read_only", defaultMessage: "Read only", description: "Files tab: status beside the open file when the user cannot edit it" },
  failed: { id: "web.routes.tabs.files.save_failed", defaultMessage: "Save failed", description: "Files tab: status beside the open file when the last save failed" },
  saving: { id: "web.routes.tabs.files.saving", defaultMessage: "Saving…", description: "Files tab: status beside the open file while changes are being saved" },
  saved: { id: "web.routes.tabs.files.saved", defaultMessage: "Saved", description: "Files tab: status beside the open file when all changes are saved" },
});

interface EditorTabsProps {
  paths: string[];
  onOpen: (path: string) => void;
  onClose: (path: string) => void;
}

interface ViewProps {
  resourceTarget: ResourceTarget;
  path: string;
  onNavigate: (path: string) => void;
  viewToggle?: ReactNode;
  aside?: ReactNode;
}

export function FilesTab({ name, ns, path, onNavigate }: { name: string; ns?: string; path: string; onNavigate: (path: string) => void }) {
  const resourceTarget = useResourceTarget({ name, namespace: ns });
  const [view, setView] = useState<FilesView>(readView);
  const normalized = normalize(path);

  function changeView(next: FilesView) {
    setView(next);
    writeView(next);
  }

  return (
    <FilesBrowser
      key={JSON.stringify(resourceKey(resourceTarget, "file-editor"))}
      resourceTarget={resourceTarget}
      path={normalized}
      onNavigate={onNavigate}
      tabbed={view === "tree"}
      viewToggle={<ViewToggle view={view} onChange={changeView} />}
      aside={view === "tree" && <FileTree resourceTarget={resourceTarget} path={normalized} onNavigate={onNavigate} />}
    />
  );
}

function Split({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  if (!aside) return children;
  return (
    <div className="flex flex-1 flex-col gap-3 md:flex-row">
      {aside}
      <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
    </div>
  );
}

function FilesBrowser({ resourceTarget, path, onNavigate, viewToggle, aside, tabbed }: ViewProps & { tabbed: boolean }) {
  const intl = useOptionalIntl();
  const { name, namespace: ns } = resourceTarget;
  const client = useResourceClient(resourceTarget);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [openedPath, setOpenedPath] = useState<string | null>(null);
  const tabs: EditorTabsProps | undefined = tabbed ? {
    paths: openFiles,
    onOpen: onNavigate,
    onClose: (file) => {
      const index = openFiles.indexOf(file);
      const rest = openFiles.filter((item) => item !== file);
      setOpenFiles(rest);
      if (file === path) onNavigate(rest[Math.min(index, rest.length - 1)] ?? parentOf(file));
    },
  } : undefined;
  const parent = parentOf(path);
  const isRoot = path === ROOT;
  const parentListing = useQuery({
    queryKey: listKey(resourceTarget, parent),
    queryFn: ({ signal }) => client.withSignal(signal).Files.list(name, parent, ns),
    enabled: !isRoot,
  });
  const entry = isRoot ? ROOT_ENTRY : parentListing.data?.entries.find((item) => item.name === baseName(path));
  if (tabbed && entry && !entry.dir && openedPath !== path) {
    setOpenedPath(path);
    if (!openFiles.includes(path)) setOpenFiles([...openFiles, path]);
  }

  return (
    <div className="flex min-h-full flex-col gap-4 p-6">
      {entry?.dir ? (
        <DirectoryView key={path} resourceTarget={resourceTarget} path={path} onNavigate={onNavigate} viewToggle={viewToggle} aside={aside} />
      ) : entry ? (
        <FileEditor key={path} resourceTarget={resourceTarget} path={path} entry={entry} onNavigate={onNavigate} viewToggle={viewToggle} aside={aside} tabs={tabs} />
      ) : (
        <>
          <Breadcrumbs path={path} onNavigate={onNavigate} />
          <Split aside={aside}>
            {parentListing.error ? (
              <ErrorBanner err={parentListing.error} />
            ) : parentListing.isPending ? (
              <Spinner />
            ) : (
              <div className="grid flex-1 place-items-center rounded-lg border border-border bg-surface/50 p-10 text-center">
                <div className="space-y-3">
                  <p className="text-sm text-muted">{intl.formatMessage(FILES_MESSAGES.nothing_exists)}</p>
                  <Button variant="secondary" size="sm" onPress={() => onNavigate(parent)}>
                    {intl.formatMessage({ id: "web.routes.tabs.files.open_folder", defaultMessage: "Open {folder}", description: "Files tab: button that opens the parent folder of a missing path; {folder} is the folder name or the root folder text" }, { folder: parent === ROOT ? intl.formatMessage(FILES_MESSAGES.root_folder) : baseName(parent) })}
                  </Button>
                </div>
              </div>
            )}
          </Split>
        </>
      )}
    </div>
  );
}

function DirectoryView({ resourceTarget, path, onNavigate, viewToggle, aside }: ViewProps) {
  const intl = useOptionalIntl();
  const fmt = useFormat();
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
  const [assistantOpen, setAssistantOpen] = useState(false);
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
    mutationFn: (groups: Map<string, File[]>) => uploadGroups(client, resourceTarget, path, groups),
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

  const browser = (
    <>
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
            label={intl.formatMessage(FILES_MESSAGES.select_all)}
            isSelected={allSelected}
            isIndeterminate={selection.length > 0 && !allSelected}
            isDisabled={!entries?.length}
            onChange={() => setSelected(allSelected ? new Set() : new Set(entries?.map((entry) => entry.path)))}
          />
          <span className="flex-1 pl-7">{intl.formatMessage(FILES_MESSAGES.column_name)}</span>
          <span className="w-24 text-right">{intl.formatMessage(FILES_MESSAGES.column_size)}</span>
          <span className="hidden w-28 text-right md:block">{intl.formatMessage(FILES_MESSAGES.column_modified)}</span>
          <span className="w-[4.5rem]" />
        </div>
        {listing.error ? (
          <div className="p-4">
            <ErrorBanner err={listing.error} />
          </div>
        ) : !entries ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">{intl.formatMessage(FILES_MESSAGES.this_folder_is_empty)}</p>
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
                <SelectBox label={intl.formatMessage({ id: "web.routes.tabs.files.select_entry", defaultMessage: "Select {name}", description: "Files tab: accessible label of the checkbox on a file or folder row; {name} is the file or folder name" }, { name: entry.name })} isSelected={selected.has(entry.path)} onChange={() => toggle(entry.path)} />
                <button
                  type="button"
                  onClick={() => onNavigate(entry.path)}
                  className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-4 text-left text-sm"
                >
                  <EntryIcon entry={entry} />
                  <span className="min-w-0 flex-1 truncate text-foreground" title={entry.name}>{entry.name}</span>
                  <span className="w-24 shrink-0 text-right text-xs text-muted">
                    {entry.dir ? <DirSize resourceTarget={resourceTarget} path={entry.path} /> : formatBytes(entry.size)}
                  </span>
                  <span className="hidden w-28 shrink-0 text-right text-xs text-muted md:block">{formatRelative(entry.modTime, intl)}</span>
                </button>
                <div className="flex w-[4.5rem] shrink-0 justify-end gap-1 pr-2 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    aria-label={intl.formatMessage({ id: "web.routes.tabs.files.download_entry_aria", defaultMessage: "Download {name}", description: "Files: aria-label of the download button on a file or folder row; {name} is the file or folder name" }, { name: entry.name })}
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
                    aria-label={intl.formatMessage({ id: "web.routes.tabs.files.delete_entry_aria", defaultMessage: "Delete {name}", description: "Files: aria-label of the delete button on a file or folder row; {name} is the file or folder name" }, { name: entry.name })}
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
            {intl.formatMessage({ id: "web.routes.tabs.files.showing_entries", defaultMessage: "Showing {shown} of {total} entries. The file list limit is set in Settings → General.", description: "Files tab: note under a large folder listing saying only part of the entries is shown and where the limit is set; {shown} is the shown count and {total} the total count" }, { shown: fmt.number(entries.length), total: fmt.number(total) })}
          </p>
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background/80 text-sm font-medium text-primary">
            <Upload className="h-4 w-4" /> {intl.formatMessage(FILES_MESSAGES.drop_files_to_upload)}
          </div>
        )}
      </div>
      {canControl && (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Upload className="h-3.5 w-3.5" /> {intl.formatMessage(FILES_MESSAGES.drag_files_hint)}
        </p>
      )}
    </>
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Breadcrumbs path={path} onNavigate={onNavigate} />
        <div className="flex flex-wrap items-center gap-2">
          {selection.length > 0 && (
            <div
              role="toolbar"
              aria-label={intl.formatMessage(FILES_MESSAGES.selection_actions)}
              className="flex flex-wrap items-center gap-2 border-border pr-2 sm:border-r"
            >
              <span className="text-sm font-medium text-foreground">{intl.formatMessage({ id: "web.routes.tabs.files.selected_count", defaultMessage: "{count, plural, one {# selected} other {# selected}}", description: "Files tab: how many files and folders are selected, shown above the selection actions; {count} is the number selected" }, { count: selection.length })}</span>
              <Button variant="ghost" size="sm" onPress={() => setSelected(new Set())}>
                {intl.formatMessage(FILES_MESSAGES.clear)}
              </Button>
              <Button variant="secondary" size="sm" onPress={downloadSelection}>
                <Download className="h-4 w-4" /> {intl.formatMessage(FILES_MESSAGES.download)}
              </Button>
              <Button variant="secondary" size="sm" isDisabled={!canControl} onPress={() => setPrompt("zip")}>
                <FileArchive className="h-4 w-4" /> {intl.formatMessage(FILES_MESSAGES.zip)}
              </Button>
              <Button variant="danger" size="sm" isDisabled={!canControl} onPress={() => setConfirmBulkDelete(true)}>
                <Trash2 className="h-4 w-4" /> {intl.formatMessage(FILES_MESSAGES.delete)}
              </Button>
            </div>
          )}
          {viewToggle}
          {aside && <AskClaudeButton open={assistantOpen} onToggle={() => setAssistantOpen(!assistantOpen)} />}
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            aria-label={intl.formatMessage(FILES_MESSAGES.refresh)}
            onPress={() => {
              void qc.invalidateQueries({ queryKey: sizeKey(resourceTarget) });
              void listing.refetch();
            }}
          >
            <RefreshCw className={cn("h-4 w-4", listing.isFetching && "animate-spin")} />
          </Button>
          <Button variant="secondary" size="sm" isDisabled={!canControl} onPress={() => setPrompt("folder")}>
            <FolderPlus className="h-4 w-4" /> {intl.formatMessage(FILES_MESSAGES.new_folder)}
          </Button>
          {upload.isPending && (
            <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> {intl.formatMessage(FILES_MESSAGES.uploading)}
            </span>
          )}
          <Button variant="primary" size="sm" isDisabled={!canControl} onPress={() => setPrompt("file")}>
            <FilePlus className="h-4 w-4" /> {intl.formatMessage(FILES_MESSAGES.new_file)}
          </Button>
        </div>
      </div>

      {error && <ErrorBanner err={error} onDismiss={() => setError(null)} />}

      <Split aside={aside}>
        {aside && assistantOpen ? (
          <div className="grid flex-1 gap-3 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-4">{browser}</div>
            <div className="relative min-h-[60vh]">
              <FileAssistant scope={{ server: name, namespace: ns, cluster: resourceTarget.cluster }} onClose={() => setAssistantOpen(false)} />
            </div>
          </div>
        ) : (
          browser
        )}
      </Split>

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
          title={intl.formatMessage({ id: "web.routes.tabs.files.delete_items_title", defaultMessage: "Delete {count, plural, one {# item} other {# items}}?", description: "Files tab: title of the confirm dialog for deleting the selected items; {count} is the number of items" }, { count: selection.length })}
          description={intl.formatMessage(FILES_MESSAGES.delete_selected_body)}
          destructive
          confirmLabel={intl.formatMessage(FILES_MESSAGES.delete)}
          busy={removeSelected.isPending}
          onConfirm={() => removeSelected.mutate(selection)}
        />
      )}
      <NamePromptDialog
        open={prompt === "folder"}
        onOpenChange={(open) => setPrompt(open ? "folder" : null)}
        title={intl.formatMessage(FILES_MESSAGES.new_folder)}
        label={intl.formatMessage(FILES_MESSAGES.folder_name)}
        placeholder={intl.formatMessage(FILES_MESSAGES.my_folder)}
        confirmLabel={intl.formatMessage(FILES_MESSAGES.create)}
        busy={create.isPending}
        onSubmit={(entryName) => create.mutate({ kind: "folder", entryName })}
      />
      <NamePromptDialog
        open={prompt === "file"}
        onOpenChange={(open) => setPrompt(open ? "file" : null)}
        title={intl.formatMessage(FILES_MESSAGES.new_file)}
        label={intl.formatMessage(FILES_MESSAGES.file_name)}
        placeholder={intl.formatMessage(FILES_MESSAGES.config_yaml)}
        confirmLabel={intl.formatMessage(FILES_MESSAGES.create)}
        busy={create.isPending}
        onSubmit={(entryName) => create.mutate({ kind: "file", entryName })}
      />
      <NamePromptDialog
        open={prompt === "zip"}
        onOpenChange={(open) => setPrompt(open ? "zip" : null)}
        title={intl.formatMessage(FILES_MESSAGES.create_zip_archive)}
        label={intl.formatMessage(FILES_MESSAGES.archive_name)}
        placeholder={intl.formatMessage(FILES_MESSAGES.archive_zip)}
        initialValue={archiveName(entries ?? [], selection)}
        confirmLabel={intl.formatMessage(FILES_MESSAGES.create)}
        busy={zip.isPending}
        onSubmit={(entryName) => zip.mutate({ entryName, paths: selectionPaths })}
      />
    </>
  );
}

function FileEditor({ resourceTarget, path, entry, onNavigate, viewToggle, aside, tabs }: ViewProps & { entry: FileEntry; tabs?: EditorTabsProps }) {
  const intl = useOptionalIntl();
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
  const [assistantOpen, setAssistantOpen] = useState(false);
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

  const saveState: SaveState = !canControl
    ? "read_only"
    : failed && failed.body === draft?.value
      ? "failed"
      : dirty || saving ? "saving" : "saved";

  async function reload() {
    await qc.resetQueries({ queryKey: resourceKey(resourceTarget, "file-content", name, path, ns) });
    setDraft(null);
  }

  const editor = (
    <div className="flex min-h-[60vh] flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background">
      {tabs && <EditorTabs {...tabs} active={path} />}
      <div className="relative flex flex-1 flex-col">
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
              scrollBeyondLastLine: false,
            }}
          />
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Breadcrumbs path={path} onNavigate={onNavigate} />
        <div className="flex items-center gap-2">
          {viewToggle}
          <AskClaudeButton open={assistantOpen} onToggle={() => setAssistantOpen(!assistantOpen)} />
          {draft && (
            <span role="status" className="flex items-center gap-1.5 pr-1 text-xs text-muted">
              {SAVE_ICONS[saveState]} {intl.formatMessage(SAVE_STATES[saveState])}
            </span>
          )}
          <Button variant="secondary" size="sm" onPress={() => download(client.Files.downloadURL(name, path, ns))}>
            <Download className="h-4 w-4" /> {intl.formatMessage(FILES_MESSAGES.download)}
          </Button>
          <Button variant="danger" size="sm" isDisabled={!canControl} onPress={() => setConfirmDelete(true)}>
            <Trash2 className="h-4 w-4" /> {intl.formatMessage(FILES_MESSAGES.delete)}
          </Button>
        </div>
      </div>

      {failed && <ErrorBanner err={failed.error} onDismiss={() => setFailed(null)} />}
      {error && <ErrorBanner err={error} onDismiss={() => setError(null)} />}

      <Split aside={aside}>
        {assistantOpen ? (
          <div className="grid flex-1 gap-3 lg:grid-cols-2">
            {editor}
            <div className="relative min-h-[60vh]">
              <FileAssistant
                scope={{ server: name, namespace: ns, cluster: resourceTarget.cluster }}
                file={{
                  path,
                  language: guessLang(entry.name),
                  content: draft?.value ?? "",
                  canControl,
                  onApply: (next) => setDraft((current) => current && { ...current, value: next }),
                  onSaved: () => void reload(),
                }}
                onClose={() => setAssistantOpen(false)}
              />
            </div>
          </div>
        ) : (
          editor
        )}
      </Split>

      {confirmDelete && (
        <DeleteDialog
          resourceTarget={resourceTarget}
          entry={entry}
          onClose={() => setConfirmDelete(false)}
          onDeleted={() => {
            deleted.current = true;
            if (tabs) tabs.onClose(path);
            else onNavigate(parentOf(path));
          }}
          onError={setError}
        />
      )}
    </>
  );
}

function EditorTabs({ paths, active, onOpen, onClose }: EditorTabsProps & { active: string }) {
  const intl = useOptionalIntl();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <div ref={list} role="tablist" aria-label={intl.formatMessage(FILES_MESSAGES.open_files)} className="flex shrink-0 gap-px overflow-x-auto border-b border-border bg-border scrollbar-thin">
      {paths.map((tabPath) => {
        const isActive = tabPath === active;
        return (
          <div key={tabPath} className={cn("flex h-11 shrink-0 items-center gap-2 pl-3.5 pr-2", isActive ? "bg-background text-foreground" : "bg-surface text-muted hover:text-foreground")}>
            <button type="button" role="tab" aria-selected={isActive} title={tabPath} onClick={() => onOpen(tabPath)} className="flex items-center gap-2 font-mono text-[13px] font-medium">
              <FileText className={cn("h-3.5 w-3.5", isActive && "text-primary")} />
              {baseName(tabPath)}
            </button>
            <button type="button" aria-label={intl.formatMessage({ id: "web.routes.tabs.files.close_tab", defaultMessage: "Close {name}", description: "Files tab: accessible label of the x button on an editor tab that closes that open file; {name} is the file name; not shown as text" }, { name: baseName(tabPath) })} onClick={() => onClose(tabPath)} className="rounded p-0.5 text-muted hover:bg-border hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

type SaveState = keyof typeof SAVE_STATES;

const SAVE_ICONS: Record<SaveState, ReactNode> = {
  read_only: null,
  failed: <CircleAlert className="h-3.5 w-3.5 text-danger" />,
  saving: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
  saved: <CircleCheck className="h-3.5 w-3.5 text-success" />,
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
  const intl = useOptionalIntl();
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
      title={intl.formatMessage({ id: "web.routes.tabs.files.delete_entry_title", defaultMessage: "Delete {name}?", description: "Files: title of the confirm dialog for deleting a file or folder; {name} is the file or folder name" }, { name: entry.name })}
      description={
        entry.dir
          ? intl.formatMessage(FILES_MESSAGES.delete_folder_body)
          : intl.formatMessage(FILES_MESSAGES.delete_file_body)
      }
      destructive
      confirmLabel={intl.formatMessage(FILES_MESSAGES.delete)}
      busy={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );
}

function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const intl = useOptionalIntl();
  const segments = path.split("/").filter(Boolean);
  return (
    <nav aria-label={intl.formatMessage(FILES_MESSAGES.path)} className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        aria-label={intl.formatMessage(FILES_MESSAGES.root_folder_label)}
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

function ViewToggle({ view, onChange }: { view: FilesView; onChange: (view: FilesView) => void }) {
  const intl = useOptionalIntl();
  return (
    <div role="group" aria-label={intl.formatMessage(FILES_MESSAGES.file_view)} className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      <button type="button" aria-pressed={view === "list"} onClick={() => onChange("list")} className={viewButtonClass(view === "list")}>
        <List className="h-3.5 w-3.5" /> {intl.formatMessage(FILES_MESSAGES.view_list)}
      </button>
      <button type="button" aria-pressed={view === "tree"} onClick={() => onChange("tree")} className={viewButtonClass(view === "tree")}>
        <ListTree className="h-3.5 w-3.5" /> {intl.formatMessage(FILES_MESSAGES.view_tree)}
      </button>
    </div>
  );
}

function AskClaudeButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const intl = useOptionalIntl();
  return (
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      aria-label={intl.formatMessage(FILES_MESSAGES.ask_claude)}
      aria-pressed={open}
      className={cn(open && "bg-primary/10 text-primary")}
      onPress={onToggle}
    >
      <Sparkles className="h-4 w-4" />
    </Button>
  );
}

function viewButtonClass(active: boolean) {
  return cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium", active ? "bg-primary/10 text-primary" : "text-muted hover:text-foreground");
}

interface TreeProps {
  resourceTarget: ResourceTarget;
  path: string;
  expanded: ReadonlySet<string>;
  selected: ReadonlyMap<string, FileEntry>;
  dropDir: string | null;
  onSelect: (entry: FileEntry, event: MouseEvent) => void;
  onNavigate: (path: string) => void;
}

interface TreeLevelProps extends TreeProps {
  dir: string;
  depth: number;
}

function FileTree({ resourceTarget, path, onNavigate }: Omit<ViewProps, "viewToggle">) {
  const intl = useOptionalIntl();
  const canControl = useResourceAccess()?.canControl === true;
  const { name, namespace: ns } = resourceTarget;
  const client = useResourceClient(resourceTarget);
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(ancestorsOf(path)));
  const [trackedPath, setTrackedPath] = useState(path);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [selected, setSelected] = useState<ReadonlyMap<string, FileEntry>>(new Map());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selection = [...selected.values()].filter((entry) => !ancestorsOf(entry.path).some((dir) => selected.has(dir)));
  const selectionPaths = selection.map((entry) => entry.path);
  const zipDir = selection.length > 0 ? commonParent(selectionPaths) : ROOT;
  if (trackedPath !== path) {
    setTrackedPath(path);
    setExpanded((current) => new Set([...current, ...ancestorsOf(path)]));
  }

  const upload = useMutation({
    mutationFn: ({ base, groups }: { base: string; groups: Map<string, File[]> }) => uploadGroups(client, resourceTarget, base, groups),
    onSuccess: async (_result, { base }) => {
      void qc.invalidateQueries({ queryKey: sizeKey(resourceTarget) });
      await qc.invalidateQueries({ queryKey: listKey(resourceTarget, base) });
      setError(null);
    },
    onError: (err: Error) => setError(err),
  });

  async function refresh() {
    setSelected(new Map());
    void qc.invalidateQueries({ queryKey: ["fleet"] });
    void qc.invalidateQueries({ queryKey: sizeKey(resourceTarget) });
    await qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "files") });
    setError(null);
  }

  const zip = useMutation({
    mutationFn: (entryName: string) => client.Files.zip(name, joinPath(zipDir, entryName), selectionPaths, ns),
    onSuccess: async () => {
      setPrompt(false);
      await refresh();
    },
    onError: (err: Error) => setError(err),
  });

  const removeSelected = useMutation({
    mutationFn: async (targets: FileEntry[]) => {
      for (const entry of targets) await client.Files.remove(name, entry.path, entry.dir, ns);
    },
    onSuccess: async (_result, targets) => {
      setConfirmDelete(false);
      const removed = targets.find((entry) => path === entry.path || path.startsWith(`${entry.path}/`));
      if (removed) onNavigate(parentOf(removed.path));
      await refresh();
    },
    onError: (err: Error) => {
      setConfirmDelete(false);
      setError(err);
      void qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "files") });
    },
  });

  function visibleEntries(dir: string): FileEntry[] {
    const entries = qc.getQueryData<{ entries: FileEntry[] }>(listKey(resourceTarget, dir))?.entries ?? [];
    return sortEntries(entries).flatMap((entry) => (entry.dir && expanded.has(entry.path) ? [entry, ...visibleEntries(entry.path)] : [entry]));
  }

  function select(entry: FileEntry, event: MouseEvent) {
    if (event.shiftKey) {
      const visible = visibleEntries(ROOT);
      const to = visible.findIndex((item) => item.path === entry.path);
      const from = visible.findIndex((item) => item.path === (anchor ?? path));
      const range = from < 0 ? [entry] : visible.slice(Math.min(from, to), Math.max(from, to) + 1);
      setSelected(new Map(range.map((item) => [item.path, item])));
      return;
    }
    setAnchor(entry.path);
    if (event.ctrlKey || event.metaKey) {
      setSelected((current) => {
        const next = new Map(current);
        if (!next.delete(entry.path)) next.set(entry.path, entry);
        return next;
      });
      return;
    }
    setSelected(new Map());
    if (!entry.dir) {
      onNavigate(entry.path);
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(entry.path)) next.add(entry.path);
      return next;
    });
  }

  function downloadSelection() {
    const single = selection.length === 1 ? selection[0] : undefined;
    download(single && !single.dir ? client.Files.downloadURL(name, single.path, ns) : client.Files.archiveURL(name, selectionPaths, ns));
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!canControl) return;
    event.preventDefault();
    setDropDir(dropTargetOf(event.target));
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropDir(null);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const base = dropTargetOf(event.target);
    setDropDir(null);
    if (!canControl) return;
    void collectDropped(event.dataTransfer).then(
      (groups) => {
        if (groups.size > 0) upload.mutate({ base, groups });
      },
      (err: unknown) => setError(err instanceof Error ? err : new Error(String(err))),
    );
  }

  const tree: TreeProps = { resourceTarget, path, expanded, selected, dropDir, onSelect: select, onNavigate };

  return (
    <aside
      aria-label={intl.formatMessage(FILES_MESSAGES.folder_tree)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "flex shrink-0 flex-col rounded-xl border border-border bg-surface md:sticky md:top-0 md:max-h-[calc(100vh-3rem)] md:w-[272px] md:[contain:size]",
        dropDir === ROOT && "border-primary",
      )}
    >
      {error && (
        <div className="p-2">
          <ErrorBanner err={error} onDismiss={() => setError(null)} />
        </div>
      )}
      {selection.length > 0 && (
        <div role="toolbar" aria-label={intl.formatMessage(FILES_MESSAGES.selection_actions)} className="flex items-center gap-1 border-b border-border py-1.5 pl-3 pr-1.5">
          <span className="flex-1 text-xs font-medium text-foreground">{intl.formatMessage({ id: "web.routes.tabs.files.selected_count", defaultMessage: "{count, plural, one {# selected} other {# selected}}", description: "Files tab: how many files and folders are selected, shown above the selection actions; {count} is the number selected" }, { count: selection.length })}</span>
          <Button isIconOnly variant="ghost" size="sm" aria-label={intl.formatMessage(FILES_MESSAGES.download)} onPress={downloadSelection}>
            <Download className="h-4 w-4" />
          </Button>
          <Button isIconOnly variant="ghost" size="sm" aria-label={intl.formatMessage(FILES_MESSAGES.zip)} isDisabled={!canControl} onPress={() => setPrompt(true)}>
            <FileArchive className="h-4 w-4" />
          </Button>
          <Button isIconOnly variant="ghost" size="sm" aria-label={intl.formatMessage(FILES_MESSAGES.delete)} isDisabled={!canControl} onPress={() => setConfirmDelete(true)} className="text-danger">
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button isIconOnly variant="ghost" size="sm" aria-label={intl.formatMessage(FILES_MESSAGES.clear)} onPress={() => setSelected(new Map())}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      <ul role="tree" aria-multiselectable className="flex-1 overflow-auto p-2 scrollbar-thin">
        <TreeLevel {...tree} dir={ROOT} depth={0} />
      </ul>
      {upload.isPending && (
        <p role="status" className="flex items-center justify-center gap-1.5 border-t border-border px-3 py-2.5 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {intl.formatMessage(FILES_MESSAGES.uploading)}
        </p>
      )}
      {canControl && (
        <p className="flex items-center justify-center gap-1.5 border-t border-border px-3 py-2.5 text-center text-xs text-muted">
          <Upload className="h-3.5 w-3.5" /> {intl.formatMessage(FILES_MESSAGES.tree_drop_hint)}
        </p>
      )}
      {confirmDelete && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmDelete(false)}
          title={intl.formatMessage({ id: "web.routes.tabs.files.delete_items_title", defaultMessage: "Delete {count, plural, one {# item} other {# items}}?", description: "Files tab: title of the confirm dialog for deleting the selected items; {count} is the number of items" }, { count: selection.length })}
          description={intl.formatMessage(FILES_MESSAGES.delete_selected_body)}
          destructive
          confirmLabel={intl.formatMessage(FILES_MESSAGES.delete)}
          busy={removeSelected.isPending}
          onConfirm={() => removeSelected.mutate(selection)}
        />
      )}
      <NamePromptDialog
        open={prompt}
        onOpenChange={setPrompt}
        title={intl.formatMessage(FILES_MESSAGES.create_zip_archive)}
        label={intl.formatMessage(FILES_MESSAGES.archive_name)}
        placeholder={intl.formatMessage(FILES_MESSAGES.archive_zip)}
        initialValue={archiveName(qc.getQueryData<{ entries: FileEntry[] }>(listKey(resourceTarget, zipDir))?.entries ?? [], selection)}
        confirmLabel={intl.formatMessage(FILES_MESSAGES.create)}
        busy={zip.isPending}
        onSubmit={(entryName) => zip.mutate(entryName)}
      />
    </aside>
  );
}

function TreeLevel({ dir, depth, ...tree }: TreeLevelProps) {
  const intl = useOptionalIntl();
  const client = useResourceClient(tree.resourceTarget);
  const { name, namespace: ns } = tree.resourceTarget;
  const listing = useQuery({
    queryKey: listKey(tree.resourceTarget, dir),
    queryFn: ({ signal }) => client.withSignal(signal).Files.list(name, dir, ns),
  });
  if (!listing.data && listing.error) {
    return <li role="none" style={{ paddingLeft: 8 + depth * 14 }} className="py-1 text-xs text-muted">{intl.formatMessage(FILES_MESSAGES.tree_load_failed)}</li>;
  }
  if (!listing.data) {
    return <li role="none" style={{ paddingLeft: 8 + depth * 14 }} className="py-1"><Loader2 className="h-3.5 w-3.5 animate-spin text-muted" /></li>;
  }
  return sortEntries(listing.data.entries).map((entry) => {
    const isOpen = entry.dir && tree.expanded.has(entry.path);
    return (
      <li key={entry.path} role="treeitem" aria-expanded={entry.dir ? isOpen : undefined} aria-selected={tree.selected.has(entry.path) || entry.path === tree.path}>
        <button
          type="button"
          style={{ paddingLeft: 8 + depth * 14 }}
          data-drop-dir={entry.dir ? entry.path : undefined}
          onClick={(event) => tree.onSelect(entry, event)}
          onDoubleClick={entry.dir ? () => tree.onNavigate(entry.path) : undefined}
          className={cn(
            "flex w-full select-none items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] text-foreground hover:bg-border/60",
            entry.path === tree.path && "bg-primary/10 text-primary",
            tree.selected.has(entry.path) && "bg-primary/20 text-primary",
            tree.dropDir === entry.path && "bg-primary/10",
          )}
        >
          {entry.dir ? (
            <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", isOpen && "rotate-90")} />
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" />
          )}
          <EntryIcon entry={entry} />
          <span className="truncate">{entry.name}</span>
        </button>
        {isOpen && (
          <ul role="group">
            <TreeLevel {...tree} dir={entry.path} depth={depth + 1} />
          </ul>
        )}
      </li>
    );
  });
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
  const intl = useOptionalIntl();
  const client = useResourceClient(resourceTarget);
  const size = useQuery({
    queryKey: sizeKey(resourceTarget, path),
    queryFn: ({ signal }) => client.withSignal(signal).Files.size(resourceTarget.name, path, resourceTarget.namespace),
    staleTime: SIZE_CACHE_MS,
    retry: false,
  });
  if (size.isPending) return <Loader2 aria-label={intl.formatMessage(FILES_MESSAGES.calculating_size)} className="ml-auto h-3.5 w-3.5 animate-spin" />;
  return size.data === undefined ? intl.formatMessage(FILES_MESSAGES.empty_value) : formatBytes(size.data);
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
  const intl = useOptionalIntl();
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
                      {intl.formatMessage(FILES_MESSAGES.names_invalid)}
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
                {intl.formatMessage(FILES_MESSAGES.cancel)}
              </Button>
              <Button
                variant="primary"
                isDisabled={!valid || busy}
                onPress={() => {
                  if (valid && !busy) onSubmit(trimmed);
                }}
              >
                {busy ? intl.formatMessage(FILES_MESSAGES.working) : confirmLabel}
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

function commonParent(paths: string[]): string {
  let dir = parentOf(paths[0]);
  while (dir !== ROOT && !paths.every((target) => target.startsWith(`${dir}/`))) dir = parentOf(dir);
  return dir;
}

function ancestorsOf(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  return segments.slice(0, -1).map((_, index) => `/${segments.slice(0, index + 1).join("/")}`);
}

function dropTargetOf(target: EventTarget): string {
  return (target as Element).closest<HTMLElement>("[data-drop-dir]")?.dataset.dropDir ?? ROOT;
}

function readView(): FilesView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

function writeView(view: FilesView) {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    return;
  }
}

async function uploadGroups(client: ResourceClient, resourceTarget: ResourceTarget, base: string, groups: Map<string, File[]>) {
  const { name, namespace: ns } = resourceTarget;
  for (const [dir, files] of groups) {
    const destination = dir ? joinPath(base, dir) : base;
    if (files.length === 0) await client.Files.mkdir(name, destination, ns);
    for (const batch of uploadBatches(files)) await client.Files.upload(name, destination, batch, ns);
  }
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
