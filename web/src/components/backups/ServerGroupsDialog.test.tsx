import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeServer } from "@/test/factories";
import { located, targetLabel, type FleetTarget } from "@/lib/fleet";
import { DEFAULT_GROUP, serverGroups, withGroups } from "@/lib/backupGroups";
import type { GameServer } from "@/types";
import { ServerGroupsDialog } from "./ServerGroupsDialog";

vi.mock("./GroupPicker", () => ({
  GroupPicker: ({ known, value, onChange }: { known: string[]; value: string[]; onChange: (groups: string[]) => void }) => (
    <div>
      <p>picked:{value.join(",")}</p>
      {known.map((group) => (
        <button
          key={group}
          type="button"
          onClick={() => onChange(value.includes(group) ? value.filter((item) => item !== group) : [...value, group])}
        >
          {group}
        </button>
      ))}
    </div>
  ),
}));

const target: FleetTarget = { cluster: "local", namespace: "gameplane-games", name: "alpha", uid: "alpha-uid" };
const knownGroups = ["default", "nightly", "weekly"];

function describeRequest(request: Request) {
  const url = new URL(request.url);
  return `${request.method} ${url.pathname} ${url.searchParams.get("namespace")}`;
}

function renderDialog(labels = withGroups({}, ["nightly"])) {
  const onClose = vi.fn();
  const fleetServer = located({ target, resource: makeServer({ metadata: { labels } }), permissions: [] });
  const rendered = renderWithQuery(
    <ServerGroupsDialog server={fleetServer} knownGroups={knownGroups} onClose={onClose} />,
  );
  return { ...rendered, onClose };
}

describe("ServerGroupsDialog", () => {
  let calls: string[];
  let puts: GameServer[];

  beforeEach(() => {
    calls = [];
    puts = [];
  });

  function recordWrites(current: GameServer = makeServer()) {
    server.use(
      http.get("/servers/:name", ({ request }) => {
        calls.push(describeRequest(request));
        return HttpResponse.json(current);
      }),
      http.put("/servers/:name", async ({ request }) => {
        calls.push(describeRequest(request));
        puts.push((await request.json()) as GameServer);
        return HttpResponse.json({});
      }),
    );
  }

  it("shows the title, target and default-group hint", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: "Backup groups · alpha" })).toBeInTheDocument();
    const description = screen.getByText(/backs this server up/);
    expect(description).toHaveTextContent(targetLabel(target));
    expect(description).toHaveTextContent(`belongs to ${DEFAULT_GROUP}.`);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save groups" })).toBeEnabled();
  });

  it("prefills the picker with the server's current groups", () => {
    renderDialog();

    expect(screen.getByText("picked:nightly")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "weekly" })).toBeInTheDocument();
  });

  it("saves the selected groups through GET then PUT and closes", async () => {
    recordWrites();
    const user = userEvent.setup();
    const { client, onClose } = renderDialog();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await user.click(screen.getByRole("button", { name: "weekly" }));
    expect(screen.getByText("picked:nightly,weekly")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save groups" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(["GET /servers/alpha gameplane-games", "PUT /servers/alpha gameplane-games"]);
    expect([...serverGroups(puts[0].metadata.labels)].sort()).toEqual(["nightly", "weekly"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["fleet", "servers"] });
  });

  it("sends only the groups that remain selected", async () => {
    recordWrites(makeServer({ metadata: { labels: withGroups({}, ["nightly"]) } }));
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: "nightly" }));
    await user.click(screen.getByRole("button", { name: "weekly" }));
    expect(screen.getByText("picked:weekly")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save groups" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(serverGroups(puts[0].metadata.labels)).toEqual(["weekly"]);
  });

  it("keeps unrelated labels and the fetched spec when writing", async () => {
    const current = makeServer({ metadata: { labels: { team: "ops", ...withGroups({}, ["nightly"]) } } });
    recordWrites(current);
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: "weekly" }));
    await user.click(screen.getByRole("button", { name: "Save groups" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(puts[0].metadata.labels).toMatchObject({ team: "ops" });
    expect(puts[0].spec).toEqual(current.spec);
    expect([...serverGroups(puts[0].metadata.labels)].sort()).toEqual(["nightly", "weekly"]);
  });

  it("locks the controls and shows Saving while the write is in flight", async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = () => resolve();
    });
    server.use(
      http.put("/servers/:name", async () => {
        await saveGate;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Save groups" }));

    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    releaseSave();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("shows the API error and keeps the dialog open when the write is rejected", async () => {
    server.use(
      http.put("/servers/:name", () => HttpResponse.text("rejected", { status: 422 })),
    );
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Save groups" }));

    expect(await screen.findByText("rejected")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save groups" })).toBeEnabled();
  });

  it("shows the error and skips the write when the server cannot be read", async () => {
    server.use(
      http.get("/servers/:name", ({ request }) => {
        calls.push(describeRequest(request));
        return HttpResponse.text("lookup failed", { status: 422 });
      }),
      http.put("/servers/:name", ({ request }) => {
        calls.push(describeRequest(request));
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Save groups" }));

    expect(await screen.findByText("lookup failed")).toBeInTheDocument();
    expect(calls).toEqual(["GET /servers/alpha gameplane-games"]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Cancel without reading or writing the server", async () => {
    recordWrites();
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("closes when the dialog is dismissed with Escape", async () => {
    recordWrites();
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([]);
  });
});
