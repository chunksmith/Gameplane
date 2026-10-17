import type { IntlShape } from "react-intl";
import { englishIntl } from "@/lib/i18n/format";

export const GROUP_LABEL_PREFIX = "backup-group.gameplane.local/";
export const SCHEDULE_LABEL = "gameplane.local/backup-schedule";
export const DEFAULT_GROUP = "default";
export const GROUP_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const FREQUENCIES = [24, 12, 8, 6, 4, 2, 1] as const;

export interface CronPreset {
  every: number;
  time: string;
}

export function serverGroups(labels?: Record<string, string>): string[] {
  return Object.entries(labels ?? {})
    .filter(([key, value]) => key.startsWith(GROUP_LABEL_PREFIX) && value === "enabled")
    .map(([key]) => key.slice(GROUP_LABEL_PREFIX.length))
    .sort();
}

export function effectiveGroups(labels?: Record<string, string>): string[] {
  const groups = serverGroups(labels);
  return groups.length > 0 ? groups : [DEFAULT_GROUP];
}

export function inGroups(labels: Record<string, string> | undefined, groups: string[]): boolean {
  return effectiveGroups(labels).some((group) => groups.includes(group));
}

export function withGroups(labels: Record<string, string> | undefined, groups: string[]): Record<string, string> {
  const next = Object.fromEntries(Object.entries(labels ?? {}).filter(([key]) => !key.startsWith(GROUP_LABEL_PREFIX)));
  for (const group of groups) next[GROUP_LABEL_PREFIX + group] = "enabled";
  return next;
}

const pad = (n: number) => String(n).padStart(2, "0");

function localFromUtc(hour: number, minute: number): string {
  const date = new Date();
  date.setUTCHours(hour, minute, 0, 0);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function presetCron({ every, time }: CronPreset): string {
  const [hour, minute] = time.split(":").map(Number);
  const date = new Date();
  date.setHours(hour || 0, minute || 0, 0, 0);
  const utcHour = date.getUTCHours();
  if (every === 1) return `${date.getUTCMinutes()} * * * *`;
  const hours = Array.from({ length: 24 / every }, (_, i) => (utcHour + i * every) % 24).sort((a, b) => a - b);
  return `${date.getUTCMinutes()} ${hours.join(",")} * * *`;
}

export function cronPreset(cron: string): CronPreset | null {
  const match = /^(\d{1,2}) (\*|\d{1,2}(?:,\d{1,2})*) \* \* \*$/.exec(cron.trim());
  if (!match) return null;
  const minute = Number(match[1]);
  if (match[2] === "*") return { every: 1, time: localFromUtc(0, minute) };
  const hours = match[2].split(",").map(Number).sort((a, b) => a - b);
  const every = 24 / hours.length;
  if (!(FREQUENCIES as readonly number[]).includes(every) || !hours.every((hour, i) => hour === hours[0] + i * every)) return null;
  return { every, time: hours.map((hour) => localFromUtc(hour, minute)).sort()[0] };
}

export function runTimes({ every, time }: CronPreset): string[] {
  const [hour, minute] = time.split(":").map(Number);
  return Array.from({ length: 24 / every }, (_, i) => `${pad((hour + i * every) % 24)}:${pad(minute)}`);
}

export function describeCron(cron: string, intl: IntlShape = englishIntl): string {
  const preset = cronPreset(cron);
  if (!preset) return intl.formatMessage({ id: "web.lib.backup_groups.utc_cron", defaultMessage: "{cron} (UTC cron)", description: "Backup schedule: shown instead of a plain-language description when the cron expression is custom; {cron} is the raw cron expression" }, { cron });
  if (preset.every === 1) return intl.formatMessage({ id: "web.lib.backup_groups.hourly", defaultMessage: "Hourly at :{minute}", description: "Backup schedule: description of a schedule that runs every hour; {minute} is the two-digit minute past the hour" }, { minute: preset.time.slice(3) });
  if (preset.every === 24) return intl.formatMessage({ id: "web.lib.backup_groups.daily", defaultMessage: "Daily at {time}", description: "Backup schedule: description of a schedule that runs once a day; {time} is the local start time as HH:MM" }, { time: preset.time });
  return intl.formatMessage({ id: "web.lib.backup_groups.every_hours", defaultMessage: "Every {hours}h · {times}", description: "Backup schedule: description of a schedule that runs every few hours; {hours} is the interval in hours and {times} the local run times, comma separated" }, { hours: preset.every, times: runTimes(preset).join(", ") });
}

export function formatDuration(totalSeconds: number, intl: IntlShape = englishIntl): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return intl.formatMessage({ id: "web.lib.backup_groups.duration_seconds", defaultMessage: "{seconds}s", description: "Duration of less than a minute, e.g. 45s; {seconds} is a whole number of seconds" }, { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60
    ? intl.formatMessage({ id: "web.lib.backup_groups.duration_minutes_seconds", defaultMessage: "{minutes}m {seconds}s", description: "Duration of less than an hour with seconds, e.g. 5m 30s; {minutes} and {seconds} are whole numbers" }, { minutes, seconds: seconds % 60 })
    : intl.formatMessage({ id: "web.lib.backup_groups.duration_minutes", defaultMessage: "{minutes}m", description: "Duration of whole minutes under an hour, e.g. 5m; {minutes} is a whole number" }, { minutes });
  return intl.formatMessage({ id: "web.lib.backup_groups.duration_hours_minutes", defaultMessage: "{hours}h {minutes}m", description: "Duration of an hour or more, e.g. 2h 5m; {hours} and {minutes} are whole numbers" }, { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}
