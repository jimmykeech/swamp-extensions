/**
 * Configuration drift between two syncs.
 *
 * The point of this file is the field allowlist. A naive diff of two Omada
 * snapshots reports change on every single sync — uptime advances, traffic
 * counters climb, RSSI wanders, CPU moves — which makes the whole signal
 * worthless. Drift here means *configuration* changed: a firmware version, a
 * WAN address, a PoE port switched off, an SSID's security mode, a device that
 * stopped answering. Everything else is deliberately not compared.
 *
 * Clients are not tracked. On any real network they associate and leave
 * constantly, and treating that as drift would bury the one line that says a
 * switch port was disabled overnight.
 *
 * `buildDrift` is a pure function over an injected loader so the comparison
 * can be tested without a controller or a swamp data directory.
 *
 * @module
 */
import type { Provenance } from "./map.ts";

/** One object being watched for configuration change. */
export interface TrackedObject {
  /** Resource spec, e.g. `device`. Selects the field allowlist. */
  kind: string;
  /** Resource instance name — the key both snapshots are joined on. */
  instanceName: string;
  /** Human label used in the drift entry, e.g. a device name. */
  subject: string;
  /** The freshly mapped resource body. */
  current: Record<string, unknown>;
}

/** One field that changed between two syncs. */
export interface DriftEntry {
  /** Resource spec the change was seen on, e.g. `device`. */
  kind: string;
  /** Resource instance name, so the changed object is directly addressable. */
  instanceName: string;
  /** Human label for the object — a device name, an SSID, a port. */
  subject: string;
  /** The field that moved. */
  field: string;
  /** Previous value rendered as text; null when the field was absent. */
  before: string | null;
  /** Current value rendered as text; null when the field is now absent. */
  after: string | null;
}

/** The computed `drift` resource body, less provenance. */
export interface DriftBody {
  /** True when a previous sync existed to compare against. */
  hasBaseline: boolean;
  /** True when anything appeared, disappeared or was modified. */
  changed: boolean;
  /** Appearances plus disappearances plus individual field changes. */
  changeCount: number;
  /** How many objects were seen for the first time. */
  appearedCount: number;
  /** How many objects present last sync are absent now. */
  disappearedCount: number;
  /** How many objects present in both syncs changed at least one field. */
  modifiedCount: number;
  /** Instance names of objects seen for the first time. */
  appeared: string[];
  /** Instance names of objects present last sync and absent now. */
  disappeared: string[];
  /** Per-field before/after for every modified object. */
  entries: DriftEntry[];
}

/**
 * Fields compared per resource kind.
 *
 * `device.state` is in the list even though it is a live reading rather than
 * configuration: a device dropping to `disconnected` is the single change most
 * worth waking up for, and it is not noisy — a stable network reports the same
 * state every sync. Gauges that move on their own (uptime, CPU, memory, client
 * counts, byte counters, signal) are absent by design.
 */
export const DRIFT_FIELDS: Record<string, readonly string[]> = {
  site: ["name", "region", "timeZone", "ledEnabled"],
  device: [
    "name",
    "model",
    "ip",
    "state",
    "firmwareVersion",
    "latestFirmwareVersion",
    "needsUpgrade",
    "uplinkDeviceMac",
    "uplinkDeviceName",
  ],
  switchPort: ["name", "profileName", "enabled", "poeEnabled"],
  wan: [
    "ip",
    "gatewayIp",
    "netmask",
    "primaryDns",
    "secondaryDns",
    "mode",
  ],
  ssid: [
    "name",
    "enabled",
    "broadcast",
    "security",
    "guestNetwork",
    "vlanEnabled",
    "vlanId",
    "band",
    "rateLimitEnabled",
  ],
};

/**
 * Render a value for the drift entry.
 *
 * Entries are text so a single `entries` array can hold changes to booleans,
 * numbers and strings without a union type that CEL would struggle to read.
 * `null` and absent both render as `null`, which is unambiguous here because
 * newly appeared objects never produce field entries at all.
 */
export function render(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Compare the watched fields of one object across two snapshots. */
export function diffObject(
  kind: string,
  instanceName: string,
  subject: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): DriftEntry[] {
  const fields = DRIFT_FIELDS[kind] ?? [];
  const entries: DriftEntry[] = [];
  for (const field of fields) {
    const previous = render(before[field]);
    const current = render(after[field]);
    if (previous === current) continue;
    entries.push({
      kind,
      instanceName,
      subject,
      field,
      before: previous,
      after: current,
    });
  }
  return entries;
}

/**
 * Compare this sync's tracked objects against the previous sync.
 *
 * `previousNames` is the instance list recorded by the last sync, which is
 * what makes disappearance detectable — `loadPrevious` can only be asked about
 * a name that is already known. When it is empty the run is treated as the
 * baseline: objects are recorded, nothing is reported as changed, and
 * `hasBaseline` says so rather than a first sync claiming the whole network
 * appeared at once.
 */
export async function buildDrift(
  tracked: TrackedObject[],
  previousNames: string[],
  loadPrevious: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>,
): Promise<DriftBody> {
  const previousSet = new Set(previousNames);
  const currentSet = new Set(tracked.map((t) => t.instanceName));

  if (previousSet.size === 0) {
    return {
      hasBaseline: false,
      changed: false,
      changeCount: 0,
      appearedCount: 0,
      disappearedCount: 0,
      modifiedCount: 0,
      appeared: [],
      disappeared: [],
      entries: [],
    };
  }

  const appeared: string[] = [];
  const entries: DriftEntry[] = [];
  const modified = new Set<string>();

  for (const item of tracked) {
    if (!previousSet.has(item.instanceName)) {
      appeared.push(item.instanceName);
      continue;
    }
    const before = await loadPrevious(item.instanceName);
    // A name in the previous index with no readable body means its data was
    // garbage-collected, not that the object changed. Reporting every field as
    // drift there would be a false alarm on a repo with tight retention.
    if (before === null) continue;
    const changes = diffObject(
      item.kind,
      item.instanceName,
      item.subject,
      before,
      item.current,
    );
    if (changes.length > 0) {
      modified.add(item.instanceName);
      entries.push(...changes);
    }
  }

  const disappeared = previousNames.filter((name) => !currentSet.has(name));

  appeared.sort();
  disappeared.sort();
  entries.sort((a, b) =>
    a.instanceName.localeCompare(b.instanceName) ||
    a.field.localeCompare(b.field)
  );

  const changeCount = appeared.length + disappeared.length + entries.length;
  return {
    hasBaseline: true,
    changed: changeCount > 0,
    changeCount,
    appearedCount: appeared.length,
    disappearedCount: disappeared.length,
    modifiedCount: modified.size,
    appeared,
    disappeared,
    entries,
  };
}

/** Assemble the full `drift` resource body. */
export function driftResource(
  p: Provenance,
  body: DriftBody,
): Record<string, unknown> {
  return { ...p, ...body };
}
