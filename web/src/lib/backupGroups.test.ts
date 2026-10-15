import { describe, it, expect } from "vitest";
import {
  DEFAULT_GROUP,
  FREQUENCIES,
  GROUP_LABEL_PREFIX,
  GROUP_NAME,
  SCHEDULE_LABEL,
  cronPreset,
  describeCron,
  effectiveGroups,
  formatDuration,
  inGroups,
  presetCron,
  runTimes,
  serverGroups,
  withGroups,
} from "@/lib/backupGroups";

const groupLabel = (group: string) => GROUP_LABEL_PREFIX + group;

const localClock = (utcHour: number, utcMinute: number) => {
  const date = new Date();
  date.setUTCHours(utcHour, utcMinute, 0, 0);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const roundTrip = (cron: string) => {
  const preset = cronPreset(cron);
  return preset ? presetCron(preset) : null;
};

describe("constants", () => {
  it("exposes label keys, default group and frequencies", () => {
    expect(GROUP_LABEL_PREFIX).toBe("backup-group.gameplane.local/");
    expect(SCHEDULE_LABEL).toBe("gameplane.local/backup-schedule");
    expect(DEFAULT_GROUP).toBe("default");
    expect(FREQUENCIES).toEqual([24, 12, 8, 6, 4, 2, 1]);
  });
});

describe("GROUP_NAME", () => {
  it.each(["a", "default", "game-1", "a".repeat(63)])("accepts %s", (name) => {
    expect(GROUP_NAME.test(name)).toBe(true);
  });

  it.each(["", "-a", "a-", "Alpha", "my_group", "a b", "a".repeat(64)])("rejects %s", (name) => {
    expect(GROUP_NAME.test(name)).toBe(false);
  });
});

describe("serverGroups", () => {
  it("returns an empty list without labels", () => {
    expect(serverGroups()).toEqual([]);
    expect(serverGroups({})).toEqual([]);
  });

  it("returns enabled group names without the prefix, sorted", () => {
    expect(
      serverGroups({ [groupLabel("zeta")]: "enabled", [groupLabel("alpha")]: "enabled", [SCHEDULE_LABEL]: "true" }),
    ).toEqual(["alpha", "zeta"]);
  });

  it("skips disabled groups and labels outside the prefix", () => {
    expect(serverGroups({ [groupLabel("off")]: "disabled", app: "enabled" })).toEqual([]);
  });
});

describe("effectiveGroups", () => {
  it("falls back to the default group when no group is enabled", () => {
    expect(effectiveGroups()).toEqual([DEFAULT_GROUP]);
    expect(effectiveGroups({ [groupLabel("off")]: "disabled" })).toEqual([DEFAULT_GROUP]);
  });

  it("returns the enabled groups when present", () => {
    expect(effectiveGroups({ [groupLabel("beta")]: "enabled", [groupLabel("alpha")]: "enabled" })).toEqual([
      "alpha",
      "beta",
    ]);
  });
});

describe("inGroups", () => {
  it("matches the default group for servers without group labels", () => {
    expect(inGroups(undefined, [DEFAULT_GROUP])).toBe(true);
    expect(inGroups({}, ["alpha"])).toBe(false);
  });

  it("matches when any effective group is requested", () => {
    const labels = { [groupLabel("alpha")]: "enabled" };
    expect(inGroups(labels, ["beta", "alpha"])).toBe(true);
    expect(inGroups(labels, ["beta"])).toBe(false);
  });

  it("never matches an empty group list", () => {
    expect(inGroups(undefined, [])).toBe(false);
  });
});

describe("withGroups", () => {
  it("adds enabled group labels to unlabeled servers", () => {
    expect(withGroups(undefined, ["alpha", "beta"])).toEqual({
      [groupLabel("alpha")]: "enabled",
      [groupLabel("beta")]: "enabled",
    });
  });

  it("replaces existing group labels and keeps other labels", () => {
    const labels = { app: "web", [groupLabel("old")]: "enabled", [groupLabel("alpha")]: "disabled" };
    expect(withGroups(labels, ["alpha"])).toEqual({ app: "web", [groupLabel("alpha")]: "enabled" });
  });

  it("removes all group labels when given no groups", () => {
    expect(withGroups({ [SCHEDULE_LABEL]: "true", [groupLabel("old")]: "enabled" }, [])).toEqual({
      [SCHEDULE_LABEL]: "true",
    });
  });

  it("does not mutate the input labels", () => {
    const labels = { [groupLabel("old")]: "enabled" };
    withGroups(labels, ["alpha"]);
    expect(labels).toEqual({ [groupLabel("old")]: "enabled" });
  });
});

describe("presetCron", () => {
  it("builds an hourly cron from the minute of the local time", () => {
    expect(presetCron({ every: 1, time: localClock(0, 15) })).toBe("15 * * * *");
  });

  it("builds a daily cron at the UTC hour of the local time", () => {
    expect(presetCron({ every: 24, time: localClock(3, 0) })).toBe("0 3 * * *");
  });

  it.each([
    { every: 12, utcHour: 5, cron: "0 5,17 * * *" },
    { every: 8, utcHour: 0, cron: "0 0,8,16 * * *" },
    { every: 6, utcHour: 0, cron: "0 0,6,12,18 * * *" },
  ])("spaces runs every $every hours from the UTC hour", ({ every, utcHour, cron }) => {
    expect(presetCron({ every, time: localClock(utcHour, 0) })).toBe(cron);
  });

  it("treats an empty time as midnight and a missing minute as zero", () => {
    expect(presetCron({ every: 24, time: "" })).toBe(presetCron({ every: 24, time: "00:00" }));
    expect(presetCron({ every: 24, time: "05" })).toBe(presetCron({ every: 24, time: "05:00" }));
  });
});

describe("cronPreset", () => {
  it("returns the hourly preset with the local minute", () => {
    expect(cronPreset("15 * * * *")).toEqual({ every: 1, time: localClock(0, 15) });
  });

  it("returns the daily preset at the local time", () => {
    expect(cronPreset("0 3 * * *")).toEqual({ every: 24, time: localClock(3, 0) });
  });

  it("returns the frequency and earliest local run time for spaced crons", () => {
    expect(cronPreset("0 12,0 * * *")).toEqual({
      every: 12,
      time: [localClock(0, 0), localClock(12, 0)].sort()[0],
    });
    expect(cronPreset("30 6,14,22 * * *")).toEqual({
      every: 8,
      time: [localClock(6, 30), localClock(14, 30), localClock(22, 30)].sort()[0],
    });
  });

  it("trims surrounding whitespace", () => {
    expect(cronPreset("  0 3 * * *  ")).toEqual({ every: 24, time: localClock(3, 0) });
  });

  it.each(["*/5 * * * *", "0 3 * * 1", "0 0,5,10,15,20 * * *", "0 0,6,12 * * *", "0 3,3 * * *"])(
    "returns null for %s",
    (cron) => {
      expect(cronPreset(cron)).toBeNull();
    },
  );

  it.each(["15 * * * *", "0 3 * * *", "0 0,12 * * *", "0 0,8,16 * * *", "0 0,6,12,18 * * *"])(
    "round-trips %s through presetCron",
    (cron) => {
      expect(roundTrip(cron)).toBe(cron);
    },
  );
});

describe("runTimes", () => {
  it("steps from the start time by the frequency", () => {
    expect(runTimes({ every: 6, time: "00:30" })).toEqual(["00:30", "06:30", "12:30", "18:30"]);
  });

  it("wraps past midnight", () => {
    expect(runTimes({ every: 8, time: "20:00" })).toEqual(["20:00", "04:00", "12:00"]);
    expect(runTimes({ every: 12, time: "12:00" })).toEqual(["12:00", "00:00"]);
  });

  it("returns a single run for daily presets", () => {
    expect(runTimes({ every: 24, time: "09:15" })).toEqual(["09:15"]);
  });

  it("returns hourly runs across the whole day", () => {
    const runs = runTimes({ every: 1, time: "00:00" });
    expect(runs).toHaveLength(24);
    expect(runs[23]).toBe("23:00");
  });
});

describe("describeCron", () => {
  it("describes hourly crons by their local minute", () => {
    expect(describeCron("15 * * * *")).toBe(`Hourly at :${localClock(0, 15).slice(3)}`);
  });

  it("describes daily crons by their local time", () => {
    expect(describeCron("0 3 * * *")).toBe(`Daily at ${localClock(3, 0)}`);
  });

  it("lists the local run times for spaced crons", () => {
    expect(describeCron("0 0,12 * * *")).toBe(`Every 12h · ${[localClock(0, 0), localClock(12, 0)].sort().join(", ")}`);
    expect(describeCron("0 0,8,16 * * *")).toBe(
      `Every 8h · ${[localClock(0, 0), localClock(8, 0), localClock(16, 0)].sort().join(", ")}`,
    );
  });

  it("falls back to the raw cron for unsupported expressions", () => {
    expect(describeCron("*/5 * * * *")).toBe("*/5 * * * * (UTC cron)");
  });
});

describe("formatDuration", () => {
  it.each([
    { seconds: -5, expected: "0s" },
    { seconds: 0.4, expected: "0s" },
    { seconds: 45, expected: "45s" },
    { seconds: 59.4, expected: "59s" },
    { seconds: 59.5, expected: "1m" },
    { seconds: 60, expected: "1m" },
    { seconds: 90, expected: "1m 30s" },
    { seconds: 3599, expected: "59m 59s" },
    { seconds: 3600, expected: "1h 0m" },
    { seconds: 3725, expected: "1h 2m" },
    { seconds: 7200, expected: "2h 0m" },
  ])("formats $seconds seconds as $expected", ({ seconds, expected }) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
