import { ResourceTargetProvider } from "@/lib/resourceTarget";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithQuery as baseRenderWithQuery } from "@/test/render";
import { FilesTab } from "./Files";

type FetchInit = Parameters<typeof fetch>[1];
type Route = (init?: FetchInit) => Response | Promise<Response>;

vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (v: string | undefined) => void;
  }) => (
    <textarea
      data-testid="monaco"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textRes(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

const ROOT_ENTRIES = [
  { name: "config", path: "/config", size: 0, dir: true },
  { name: "server.properties", path: "/server.properties", size: 2100, dir: false },
];

const TWO_FILES = [...ROOT_ENTRIES, { name: "config.yaml", path: "/config.yaml", size: 100, dir: false }];

const ROOT_LIST = "GET /servers/mc-survival/files/list?path=%2F";
const PROPERTIES_READ = "GET /servers/mc-survival/files/read?path=%2Fserver.properties";
const PROPERTIES_WRITE = "POST /servers/mc-survival/files/write?path=%2Fserver.properties";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockRoutes(routes: Record<string, Route>) {
  fetchMock.mockImplementation(async (url: string, init?: FetchInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    return route(init);
  });
}

function mockServerProperties(routes: Record<string, Route> = {}) {
  mockRoutes({
    [ROOT_LIST]: () => jsonRes(ROOT_ENTRIES),
    [PROPERTIES_READ]: () => textRes("original"),
    ...routes,
  });
}

function recordWrites(bodies: string[], response: () => Response | Promise<Response> = () => new Response(null, { status: 204 })): Route {
  return (init) => {
    bodies.push(init?.body as string);
    return response();
  };
}

function requests(): string[] {
  return fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${url}`);
}

function rowNames() {
  return screen.getAllByRole("listitem").map((item) => item.querySelector("span.truncate")?.textContent);
}

function currentPath() {
  return screen.getByTestId("path").textContent;
}

function idle(ms: number) {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

function stubLocation() {
  const original = window.location;
  Object.defineProperty(window, "location", { writable: true, value: { href: "" } });
  return () => {
    Object.defineProperty(window, "location", { value: original });
  };
}

const CONFIG_SIZE = "GET /servers/mc-survival/files/size?path=%2Fconfig";

function row(entryName: string) {
  return screen.getByText(entryName).closest("li") as HTMLElement;
}

function openFiles() {
  return within(screen.getByRole("tablist", { name: "Open files" }));
}

function toolbar() {
  return screen.getByRole("toolbar", { name: "Selection actions" });
}

describe("FilesTab", () => {
  it("lists folders before files, each sorted by name", async () => {
    mockRoutes({
      [ROOT_LIST]: () => jsonRes([
        { name: "b.txt", path: "/b.txt", size: 1, dir: false },
        { name: "zeta", path: "/zeta", size: 0, dir: true },
        { name: "a.txt", path: "/a.txt", size: 1, dir: false },
        { name: "Alpha", path: "/Alpha", size: 0, dir: true },
        { name: "plugin.jar", path: "/plugin.jar", size: 1, dir: false },
        { name: "data.json", path: "/data.json", size: 1, dir: false },
      ]),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("b.txt");
    expect(rowNames()).toEqual(["Alpha", "zeta", "a.txt", "b.txt", "data.json", "plugin.jar"]);
  });

  it("navigates into a folder on click and marks its crumb as the current page", async () => {
    mockRoutes({
      [ROOT_LIST]: () => jsonRes(ROOT_ENTRIES),
      "GET /servers/mc-survival/files/list?path=%2Fconfig": () => jsonRes([
        { name: "server-config.yaml", path: "/config/server-config.yaml", size: 512, dir: false },
      ]),
    });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByText("config"));
    expect(await screen.findByText("server-config.yaml")).toBeInTheDocument();
    expect(currentPath()).toBe("/config");
    expect(requests()).toContain("GET /servers/mc-survival/files/list?path=%2Fconfig");
    expect(screen.getByRole("button", { name: "config" })).toHaveAttribute("aria-current", "page");
  });

  it("opens a file in the editor without a Save button", async () => {
    mockServerProperties({ [PROPERTIES_READ]: () => textRes("motd=hello") });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByText("server.properties"));
    expect(await screen.findByTestId("monaco")).toHaveValue("motd=hello");
    expect(currentPath()).toBe("/server.properties");
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
  });

  it("deep-links to a file by its path", async () => {
    mockRoutes({
      "GET /servers/mc-survival/files/list?path=%2Fconfig": () => jsonRes([
        { name: "file.txt", path: "/config/file.txt", size: 9, dir: false },
      ]),
      "GET /servers/mc-survival/files/read?path=%2Fconfig%2Ffile.txt": () => textRes("file body"),
    });
    renderWithQuery(<Harness initialPath="/config/file.txt" />);
    expect(await screen.findByTestId("monaco")).toHaveValue("file body");
    expect(requests()).toContain("GET /servers/mc-survival/files/read?path=%2Fconfig%2Ffile.txt");
  });

  it("offers a way back to the root when the path does not exist", async () => {
    mockServerProperties();
    renderWithQuery(<Harness initialPath="/missing.txt" />);
    expect(await screen.findByText("Nothing exists at this path.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open root folder" }));
    await waitFor(() => expect(currentPath()).toBe("/"));
  });

  it("shows the error when the parent listing fails", async () => {
    mockRoutes({ [ROOT_LIST]: () => textRes("boom", 500) });
    renderWithQuery(<Harness initialPath="/server.properties" />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("navigates through breadcrumbs", async () => {
    mockRoutes({
      [ROOT_LIST]: () => jsonRes(ROOT_ENTRIES),
      "GET /servers/mc-survival/files/list?path=%2Fconfig": () => jsonRes([
        { name: "sub", path: "/config/sub", size: 0, dir: true },
      ]),
      "GET /servers/mc-survival/files/list?path=%2Fconfig%2Fsub": () => jsonRes([]),
    });
    renderWithQuery(<Harness initialPath="/config/sub" />);
    expect(await screen.findByText("This folder is empty.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "config" }));
    expect(await screen.findByText("sub")).toBeInTheDocument();
    expect(currentPath()).toBe("/config");
    fireEvent.click(screen.getByRole("button", { name: "Root folder" }));
    expect(await screen.findByText("server.properties")).toBeInTheDocument();
    expect(currentPath()).toBe("/");
  });

  it("autosaves an edit and reports Saving… then Saved", async () => {
    const bodies: string[] = [];
    mockServerProperties({ [PROPERTIES_WRITE]: recordWrites(bodies) });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByText("server.properties"));
    fireEvent.change(await screen.findByTestId("monaco"), { target: { value: "enable-jmx-monitoring=true\n" } });
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    await waitFor(() => expect(bodies).toEqual(["enable-jmx-monitoring=true\n"]), { timeout: 3000 });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("debounces quick edits into one write with the latest value", async () => {
    const bodies: string[] = [];
    mockServerProperties({ [PROPERTIES_WRITE]: recordWrites(bodies) });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByText("server.properties"));
    const editor = await screen.findByTestId("monaco");
    fireEvent.change(editor, { target: { value: "a" } });
    fireEvent.change(editor, { target: { value: "ab" } });
    fireEvent.change(editor, { target: { value: "abc" } });
    await waitFor(() => expect(bodies).toHaveLength(1), { timeout: 3000 });
    await idle(1200);
    expect(bodies).toEqual(["abc"]);
  }, 10_000);

  it("keeps edits made during a write and saves them next", async () => {
    const bodies: string[] = [];
    const firstWrite = deferredResponse();
    mockServerProperties({
      [PROPERTIES_WRITE]: recordWrites(bodies, () => (bodies.length === 1 ? firstWrite.promise : new Response(null, { status: 204 }))),
    });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByText("server.properties"));
    const editor = await screen.findByTestId("monaco");
    fireEvent.change(editor, { target: { value: "first edit" } });
    await waitFor(() => expect(bodies).toEqual(["first edit"]), { timeout: 3000 });
    fireEvent.change(editor, { target: { value: "second edit" } });
    await act(async () => firstWrite.resolve(new Response(null, { status: 204 })));
    await waitFor(() => expect(bodies).toEqual(["first edit", "second edit"]), { timeout: 3000 });
    expect(editor).toHaveValue("second edit");
  });

  it("shows Save failed and waits for a new edit before writing again", async () => {
    const bodies: string[] = [];
    mockServerProperties({
      [PROPERTIES_WRITE]: recordWrites(bodies, () => (bodies.length === 1 ? textRes("disk full", 500) : new Response(null, { status: 204 }))),
    });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByText("server.properties"));
    const editor = await screen.findByTestId("monaco");
    fireEvent.change(editor, { target: { value: "broken draft" } });
    await waitFor(() => expect(screen.getByText("disk full")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    await idle(1200);
    expect(bodies).toEqual(["broken draft"]);
    fireEvent.change(editor, { target: { value: "fixed draft" } });
    await waitFor(() => expect(bodies).toEqual(["broken draft", "fixed draft"]), { timeout: 3000 });
  }, 10_000);

  it("writes pending edits when leaving the file", async () => {
    const bodies: string[] = [];
    mockServerProperties({ [PROPERTIES_WRITE]: recordWrites(bodies) });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByText("server.properties"));
    fireEvent.change(await screen.findByTestId("monaco"), { target: { value: "leaving draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Root folder" }));
    await waitFor(() => expect(bodies).toEqual(["leaving draft"]));
  });

  it("is read-only without control: no writes and directory actions disabled", async () => {
    const bodies: string[] = [];
    mockServerProperties({ [PROPERTIES_WRITE]: recordWrites(bodies) });
    renderWithQuery(<Harness />, { canControl: false });
    await screen.findByText("server.properties");
    expect(screen.getByRole("button", { name: /New file/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /New folder/ })).toBeDisabled();
    fireEvent.dragOver(screen.getByTestId("files-dropzone"));
    expect(screen.queryByText("Drop files to upload")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("server.properties"));
    fireEvent.change(await screen.findByTestId("monaco"), { target: { value: "edited" } });
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Delete$/ })).toBeDisabled();
    await idle(1200);
    expect(bodies).toEqual([]);
  }, 10_000);

  it("ignores a late read for a file that is no longer open", async () => {
    const firstRead = deferredResponse();
    mockRoutes({
      [ROOT_LIST]: () => jsonRes(TWO_FILES),
      [PROPERTIES_READ]: () => firstRead.promise,
      "GET /servers/mc-survival/files/read?path=%2Fconfig.yaml": () => textRes("second file"),
    });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByText("server.properties"));
    fireEvent.click(screen.getByRole("button", { name: "Root folder" }));
    fireEvent.click(await screen.findByText("config.yaml"));
    expect(await screen.findByTestId("monaco")).toHaveValue("second file");
    await act(async () => firstRead.resolve(textRes("late first file")));
    expect(screen.getByTestId("monaco")).toHaveValue("second file");
  });

  it("reloads the file from the new target when the cluster changes", async () => {
    function TargetHarness() {
      const [cluster, setCluster] = useState("local");
      const [path, setPath] = useState("/server.properties");
      return (
        <ResourceTargetProvider target={{ cluster, name: "mc-survival" }} access={{ canWrite: true, canControl: true, canConsole: true, canDelete: true, isOwner: true, isCollaborator: false, permissions: ["*"] }}>
          <button onClick={() => setCluster("remote")}>Switch target</button>
          <FilesTab name="mc-survival" path={path} onNavigate={setPath} />
        </ResourceTargetProvider>
      );
    }
    mockRoutes({
      [ROOT_LIST]: () => jsonRes(ROOT_ENTRIES),
      "GET /servers/mc-survival/files/list?path=%2F&cluster=remote": () => jsonRes(ROOT_ENTRIES),
      [PROPERTIES_READ]: () => textRes("local content"),
      "GET /servers/mc-survival/files/read?path=%2Fserver.properties&cluster=remote": () => textRes("remote content"),
    });
    baseRenderWithQuery(<TargetHarness />);
    expect(await screen.findByTestId("monaco")).toHaveValue("local content");
    fireEvent.click(screen.getByRole("button", { name: "Switch target" }));
    await waitFor(() => expect(screen.getByTestId("monaco")).toHaveValue("remote content"));
    expect(requests()).toContain("GET /servers/mc-survival/files/read?path=%2Fserver.properties&cluster=remote");
  });

  it("deletes the open file without writing its unsaved edits", async () => {
    const bodies: string[] = [];
    mockServerProperties({
      [PROPERTIES_WRITE]: recordWrites(bodies),
      "DELETE /servers/mc-survival/files/delete?path=%2Fserver.properties": () => new Response(null, { status: 204 }),
    });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByText("server.properties"));
    fireEvent.change(await screen.findByTestId("monaco"), { target: { value: "unsaved edit" } });
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(currentPath()).toBe("/"));
    expect(requests()).toContain("DELETE /servers/mc-survival/files/delete?path=%2Fserver.properties");
    await idle(1200);
    expect(bodies).toEqual([]);
  }, 10_000);

  it("deletes a folder recursively from its row without opening it", async () => {
    mockServerProperties({
      "DELETE /servers/mc-survival/files/delete?path=%2Fconfig&recursive=true": () => new Response(null, { status: 204 }),
    });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete config" }));
    expect(await screen.findByText("Delete config?")).toBeInTheDocument();
    expect(requests()).not.toContain("GET /servers/mc-survival/files/list?path=%2Fconfig");
    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(requests()).toContain("DELETE /servers/mc-survival/files/delete?path=%2Fconfig&recursive=true"));
    expect(currentPath()).toBe("/");
  });

  it("shows the error when deleting fails", async () => {
    mockServerProperties({
      "DELETE /servers/mc-survival/files/delete?path=%2Fserver.properties": () => textRes("file in use", 400),
    });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete server.properties" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
    expect(await screen.findByText("file in use")).toBeInTheDocument();
  });

  it("creates a folder via mkdir and refetches the list", async () => {
    let listCalls = 0;
    mockServerProperties({
      [ROOT_LIST]: () => {
        listCalls += 1;
        return jsonRes(ROOT_ENTRIES);
      },
      "POST /servers/mc-survival/files/mkdir?path=%2Fnew-folder": () => new Response(null, { status: 204 }),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    const before = listCalls;
    fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
    fireEvent.change(await screen.findByPlaceholderText("my-folder"), { target: { value: "new-folder" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    });
    await waitFor(() => expect(requests()).toContain("POST /servers/mc-survival/files/mkdir?path=%2Fnew-folder"));
    await waitFor(() => expect(listCalls).toBeGreaterThan(before));
  });

  it("shows the error when creating a folder fails", async () => {
    mockServerProperties({
      "POST /servers/mc-survival/files/mkdir?path=%2Ftest": () => textRes("permission denied", 403),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
    fireEvent.change(await screen.findByPlaceholderText("my-folder"), { target: { value: "test" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    });
    expect(await screen.findByText("permission denied")).toBeInTheDocument();
  });

  it("creates an empty file and opens it", async () => {
    const bodies: string[] = [];
    let created = false;
    mockServerProperties({
      [ROOT_LIST]: () => jsonRes(created ? [...ROOT_ENTRIES, { name: "new.txt", path: "/new.txt", size: 0, dir: false }] : ROOT_ENTRIES),
      "POST /servers/mc-survival/files/write?path=%2Fnew.txt": (init) => {
        bodies.push(init?.body as string);
        created = true;
        return new Response(null, { status: 204 });
      },
      "GET /servers/mc-survival/files/read?path=%2Fnew.txt": () => textRes(""),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("button", { name: /New file/ }));
    fireEvent.change(await screen.findByPlaceholderText("config.yaml"), { target: { value: "new.txt" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    });
    await waitFor(() => expect(currentPath()).toBe("/new.txt"));
    expect(bodies).toEqual([""]);
  });

  it("explains why a new file name is rejected", async () => {
    mockServerProperties();
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("button", { name: /New file/ }));
    const input = await screen.findByPlaceholderText("config.yaml");
    expect(screen.queryByText(/Names can't contain/)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "../escape.txt" } });
    expect(screen.getByText(/Names can't contain/)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /^Create$/ })).toBeDisabled();
    fireEvent.change(input, { target: { value: "ok.txt" } });
    expect(screen.queryByText(/Names can't contain/)).not.toBeInTheDocument();
  });

  it.each(["invalid/name", ".", "..", ""])("disables Create for the new file name %j", async (fileName) => {
    mockServerProperties();
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("button", { name: /New file/ }));
    fireEvent.change(await screen.findByPlaceholderText("config.yaml"), { target: { value: fileName } });
    expect(screen.getByRole("button", { name: /^Create$/ })).toBeDisabled();
  });

  it("disables Create for a folder name with a slash", async () => {
    mockServerProperties();
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
    fireEvent.change(await screen.findByPlaceholderText("my-folder"), { target: { value: "invalid/path" } });
    expect(screen.getByRole("button", { name: /^Create$/ })).toBeDisabled();
  });

  it("trims whitespace from a new folder name", async () => {
    mockServerProperties({
      "POST /servers/mc-survival/files/mkdir?path=%2Fmy-folder": () => new Response(null, { status: 204 }),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
    fireEvent.change(await screen.findByPlaceholderText("my-folder"), { target: { value: "  my-folder  " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    });
    await waitFor(() => expect(requests()).toContain("POST /servers/mc-survival/files/mkdir?path=%2Fmy-folder"));
  });

  it("closes the name prompt when Cancel is clicked", async () => {
    mockServerProperties();
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("button", { name: /New file/ }));
    await screen.findByPlaceholderText("config.yaml");
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(screen.queryByPlaceholderText("config.yaml")).not.toBeInTheDocument());
  });

  it("uploads a dropped folder into the matching sub-folder", async () => {
    mockServerProperties({
      "POST /servers/mc-survival/files/upload?path=%2Fplugins": () => new Response(null, { status: 204 }),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    const jar = new File(["jar"], "a.jar");
    const fileEntry = { isFile: true, isDirectory: false, name: "a.jar", file: (resolve: (file: File) => void) => resolve(jar) };
    let read = false;
    const folderEntry = {
      isFile: false,
      isDirectory: true,
      name: "plugins",
      createReader: () => ({
        readEntries: (resolve: (entries: unknown[]) => void) => {
          resolve(read ? [] : [fileEntry]);
          read = true;
        },
      }),
    };
    fireEvent.drop(screen.getByTestId("files-dropzone"), { dataTransfer: { files: [], items: [{ webkitGetAsEntry: () => folderEntry }] } });
    await waitFor(() => expect(requests()).toContain("POST /servers/mc-survival/files/upload?path=%2Fplugins"));
  });

  it("shows upload progress while an upload is in flight", async () => {
    const pending = deferredResponse();
    mockServerProperties({
      "POST /servers/mc-survival/files/upload?path=%2F": () => pending.promise,
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.drop(screen.getByTestId("files-dropzone"), { dataTransfer: { files: [new File(["content"], "test.txt")] } });
    expect(await screen.findByText("Uploading…")).toBeInTheDocument();
    await act(async () => pending.resolve(new Response(null, { status: 204 })));
  });

  it("shows the error when upload fails", async () => {
    mockServerProperties({
      "POST /servers/mc-survival/files/upload?path=%2F": () => textRes("disk full", 507),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.drop(screen.getByTestId("files-dropzone"), { dataTransfer: { files: [new File(["content"], "test.txt")] } });
    expect(await screen.findByText("disk full")).toBeInTheDocument();
  });

  it("shows the drop overlay on drag over and uploads dropped files", async () => {
    mockServerProperties({
      "POST /servers/mc-survival/files/upload?path=%2F": () => new Response(null, { status: 204 }),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    const dropzone = screen.getByTestId("files-dropzone");
    fireEvent.dragOver(dropzone);
    expect(screen.getByText("Drop files to upload")).toBeInTheDocument();
    fireEvent.dragLeave(dropzone);
    expect(screen.queryByText("Drop files to upload")).not.toBeInTheDocument();
    fireEvent.dragOver(dropzone);
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(["content"], "dropped.txt")] } });
    await waitFor(() => expect(requests()).toContain("POST /servers/mc-survival/files/upload?path=%2F"));
    expect(screen.queryByText("Drop files to upload")).not.toBeInTheDocument();
  });

  it("downloads a file from its row button", async () => {
    mockServerProperties();
    const restoreLocation = stubLocation();
    try {
      renderWithQuery(<Harness />);
      fireEvent.click(await screen.findByRole("button", { name: "Download server.properties" }));
      await waitFor(() => expect(window.location.href).toBe("/servers/mc-survival/files/download?path=%2Fserver.properties"));
    } finally {
      restoreLocation();
    }
  });

  it("downloads the open file from the editor", async () => {
    mockServerProperties();
    const restoreLocation = stubLocation();
    try {
      renderWithQuery(<Harness initialPath="/server.properties" />);
      await screen.findByTestId("monaco");
      fireEvent.click(screen.getByRole("button", { name: /^Download$/ }));
      await waitFor(() => expect(window.location.href).toBe("/servers/mc-survival/files/download?path=%2Fserver.properties"));
    } finally {
      restoreLocation();
    }
  });

  it("refetches the folder when Refresh is clicked", async () => {
    let listCalls = 0;
    mockServerProperties({
      [ROOT_LIST]: () => {
        listCalls += 1;
        return jsonRes(ROOT_ENTRIES);
      },
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    const before = listCalls;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(listCalls).toBeGreaterThan(before));
  });

  it("shows an empty-folder message", async () => {
    mockServerProperties({ [ROOT_LIST]: () => jsonRes([]) });
    renderWithQuery(<Harness />);
    expect(await screen.findByText("This folder is empty.")).toBeInTheDocument();
  });

  it("scopes requests to the given namespace", async () => {
    mockRoutes({
      "GET /servers/mc-survival/files/list?path=%2F&namespace=custom-ns": () => jsonRes(ROOT_ENTRIES),
    });
    renderWithQuery(<Harness ns="custom-ns" />);
    expect(await screen.findByText("server.properties")).toBeInTheDocument();
    expect(requests()).toContain("GET /servers/mc-survival/files/list?path=%2F&namespace=custom-ns");
  });

  it("shows the read error in the editor area", async () => {
    mockServerProperties({ [PROPERTIES_READ]: () => textRes("read failed", 500) });
    renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByText("server.properties"));
    expect(await screen.findByText("500: read failed")).toBeInTheDocument();
  });

  it("keeps the file when the delete dialog is cancelled", async () => {
    mockServerProperties();
    renderWithQuery(<Harness initialPath="/server.properties" />);
    await screen.findByTestId("monaco");
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(screen.queryByText("Delete server.properties?")).not.toBeInTheDocument());
    expect(requests().some((request) => request.startsWith("DELETE"))).toBe(false);
  });

  it("shows a spinner while the file is loading", async () => {
    const read = deferredResponse();
    mockServerProperties({ [PROPERTIES_READ]: () => read.promise });
    const { container } = renderWithQuery(<Harness />);
    fireEvent.click(await screen.findByText("server.properties"));
    await waitFor(() => expect(requests()).toContain(PROPERTIES_READ));
    expect(container.querySelectorAll(".animate-spin").length).toBeGreaterThan(0);
    await act(async () => read.resolve(textRes("content")));
    expect(await screen.findByTestId("monaco")).toHaveValue("content");
  });

  it("cancels a pending file read when unmounted", async () => {
    mockServerProperties({ [PROPERTIES_READ]: () => new Promise<Response>(() => undefined) });
    const { unmount } = renderWithQuery(<Harness initialPath="/server.properties" />);
    await waitFor(() => expect(requests()).toContain(PROPERTIES_READ));
    expect(() => unmount()).not.toThrow();
  });

  it("warns on unload only while edits are unsaved", async () => {
    mockServerProperties({ [PROPERTIES_WRITE]: recordWrites([]) });
    renderWithQuery(<Harness initialPath="/server.properties" />);
    fireEvent.change(await screen.findByTestId("monaco"), { target: { value: "edited" } });
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument(), { timeout: 3000 });
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
  });

  it("shows a spinner until a folder's total size loads", async () => {
    const size = deferredResponse();
    mockServerProperties({ [CONFIG_SIZE]: () => size.promise });
    renderWithQuery(<Harness />);
    expect(await screen.findByLabelText("Calculating size")).toBeInTheDocument();
    size.resolve(jsonRes({ size: 2048 }));
    expect(await screen.findByText("2.0 KB")).toBeInTheDocument();
    expect(screen.queryByLabelText("Calculating size")).not.toBeInTheDocument();
  });

  it("shows a dash when a folder size cannot be loaded", async () => {
    mockServerProperties({ [CONFIG_SIZE]: () => textRes("timeout", 504) });
    renderWithQuery(<Harness />);
    await screen.findByText("config");
    await waitFor(() => expect(within(row("config")).queryByLabelText("Calculating size")).not.toBeInTheDocument());
    expect(within(row("config")).getAllByText("—")).toHaveLength(2);
  });

  it("selects every entry and downloads them as one zip", async () => {
    mockServerProperties();
    const restoreLocation = stubLocation();
    try {
      renderWithQuery(<Harness />);
      await screen.findByText("server.properties");
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
      expect(within(toolbar()).getByText("2 selected")).toBeInTheDocument();
      fireEvent.click(within(toolbar()).getByRole("button", { name: "Download" }));
      await waitFor(() =>
        expect(window.location.href).toBe("/servers/mc-survival/files/archive?path=%2Fconfig&path=%2Fserver.properties"),
      );
    } finally {
      restoreLocation();
    }
  });

  it("downloads a fully selected sub-folder as that folder's zip", async () => {
    mockServerProperties({
      "GET /servers/mc-survival/files/list?path=%2Fconfig": () =>
        jsonRes([
          { name: "a.yml", path: "/config/a.yml", size: 1, dir: false },
          { name: "b.yml", path: "/config/b.yml", size: 1, dir: false },
        ]),
    });
    const restoreLocation = stubLocation();
    try {
      renderWithQuery(<Harness initialPath="/config" />);
      await screen.findByText("a.yml");
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
      fireEvent.click(within(toolbar()).getByRole("button", { name: "Download" }));
      await waitFor(() => expect(window.location.href).toBe("/servers/mc-survival/files/archive?path=%2Fconfig"));
    } finally {
      restoreLocation();
    }
  });

  it("downloads a single selected file directly", async () => {
    mockServerProperties();
    const restoreLocation = stubLocation();
    try {
      renderWithQuery(<Harness />);
      await screen.findByText("server.properties");
      fireEvent.click(screen.getByRole("checkbox", { name: "Select server.properties" }));
      fireEvent.click(within(toolbar()).getByRole("button", { name: "Download" }));
      await waitFor(() => expect(window.location.href).toBe("/servers/mc-survival/files/download?path=%2Fserver.properties"));
    } finally {
      restoreLocation();
    }
  });

  it("downloads a folder as a zip from its row", async () => {
    mockServerProperties();
    const restoreLocation = stubLocation();
    try {
      renderWithQuery(<Harness />);
      fireEvent.click(await screen.findByRole("button", { name: "Download config" }));
      await waitFor(() => expect(window.location.href).toBe("/servers/mc-survival/files/archive?path=%2Fconfig"));
    } finally {
      restoreLocation();
    }
  });

  it("toggles entries, selects all, and clears the selection", async () => {
    mockServerProperties();
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select config" }));
    expect(within(toolbar()).getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(within(toolbar()).getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select config" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select config" }));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select config" }));
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("names a single-entry zip after the entry", async () => {
    mockServerProperties();
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select config" }));
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Zip" }));
    expect(await screen.findByPlaceholderText("archive.zip")).toHaveValue("config.zip");
  });

  it("zips the selection into the current folder under a free name", async () => {
    const zipRequest = "POST /servers/mc-survival/files/zip?dest=%2Farchive-2.zip&path=%2Fconfig&path=%2Fserver.properties";
    mockServerProperties({
      [ROOT_LIST]: () => jsonRes([...ROOT_ENTRIES, { name: "archive.zip", path: "/archive.zip", size: 10, dir: false }]),
      [zipRequest]: () => new Response(null, { status: 204 }),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("archive.zip");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select config" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select server.properties" }));
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Zip" }));
    expect(await screen.findByPlaceholderText("archive.zip")).toHaveValue("archive-2.zip");
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    await waitFor(() => expect(requests()).toContain(zipRequest));
    await waitFor(() => expect(screen.queryByRole("toolbar")).not.toBeInTheDocument());
  });

  it("shows the error when zipping fails", async () => {
    mockServerProperties({
      "POST /servers/mc-survival/files/zip?dest=%2Fconfig.zip&path=%2Fconfig": () => textRes("disk full", 400),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select config" }));
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Zip" }));
    await screen.findByPlaceholderText("archive.zip");
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    expect(await screen.findByText("disk full")).toBeInTheDocument();
  });

  it("deletes the selection after confirmation", async () => {
    mockServerProperties({
      "DELETE /servers/mc-survival/files/delete?path=%2Fconfig&recursive=true": () => new Response(null, { status: 204 }),
      "DELETE /servers/mc-survival/files/delete?path=%2Fserver.properties": () => new Response(null, { status: 204 }),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete 2 items?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    await waitFor(() =>
      expect(requests()).toEqual(
        expect.arrayContaining([
          "DELETE /servers/mc-survival/files/delete?path=%2Fconfig&recursive=true",
          "DELETE /servers/mc-survival/files/delete?path=%2Fserver.properties",
        ]),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("toolbar")).not.toBeInTheDocument());
  });

  it("keeps the selection and shows the error when deleting it fails", async () => {
    mockServerProperties({
      "DELETE /servers/mc-survival/files/delete?path=%2Fconfig&recursive=true": () => textRes("folder busy", 400),
    });
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select config" }));
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete 1 item?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    expect(await screen.findByText("folder busy")).toBeInTheDocument();
    expect(within(toolbar()).getByText("1 selected")).toBeInTheDocument();
  });

  it("disables zip and delete for a read-only selection", async () => {
    mockServerProperties();
    renderWithQuery(<Harness />, { canControl: false });
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select config" }));
    expect(within(toolbar()).getByRole("button", { name: "Zip" })).toBeDisabled();
    expect(within(toolbar()).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(within(toolbar()).getByRole("button", { name: "Download" })).toBeEnabled();
  });

  it("switches to the tree view and remembers the choice", async () => {
    mockServerProperties();
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    expect(screen.queryByRole("complementary", { name: "Folder tree" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tree" }));
    expect(await screen.findByRole("complementary", { name: "Folder tree" })).toBeInTheDocument();
    expect(window.localStorage.getItem("gameplane.files.view")).toBe("tree");
    expect(screen.getByRole("button", { name: "Tree" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByRole("complementary", { name: "Folder tree" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("gameplane.files.view")).toBe("list");
  });

  it("opens in tree view when the saved choice is tree", async () => {
    window.localStorage.setItem("gameplane.files.view", "tree");
    mockServerProperties();
    renderWithQuery(<Harness />);
    expect(await screen.findByRole("complementary", { name: "Folder tree" })).toBeInTheDocument();
  });

  it("expands a folder in the tree without opening it", async () => {
    window.localStorage.setItem("gameplane.files.view", "tree");
    const onNavigate = vi.fn();
    mockServerProperties({
      "GET /servers/mc-survival/files/list?path=%2Fconfig": () => jsonRes([
        { name: "server-config.yaml", path: "/config/server-config.yaml", size: 512, dir: false },
      ]),
    });
    renderWithQuery(<FilesTab name="mc-survival" path="/" onNavigate={onNavigate} />);
    const folderTree = within(await screen.findByRole("complementary", { name: "Folder tree" }));
    fireEvent.click(await folderTree.findByRole("button", { name: "config" }));
    expect(await folderTree.findByRole("button", { name: "server-config.yaml" })).toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("opens a file picked in the tree", async () => {
    window.localStorage.setItem("gameplane.files.view", "tree");
    const onNavigate = vi.fn();
    mockServerProperties();
    renderWithQuery(<FilesTab name="mc-survival" path="/" onNavigate={onNavigate} />);
    const folderTree = within(await screen.findByRole("complementary", { name: "Folder tree" }));
    fireEvent.click(await folderTree.findByRole("button", { name: "server.properties" }));
    expect(onNavigate).toHaveBeenCalledWith("/server.properties");
  });

  it("opens files picked in the tree as editor tabs and closes them", async () => {
    window.localStorage.setItem("gameplane.files.view", "tree");
    mockRoutes({
      [ROOT_LIST]: () => jsonRes(TWO_FILES),
      [PROPERTIES_READ]: () => textRes("original"),
      "GET /servers/mc-survival/files/read?path=%2Fconfig.yaml": () => textRes("config"),
    });
    renderWithQuery(<Harness initialPath="/server.properties" />);
    await screen.findByTestId("monaco");
    const folderTree = within(await screen.findByRole("complementary", { name: "Folder tree" }));
    fireEvent.click(await folderTree.findByRole("button", { name: "config.yaml" }));
    await screen.findByRole("tablist", { name: "Open files" });
    await waitFor(() => expect(openFiles().getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["server.properties", "config.yaml"]));
    expect(openFiles().getByRole("tab", { name: "config.yaml" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(openFiles().getByRole("tab", { name: "server.properties" }));
    await waitFor(() => expect(currentPath()).toBe("/server.properties"));
    fireEvent.click(openFiles().getByRole("tab", { name: "server.properties" }));
    expect(openFiles().getAllByRole("tab")).toHaveLength(2);

    fireEvent.click(openFiles().getByRole("button", { name: "Close config.yaml" }));
    expect(currentPath()).toBe("/server.properties");
    expect(openFiles().getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["server.properties"]);

    fireEvent.click(openFiles().getByRole("button", { name: "Close server.properties" }));
    await waitFor(() => expect(currentPath()).toBe("/"));
    expect(screen.queryByRole("tablist", { name: "Open files" })).not.toBeInTheDocument();
  });

  it("switches to the next tab when the active one is closed or deleted", async () => {
    window.localStorage.setItem("gameplane.files.view", "tree");
    mockRoutes({
      [ROOT_LIST]: () => jsonRes(TWO_FILES),
      [PROPERTIES_READ]: () => textRes("original"),
      "GET /servers/mc-survival/files/read?path=%2Fconfig.yaml": () => textRes("config"),
      "DELETE /servers/mc-survival/files/delete?path=%2Fconfig.yaml": () => new Response(null, { status: 204 }),
    });
    renderWithQuery(<Harness initialPath="/config.yaml" />);
    await screen.findByTestId("monaco");
    const folderTree = within(await screen.findByRole("complementary", { name: "Folder tree" }));
    fireEvent.click(await folderTree.findByRole("button", { name: "server.properties" }));
    await waitFor(() => expect(currentPath()).toBe("/server.properties"));

    fireEvent.click(await screen.findByRole("button", { name: "Close server.properties" }));
    await waitFor(() => expect(currentPath()).toBe("/config.yaml"));

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(currentPath()).toBe("/"));
  });

  it("shows selection actions in the same toolbar row as the folder buttons", async () => {
    mockServerProperties();
    renderWithQuery(<Harness />);
    await screen.findByText("server.properties");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select config" }));
    expect(toolbar().parentElement).toBe(screen.getByRole("button", { name: /New file/ }).parentElement);
  });
});

function Harness({ name = "mc-survival", ns, initialPath = "/" }: { name?: string; ns?: string; initialPath?: string }) {
  const [path, setPath] = useState(initialPath);
  return (
    <>
      <output data-testid="path">{path}</output>
      <FilesTab name={name} ns={ns} path={path} onNavigate={setPath} />
    </>
  );
}

function renderWithQuery(ui: ReactElement, { canControl = true }: { canControl?: boolean } = {}) {
  const props = ui.props as { name?: string; ns?: string };
  return baseRenderWithQuery(
    <ResourceTargetProvider target={{ cluster: "local", name: props.name ?? "mc-survival", namespace: props.ns }} access={{ canWrite: canControl, canControl, canConsole: canControl, canDelete: canControl, isOwner: true, isCollaborator: false, permissions: ["*"] }}>{ui}</ResourceTargetProvider>,
  );
}
