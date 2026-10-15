import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeDestination, makeSchedule } from "@/test/factories";
import { located, targetLabel, type Located } from "@/lib/fleet";
import { describeCron, presetCron } from "@/lib/backupGroups";
import { GroupScheduleDialog, type Scope } from "@/components/backups/GroupScheduleDialog";
import type { BackupSchedule } from "@/types";

const gamesScope: Scope = { cluster: "local", namespace: "gameplane-games" };
const stagingScope: Scope = { cluster: "edge", namespace: "gameplane-staging" };
const dailyCron = presetCron({ every: 24, time: "04:00" });
const quiesceLabel = "Flush and pause world saves during the backup";

const existingSchedule = (spec: Partial<BackupSchedule["spec"]> = {}) =>
  located({
    target: { cluster: "local", namespace: "gameplane-games", name: "nightly", uid: "uid-nightly" },
    resource: makeSchedule({
      metadata: { name: "nightly", namespace: "gameplane-games" },
      spec: {
        groups: ["default"],
        schedule: dailyCron,
        retention: { keepLast: 7 },
        concurrency: 1,
        quiesce: true,
        repoRef: { name: "default", key: "repo" },
        ...spec,
      },
    }),
    permissions: ["*"],
  });

const renderDialog = (schedule?: Located<BackupSchedule>, scopes: Scope[] = [gamesScope]) => {
  const onClose = vi.fn();
  const rendered = renderWithQuery(
    <GroupScheduleDialog schedule={schedule} scopes={scopes} knownGroups={["default", "lobby"]} onClose={onClose} />,
  );
  return { ...rendered, onClose };
};

const createButton = () => screen.getByRole("button", { name: "Create schedule" });
const saveButton = () => screen.getByRole("button", { name: "Save changes" });
const nameInput = () => screen.getByLabelText("Name");

const waitForDestination = (name: string) =>
  waitFor(() => {
    expect(screen.getByLabelText("Destination")).toHaveTextContent(name);
  });

const destinationsHandler = (...names: string[]) =>
  http.get("/backup-destinations", () => HttpResponse.json({ items: names.map((name) => makeDestination({ name })) }));

const captureWrite = () => {
  const write: { namespace: string | null; body: unknown } = { namespace: null, body: null };
  const handle = async (request: Request) => {
    write.namespace = new URL(request.url).searchParams.get("namespace");
    write.body = await request.json();
    return HttpResponse.json({});
  };
  return { write, handle };
};

