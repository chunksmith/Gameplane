import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeSchedule, makeServer } from "@/test/factories";
import { located, type FleetTarget } from "@/lib/fleet";
import { DEFAULT_GROUP, describeCron } from "@/lib/backupGroups";
import { BackupGroupsPanel, groupMembers } from "@/components/backups/BackupGroupsPanel";
import type { BackupSchedule } from "@/types";

const NAMESPACE = "gameplane-games";
const WRITE = ["schedules:write", "servers:write"];
const READ = ["schedules:read", "servers:read"];

const target = (name: string, namespace = NAMESPACE): FleetTarget => ({ cluster: "local", namespace, name, uid: `${name}-uid` });

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const hoursAgo = (hours: number) => hoursFromNow(-hours);

const groupSpec = (over: Partial<BackupSchedule["spec"]> = {}): BackupSchedule["spec"] => ({
  groups: [DEFAULT_GROUP],
  schedule: "0 3 * * *",
  retention: { keepLast: 7 },
  concurrency: 1,
  ...over,
});

function fleetServer(name: string, permissions = WRITE, namespace = NAMESPACE) {
  return located({ target: target(name, namespace), resource: makeServer({ metadata: { name, namespace } }), permissions });
}

function fleetSchedule(name: string, spec: BackupSchedule["spec"], status?: BackupSchedule["status"], permissions = WRITE) {
  return located({ target: target(name), resource: makeSchedule({ metadata: { name, namespace: NAMESPACE }, spec, status }), permissions });
}

function renderPanel(schedules: ReturnType<typeof fleetSchedule>[], servers: ReturnType<typeof fleetServer>[]) {
  return renderWithQuery(<BackupGroupsPanel schedules={schedules} servers={servers} />);
}

function sectionOf(heading: string) {
  const section = screen.getByRole("heading", { name: heading }).closest("section");
  if (!section) throw new Error(`section not found: ${heading}`);
  return section;
}

function rowOf(container: HTMLElement, text: string) {
  const row = within(container).getByText(text).closest('[role="row"]');
  if (!(row instanceof HTMLElement)) throw new Error(`row not found: ${text}`);
  return row;
}

describe("groupMembers", () => {
  it("returns only servers in the schedule scope whose groups match", () => {
    const schedule = fleetSchedule("nightly", groupSpec());
    const otherCluster = { ...fleetServer("charlie"), fleetTarget: { ...target("charlie"), cluster: "remote" } };
    const members = groupMembers(schedule, [fleetServer("alpha"), fleetServer("bravo", WRITE, "other"), otherCluster]);
    expect(members.map((server) => server.metadata.name)).toEqual(["alpha"]);
  });

  it("returns no members for a schedule without groups", () => {
    expect(groupMembers(fleetSchedule("plain", { schedule: "0 3 * * *" }), [fleetServer("alpha")])).toEqual([]);
  });
});