describe("GroupScheduleDialog", () => {
  describe("new schedule", () => {
    it("renders the create form with defaults", async () => {
      renderDialog();
      await waitForDestination("default");
      expect(screen.getByRole("heading", { name: "New backup group schedule" })).toBeInTheDocument();
      expect(nameInput()).toHaveValue("");
      expect(nameInput()).toHaveAttribute("placeholder", "nightly");
      expect(screen.queryByLabelText("Location")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Frequency")).toHaveTextContent("Every day");
      expect(screen.getByLabelText("Starting at (local time)")).toHaveValue("04:00");
      expect(screen.getByText(dailyCron, { selector: "span" }).parentElement).toHaveTextContent(describeCron(dailyCron));
      expect(screen.getByLabelText("Retain (per server)")).toHaveValue(7);
      expect(screen.getByLabelText("Concurrency")).toHaveValue(1);
      expect(screen.getByRole("checkbox", { name: quiesceLabel })).toBeChecked();
      expect(createButton()).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    });

    it("explains how servers join a group", () => {
      renderDialog();
      expect(screen.getByText(/Backs up every server in the selected groups/)).toBeInTheDocument();
      expect(screen.getByText("backup-group.gameplane.local/<group>")).toBeInTheDocument();
    });

    it("lowercases the name and enables create only for a valid name", async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForDestination("default");
      await user.type(nameInput(), "Bad Name!");
      expect(nameInput()).toHaveValue("bad name!");
      expect(createButton()).toBeDisabled();
      await user.clear(nameInput());
      await user.type(nameInput(), "nightly");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
    });

    it("creates a daily schedule in the scope namespace", async () => {
      const user = userEvent.setup();
      const { write, handle } = captureWrite();
      server.use(http.post("/schedules", ({ request }) => handle(request)));
      const { client, onClose } = renderDialog();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await waitForDestination("default");
      await user.type(nameInput(), "nightly");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
      await user.click(createButton());
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(write.namespace).toBe("gameplane-games");
      expect(write.body).toMatchObject({
        metadata: { name: "nightly" },
        spec: {
          groups: ["default"],
          concurrency: 1,
          quiesce: true,
          schedule: dailyCron,
          repoRef: { name: "default", key: "repo" },
          retention: { keepLast: 7 },
        },
      });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["fleet", "schedules"] });
    });

    it("posts the destination the user picks", async () => {
      const user = userEvent.setup();
      const { write, handle } = captureWrite();
      server.use(destinationsHandler("alpha-store", "beta-store"), http.post("/schedules", ({ request }) => handle(request)));
      const { onClose } = renderDialog();
      await waitForDestination("alpha-store");
      await user.click(screen.getByLabelText("Destination"));
      await user.click(await screen.findByRole("option", { name: "beta-store" }));
      await waitForDestination("beta-store");
      await user.type(nameInput(), "nightly");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
      await user.click(createButton());
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(write.body).toMatchObject({ spec: { repoRef: { name: "beta-store", key: "repo" } } });
    });

    it("keeps create disabled when no destination exists", async () => {
      const user = userEvent.setup();
      const listed = vi.fn();
      server.use(
        http.get("/backup-destinations", () => {
          listed();
          return HttpResponse.json({ items: [] });
        }),
      );
      renderDialog();
      await user.type(nameInput(), "nightly");
      await waitFor(() => {
        expect(listed).toHaveBeenCalled();
      });
      expect(createButton()).toBeDisabled();
    });

    it("keeps create disabled without a scope", async () => {
      const user = userEvent.setup();
      renderDialog(undefined, []);
      await waitForDestination("default");
      await user.type(nameInput(), "nightly");
      expect(createButton()).toBeDisabled();
    });

    it("posts edited retention, concurrency and quiesce values", async () => {
      const user = userEvent.setup();
      const { write, handle } = captureWrite();
      server.use(http.post("/schedules", ({ request }) => handle(request)));
      const { onClose } = renderDialog();
      await waitForDestination("default");
      const retain = screen.getByLabelText("Retain (per server)");
      await user.clear(retain);
      await user.type(retain, "14");
      const concurrency = screen.getByLabelText("Concurrency");
      await user.clear(concurrency);
      await user.type(concurrency, "3");
      await user.click(screen.getByRole("checkbox", { name: quiesceLabel }));
      await user.type(nameInput(), "nightly");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
      await user.click(createButton());
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(write.body).toMatchObject({ spec: { retention: { keepLast: 14 }, concurrency: 3, quiesce: false } });
    });

    it("disables create for zero retention or concurrency", async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForDestination("default");
      await user.type(nameInput(), "nightly");
      const retain = screen.getByLabelText("Retain (per server)");
      await user.clear(retain);
      expect(createButton()).toBeDisabled();
      await user.type(retain, "2");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
      const concurrency = screen.getByLabelText("Concurrency");
      await user.clear(concurrency);
      expect(createButton()).toBeDisabled();
    });

    it("posts a changed start time for the daily frequency", async () => {
      const user = userEvent.setup();
      const { write, handle } = captureWrite();
      server.use(http.post("/schedules", ({ request }) => handle(request)));
      const { onClose } = renderDialog();
      await waitForDestination("default");
      fireEvent.change(screen.getByLabelText("Starting at (local time)"), { target: { value: "06:30" } });
      expect(screen.getByLabelText("Starting at (local time)")).toHaveValue("06:30");
      await user.type(nameInput(), "nightly");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
      await user.click(createButton());
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(write.body).toMatchObject({ spec: { schedule: presetCron({ every: 24, time: "06:30" }) } });
    });

    it("switches to hourly, shows the minute field and posts the hourly expression", async () => {
      const user = userEvent.setup();
      const { write, handle } = captureWrite();
      server.use(http.post("/schedules", ({ request }) => handle(request)));
      const { onClose } = renderDialog();
      await waitForDestination("default");
      await user.click(screen.getByLabelText("Frequency"));
      await user.click(await screen.findByRole("option", { name: "Every hour" }));
      expect(screen.getByLabelText("Minute (local)")).toBeInTheDocument();
      const hourly = presetCron({ every: 1, time: "04:00" });
      expect(screen.getByText(hourly, { selector: "span" }).parentElement).toHaveTextContent(describeCron(hourly));
      await user.type(nameInput(), "hourly");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
      await user.click(createButton());
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(write.body).toMatchObject({ spec: { schedule: hourly } });
    });

    it("posts a trimmed custom cron expression", async () => {
      const user = userEvent.setup();
      const { write, handle } = captureWrite();
      server.use(http.post("/schedules", ({ request }) => handle(request)));
      const { onClose } = renderDialog();
      await waitForDestination("default");
      await user.click(screen.getByLabelText("Frequency"));
      await user.click(await screen.findByRole("option", { name: "Custom cron (UTC)" }));
      const cron = screen.getByLabelText("Cron (UTC)");
      expect(cron).toHaveValue("0 1 * * *");
      expect(screen.queryByLabelText("Starting at (local time)")).not.toBeInTheDocument();
      await user.clear(cron);
      await user.type(cron, "  15 2 * * 1  ");
      expect(screen.getByText("15 2 * * 1", { selector: "span" }).parentElement).toHaveTextContent(
        describeCron("15 2 * * 1"),
      );
      await user.type(nameInput(), "weekly");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
      await user.click(createButton());
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(write.body).toMatchObject({ spec: { schedule: "15 2 * * 1" } });
    });

    it("keeps create disabled for a malformed custom cron", async () => {
      const user = userEvent.setup();
      renderDialog();
      await waitForDestination("default");
      await user.click(screen.getByLabelText("Frequency"));
      await user.click(await screen.findByRole("option", { name: "Custom cron (UTC)" }));
      const cron = screen.getByLabelText("Cron (UTC)");
      await user.clear(cron);
      await user.type(cron, "every day");
      await user.type(nameInput(), "weekly");
      expect(createButton()).toBeDisabled();
      await user.clear(cron);
      await user.type(cron, "15 2 * * 1");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
    });

    it("lists every frequency with readable labels", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByLabelText("Frequency"));
      const options = await screen.findAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual([
        "Every day",
        "Every 12 hours",
        "Every 8 hours",
        "Every 6 hours",
        "Every 4 hours",
        "Every 2 hours",
        "Every hour",
        "Custom cron (UTC)",
      ]);
    });

    it("creates the schedule in the selected location", async () => {
      const user = userEvent.setup();
      const { write, handle } = captureWrite();
      server.use(http.post("/schedules", ({ request }) => handle(request)));
      const { onClose } = renderDialog(undefined, [gamesScope, stagingScope]);
      const locationTrigger = screen.getByLabelText("Location");
      expect(locationTrigger).toHaveTextContent(targetLabel(gamesScope));
      await user.click(locationTrigger);
      await user.click(await screen.findByRole("option", { name: targetLabel(stagingScope) }));
      await waitFor(() => {
        expect(locationTrigger).toHaveTextContent(targetLabel(stagingScope));
      });
      await waitForDestination("default");
      await user.type(nameInput(), "nightly");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
      await user.click(createButton());
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(write.namespace).toBe("gameplane-staging");
    });

    it("closes without posting when cancel is pressed", async () => {
      const user = userEvent.setup();
      const posted = vi.fn();
      server.use(
        http.post("/schedules", () => {
          posted();
          return HttpResponse.json({});
        }),
      );
      const { onClose } = renderDialog();
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(posted).not.toHaveBeenCalled();
    });

    it("closes when escape is pressed", async () => {
      const user = userEvent.setup();
      const { onClose } = renderDialog();
      await user.keyboard("{Escape}");
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    it("shows the API error and stays open when create fails", async () => {
      const user = userEvent.setup();
      server.use(http.post("/schedules", () => HttpResponse.text("rejected", { status: 422 })));
      const { onClose } = renderDialog();
      await waitForDestination("default");
      await user.type(nameInput(), "nightly");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
      await user.click(createButton());
      expect(await screen.findByText("rejected")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(createButton()).toBeEnabled();
    });

    it("disables actions while the create request is pending", async () => {
      const user = userEvent.setup();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = () => {
          resolve();
        };
      });
      server.use(
        http.post("/schedules", async () => {
          await gate;
          return HttpResponse.json({});
        }),
      );
      const { onClose } = renderDialog();
      await waitForDestination("default");
      await user.type(nameInput(), "nightly");
      await waitFor(() => {
        expect(createButton()).toBeEnabled();
      });
      await user.click(createButton());
      expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      release();
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("edit schedule", () => {
    it("prefills the form from the existing schedule", async () => {
      renderDialog(existingSchedule({ groups: ["lobby"], concurrency: 3, quiesce: false, retention: { keepLast: 14 } }));
      await waitForDestination("default");
      expect(screen.getByRole("heading", { name: "Edit nightly" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Location")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Frequency")).toHaveTextContent("Every day");
      expect(screen.getByLabelText("Starting at (local time)")).toHaveValue("04:00");
      expect(screen.getByLabelText("Retain (per server)")).toHaveValue(14);
      expect(screen.getByLabelText("Concurrency")).toHaveValue(3);
      expect(screen.getByRole("checkbox", { name: quiesceLabel })).not.toBeChecked();
      expect(saveButton()).toBeEnabled();
    });

    it("saves edits with a PUT of the merged spec in the schedule namespace", async () => {
      const user = userEvent.setup();
      const { write, handle } = captureWrite();
      const storedSchedule = makeSchedule({
        metadata: { name: "nightly", namespace: "gameplane-games" },
        spec: { ...makeSchedule().spec, suspend: true },
      });
      server.use(
        http.get("/schedules/:name", () => HttpResponse.json(storedSchedule)),
        http.put("/schedules/:name", ({ request }) => handle(request)),
      );
      const { onClose } = renderDialog(existingSchedule());
      await waitForDestination("default");
      const retain = screen.getByLabelText("Retain (per server)");
      await user.clear(retain);
      await user.type(retain, "14");
      await user.click(screen.getByRole("checkbox", { name: quiesceLabel }));
      await user.click(saveButton());
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(write.namespace).toBe("gameplane-games");
      expect(write.body).toMatchObject({
        metadata: { name: "nightly" },
        spec: {
          groups: ["default"],
          schedule: dailyCron,
          concurrency: 1,
          quiesce: false,
          retention: { keepLast: 14 },
          repoRef: { name: "default", key: "repo" },
          suspend: true,
        },
      });
    });

    it("keeps the stored destination instead of the first one", async () => {
      const user = userEvent.setup();
      const { write, handle } = captureWrite();
      server.use(destinationsHandler("alpha-store", "beta-store"), http.put("/schedules/:name", ({ request }) => handle(request)));
      const { onClose } = renderDialog(existingSchedule({ repoRef: { name: "beta-store", key: "repo" } }));
      await waitForDestination("beta-store");
      await user.click(saveButton());
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(write.body).toMatchObject({ spec: { repoRef: { name: "beta-store", key: "repo" } } });
    });

    it("auto-selects the first destination when the schedule has no repository", async () => {
      const user = userEvent.setup();
      const { write, handle } = captureWrite();
      server.use(destinationsHandler("alpha-store", "beta-store"), http.put("/schedules/:name", ({ request }) => handle(request)));
      const { onClose } = renderDialog(existingSchedule({ repoRef: undefined }));
      await waitForDestination("alpha-store");
      await user.click(saveButton());
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(write.body).toMatchObject({ spec: { repoRef: { name: "alpha-store", key: "repo" } } });
    });

    it("keeps a custom cron expression and saves it unchanged", async () => {
      const user = userEvent.setup();
      const { write, handle } = captureWrite();
      server.use(http.put("/schedules/:name", ({ request }) => handle(request)));
      const { onClose } = renderDialog(existingSchedule({ schedule: "30 6 * * 1" }));
      await waitForDestination("default");
      expect(screen.getByLabelText("Frequency")).toHaveTextContent("Custom cron (UTC)");
      expect(screen.getByLabelText("Cron (UTC)")).toHaveValue("30 6 * * 1");
      await user.click(saveButton());
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(write.body).toMatchObject({ spec: { schedule: "30 6 * * 1" } });
    });

    it("disables save when no group is selected", async () => {
      renderDialog(existingSchedule({ groups: [] }));
      await waitForDestination("default");
      expect(saveButton()).toBeDisabled();
    });

    it("shows the API error and stays open when save fails", async () => {
      const user = userEvent.setup();
      server.use(http.put("/schedules/:name", () => HttpResponse.text("rejected", { status: 422 })));
      const { onClose } = renderDialog(existingSchedule());
      await waitForDestination("default");
      await user.click(saveButton());
      expect(await screen.findByText("rejected")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