describe("BackupGroupsPanel", () => {
  it("shows the empty state when no schedule has groups", () => {
    renderPanel([fleetSchedule("plain", { schedule: "0 3 * * *" }), fleetSchedule("empty", groupSpec({ groups: [] }))], [fleetServer("alpha")]);
    expect(screen.getByText("No group schedules yet")).toBeInTheDocument();
    expect(screen.getByText(DEFAULT_GROUP)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText("Not backed up by any group")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New group schedule" })).toBeEnabled();
  });

  it("hides schedules without groups from the group cards", () => {
    renderPanel([fleetSchedule("plain", { schedule: "0 3 * * *" }), fleetSchedule("nightly", groupSpec())], [fleetServer("alpha")]);
    expect(within(sectionOf("Group schedules")).getAllByRole("switch")).toHaveLength(1);
    expect(screen.queryByText("plain")).not.toBeInTheDocument();
  });

  it("disables new group schedule without schedules:write on any server", () => {
    renderPanel([], [fleetServer("alpha", ["servers:write"])]);
    expect(screen.getByRole("button", { name: "New group schedule" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Groups" })).toBeEnabled();
  });

  it("disables Groups without servers:write", () => {
    renderPanel([], [fleetServer("alpha", ["schedules:write"])]);
    expect(screen.getByRole("button", { name: "Groups" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New group schedule" })).toBeEnabled();
  });

  it("shows the empty membership table", () => {
    renderPanel([], []);
    expect(screen.getByText("No servers.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New group schedule" })).toBeDisabled();
  });

  it("renders schedule card details", () => {
    renderPanel(
      [fleetSchedule("nightly", groupSpec({ groups: [DEFAULT_GROUP, "lobby"] }), { nextScheduleTime: hoursFromNow(3), lastSuccessfulTime: hoursAgo(2) })],
      [fleetServer("alpha"), fleetServer("bravo")],
    );
    const groups = sectionOf("Group schedules");
    expect(within(groups).getByText("nightly")).toBeInTheDocument();
    expect(within(groups).getByText(DEFAULT_GROUP)).toBeInTheDocument();
    expect(within(groups).getByText("lobby")).toBeInTheDocument();
    expect(within(groups).getByText(describeCron("0 3 * * *"))).toBeInTheDocument();
    expect(within(groups).getByText(/^Next in \d+h/)).toBeInTheDocument();
    expect(within(groups).getByText(/last ok .*ago/)).toBeInTheDocument();
    expect(within(groups).getByText("Retain").nextElementSibling).toHaveTextContent(/^7$/);
    expect(within(groups).getByText("Parallel").nextElementSibling).toHaveTextContent(/^1$/);
    expect(within(groups).getByText("Servers").nextElementSibling).toHaveTextContent(/^2$/);
    expect(within(groups).getByText("alpha")).toBeInTheDocument();
    expect(within(groups).getByText("bravo")).toBeInTheDocument();
    expect(within(groups).queryByText(/^\+\d+$/)).not.toBeInTheDocument();
    expect(within(groups).getByRole("switch")).toBeChecked();
  });

  it("shows unlimited retention and parallelism without status", () => {
    renderPanel([fleetSchedule("nightly", groupSpec({ retention: undefined, concurrency: undefined }))], [fleetServer("alpha")]);
    const groups = sectionOf("Group schedules");
    expect(within(groups).getByText("Retain").nextElementSibling).toHaveTextContent(/^all$/);
    expect(within(groups).getByText("Parallel").nextElementSibling).toHaveTextContent(/^∞$/);
    expect(within(groups).getByText(/^Next/)).toBeInTheDocument();
    expect(within(groups).queryByText(/last ok/)).not.toBeInTheDocument();
  });

  it("shows the overflow count beyond six members", () => {
    const servers = Array.from({ length: 8 }, (_value, index) => fleetServer(`server-${index + 1}`));
    renderPanel([fleetSchedule("nightly", groupSpec())], servers);
    const groups = sectionOf("Group schedules");
    expect(within(groups).getByText("server-6")).toBeInTheDocument();
    expect(within(groups).queryByText("server-7")).not.toBeInTheDocument();
    expect(within(groups).getByText("+2")).toBeInTheDocument();
    expect(within(groups).getByText("Servers").nextElementSibling).toHaveTextContent(/^8$/);
  });

  it("marks suspended schedules as paused", () => {
    renderPanel([fleetSchedule("nightly", groupSpec({ suspend: true }), { lastSuccessfulTime: hoursAgo(5) })], [fleetServer("alpha")]);
    const groups = sectionOf("Group schedules");
    expect(within(groups).getByRole("switch")).not.toBeChecked();
    expect(within(groups).getByText(/^Paused/)).toBeInTheDocument();
    expect(within(groups).queryByText(/^Next/)).not.toBeInTheDocument();
    expect(within(groups).getByText("nightly").closest(".opacity-60")).not.toBeNull();
  });

  it("disables card controls without schedules:write", () => {
    renderPanel([fleetSchedule("nightly", groupSpec(), undefined, READ)], [fleetServer("alpha")]);
    const groups = sectionOf("Group schedules");
    expect(within(groups).getByRole("switch")).toBeDisabled();
    expect(within(groups).getByRole("button", { name: "Edit schedule" })).toBeDisabled();
    expect(within(groups).getByRole("button", { name: "Delete schedule" })).toBeDisabled();
  });

  it("treats the wildcard permission as write access", () => {
    renderPanel([fleetSchedule("nightly", groupSpec(), undefined, ["*"])], [fleetServer("alpha", ["*"])]);
    const groups = sectionOf("Group schedules");
    expect(within(groups).getByRole("switch")).toBeEnabled();
    expect(within(groups).getByRole("button", { name: "Edit schedule" })).toBeEnabled();
    expect(within(groups).getByRole("button", { name: "Delete schedule" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Groups" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "New group schedule" })).toBeEnabled();
  });

  it("lists membership with implicit groups and covering schedules", () => {
    renderPanel(
      [fleetSchedule("nightly", groupSpec()), fleetSchedule("hourly", groupSpec({ schedule: "0 * * * *" }))],
      [fleetServer("alpha"), fleetServer("bravo", WRITE, "other")],
    );
    const membership = sectionOf("Server membership");
    expect(within(membership).getByText("Covered by")).toBeInTheDocument();
    const alphaRow = rowOf(membership, "alpha");
    expect(within(alphaRow).getByText(/implicit/)).toBeInTheDocument();
    expect(within(alphaRow).getByText("nightly, hourly")).toBeInTheDocument();
    expect(within(rowOf(membership, "bravo")).getByText("Not backed up by any group")).toBeInTheDocument();
  });

  it("opens the server groups dialog from a membership row", async () => {
    const user = userEvent.setup();
    renderPanel([], [fleetServer("alpha")]);
    await user.click(screen.getByRole("button", { name: "Groups" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens the group schedule dialog for new and existing schedules", async () => {
    const user = userEvent.setup();
    renderPanel([fleetSchedule("nightly", groupSpec())], [fleetServer("alpha")]);
    await user.click(screen.getByRole("button", { name: "New group schedule" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Edit schedule" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("suspends an active schedule with a PUT of the merged spec", async () => {
    const user = userEvent.setup();
    const nightly = makeSchedule({ metadata: { name: "nightly", namespace: NAMESPACE }, spec: groupSpec() });
    const bodies: unknown[] = [];
    server.use(
      http.get("/schedules/:name", () => HttpResponse.json(nightly)),
      http.put("/schedules/:name", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({});
      }),
    );
    renderPanel([located({ target: target("nightly"), resource: nightly, permissions: WRITE })], [fleetServer("alpha")]);
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ metadata: { name: "nightly" }, spec: { suspend: true, groups: [DEFAULT_GROUP] } });
  });

  it("keeps the switch disabled while the suspend request is pending", async () => {
    const user = userEvent.setup();
    const nightly = makeSchedule({ metadata: { name: "nightly", namespace: NAMESPACE }, spec: groupSpec() });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    server.use(
      http.get("/schedules/:name", () => HttpResponse.json(nightly)),
      http.put("/schedules/:name", async () => {
        await gate;
        return HttpResponse.json({});
      }),
    );
    renderPanel([located({ target: target("nightly"), resource: nightly, permissions: WRITE })], [fleetServer("alpha")]);
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch")).toBeDisabled());
    release();
    await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
  });

  it("shows the toggle error banner", async () => {
    const user = userEvent.setup();
    const nightly = makeSchedule({ metadata: { name: "nightly", namespace: NAMESPACE }, spec: groupSpec() });
    server.use(
      http.get("/schedules/:name", () => HttpResponse.json(nightly)),
      http.put("/schedules/:name", () => HttpResponse.text("rejected", { status: 422 })),
    );
    renderPanel([located({ target: target("nightly"), resource: nightly, permissions: WRITE })], [fleetServer("alpha")]);
    await user.click(screen.getByRole("switch"));
    expect(await screen.findByText("rejected")).toBeInTheDocument();
  });

  it("deletes a schedule after typing its name to confirm", async () => {
    const user = userEvent.setup();
    const urls: URL[] = [];
    server.use(
      http.delete("/schedules/:name", ({ request }) => {
        urls.push(new URL(request.url));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel([fleetSchedule("nightly", groupSpec())], [fleetServer("alpha")]);
    await user.click(screen.getByRole("button", { name: "Delete schedule" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete group schedule?")).toBeInTheDocument();
    expect(within(dialog).getByText(/Existing backups stay/)).toBeInTheDocument();
    await user.type(within(dialog).getByPlaceholderText("Type to confirm"), "nightly");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(urls.map((url) => url.pathname)).toEqual(["/schedules/nightly"]);
    expect(urls.map((url) => url.searchParams.get("namespace"))).toEqual([NAMESPACE]);
  });

  it("keeps the schedule when deletion is cancelled", async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    server.use(
      http.delete("/schedules/:name", () => {
        requests.push("delete");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel([fleetSchedule("nightly", groupSpec())], [fleetServer("alpha")]);
    await user.click(screen.getByRole("button", { name: "Delete schedule" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(requests).toEqual([]);
  });

  it("shows the delete error and keeps the dialog open", async () => {
    const user = userEvent.setup();
    server.use(http.delete("/schedules/:name", () => HttpResponse.text("rejected", { status: 422 })));
    renderPanel([fleetSchedule("nightly", groupSpec())], [fleetServer("alpha")]);
    await user.click(screen.getByRole("button", { name: "Delete schedule" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByPlaceholderText("Type to confirm"), "nightly");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("rejected")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
