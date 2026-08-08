/**
 * Translation from raw Omada JSON into the resource shapes in `schemas.ts`.
 *
 * Every reader here is defensive on purpose. Omada's field set varies by
 * controller version, by device family, and between the Open API and the web
 * API — a switch reports `poeRemain`, an AP does not; some builds send
 * `uptime`, others `uptimeLong`; a gauge that has never been read comes back
 * as `-1`, as `0`, or absent, depending on the endpoint. Rather than schema-
 * validate the input and fail a whole sync on one unexpected device, each
 * field is read through a type-guarding accessor that yields `null` when the
 * value is missing or nonsensical. A null gauge is honest; a fabricated zero
 * is not.
 *
 * @module
 */
import type { z } from "npm:zod@4";
import type {
  ClientSchema,
  DeviceKind,
  DeviceSchema,
  DeviceState,
  SsidSchema,
  SwitchPortSchema,
  WanSchema,
} from "./schemas.ts";

/** A JSON object as returned by either Omada API. */
export type Raw = Record<string, unknown>;

/** Provenance stamped onto every fanned-out resource. */
export interface Provenance {
  /** Operator-chosen name for the controller this came from. */
  controllerLabel: string;
  /** Controller URL the read was issued against. */
  baseUrl: string;
  /** ISO-8601 instant the sync started. */
  fetchedAt: string;
}

/** Site identity threaded through every per-site mapper. */
export interface SiteRef {
  /** Opaque site id used in every per-site API path. */
  siteId: string;
  /** Display name, as shown in the controller UI. */
  siteName: string;
}

// ---------------------------------------------------------------------------
// Field accessors
// ---------------------------------------------------------------------------

/** Read a string field, falling back to `""` for anything else. */
export function str(raw: Raw, ...keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

/**
 * Read a numeric field, yielding `null` when it is missing or a sentinel.
 *
 * Omada uses `-1` for "not measured" on several gauges. Passing that through
 * would make a switch with no PoE reading look like it is drawing negative
 * power, so negatives are rejected unless the caller opts in.
 */
export function num(
  raw: Raw,
  keys: string[],
  opts: { allowNegative?: boolean } = {},
): number | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      if (!opts.allowNegative && value < 0) continue;
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        if (!opts.allowNegative && parsed < 0) continue;
        return parsed;
      }
    }
  }
  return null;
}

/** Read an integer field, truncating a fractional reading. */
export function int(
  raw: Raw,
  keys: string[],
  opts: { allowNegative?: boolean } = {},
): number | null {
  const value = num(raw, keys, opts);
  return value === null ? null : Math.trunc(value);
}

/**
 * Read a boolean field.
 *
 * Omada mixes real booleans with `0`/`1` integers for the same concept across
 * endpoints, so both are accepted. An absent field takes `fallback` rather
 * than defaulting to false — "no PoE key" means "not PoE-capable", which is
 * not the same claim as "PoE is off".
 */
export function bool(
  raw: Raw,
  keys: string[],
  fallback = false,
): boolean {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
  }
  return fallback;
}

/** Read a boolean that stays `null` when the controller said nothing. */
export function maybeBool(raw: Raw, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
  }
  return null;
}

/** Read a nested object, yielding an empty object when absent. */
export function obj(raw: Raw, key: string): Raw {
  const value = raw[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Raw
    : {};
}

/** Read an array of objects, yielding an empty array when absent. */
export function arr(raw: Raw, ...keys: string[]): Raw[] {
  for (const key of keys) {
    const value = raw[key];
    if (Array.isArray(value)) {
      return value.filter((v): v is Raw =>
        v !== null && typeof v === "object" && !Array.isArray(v)
      );
    }
  }
  return [];
}

/**
 * Read an uptime that may be a count of seconds or a rendered duration.
 *
 * 5.x sends `uptimeLong` as seconds. 6.x sends `uptime` as display text —
 * `"171day(s) 18m 57s"`, `"75day(s) 3h 19m"` — with units omitted when zero.
 * Parsing it back is worth the regex: the generic numeric accessor correctly
 * refuses the string and yields null, which loses a reading the controller
 * did in fact provide.
 *
 * The unit patterns require the letter not be followed by another, so the `s`
 * in `day(s)` cannot be mistaken for seconds.
 */
export function uptimeSeconds(raw: Raw, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
    if (typeof value !== "string" || value.trim() === "") continue;
    const unit = (pattern: RegExp): number => {
      const match = pattern.exec(value);
      return match ? Number(match[1]) : 0;
    };
    const days = unit(/(\d+)\s*day/i);
    const hours = unit(/(\d+)\s*h(?![a-z])/i);
    const minutes = unit(/(\d+)\s*m(?![a-z])/i);
    const seconds = unit(/(\d+)\s*s(?![a-z])/i);
    const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
    if (total > 0) return total;
    // A plain numeric string is seconds; anything else parsed to nothing.
    const plain = Number(value);
    if (Number.isFinite(plain) && plain >= 0) return Math.trunc(plain);
  }
  return null;
}

/**
 * Convert an Omada timestamp to ISO-8601.
 *
 * The controller sends epoch milliseconds on most endpoints and epoch seconds
 * on a few. Ten-digit values are treated as seconds — the boundary sits in
 * 2001 for milliseconds and 5138 for seconds, so no real reading is ambiguous.
 */
export function isoTime(raw: Raw, ...keys: string[]): string | null {
  const value = num(raw, keys);
  if (value === null || value === 0) return null;
  const ms = value < 1e11 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Normalise a MAC address for comparison.
 *
 * The controller accepts and emits `AA-BB-CC-DD-EE-FF`, `AA:BB:CC:DD:EE:FF`
 * and bare hex interchangeably, sometimes within one response. Reducing to
 * lowercase hex makes the argument a user typed match the inventory.
 */
export function normaliseMac(mac: string): string {
  return mac.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/** Render a MAC the way the controller's URLs expect it. */
export function apiMac(mac: string): string {
  const hex = normaliseMac(mac);
  if (hex.length !== 12) return mac;
  return (hex.match(/.{2}/g) ?? []).join("-").toUpperCase();
}

// ---------------------------------------------------------------------------
// Enumeration mapping
// ---------------------------------------------------------------------------

/**
 * Map Omada's coarse device-state integer onto a named state.
 *
 * The key it arrives under moved. On 5.x the device list carries both a
 * fine-grained `status` and a coarse `statusCategory`; on 6.x the device list
 * drops `statusCategory` and puts the *coarse* value in `status` — the same
 * switch reads `status: 14, statusCategory: 1` from `switch-detail` but
 * `status: 1` from `/devices`. So `statusCategory` is preferred and `status`
 * is only consulted in its absence; reading `status` first would decode 6.x
 * correctly and then misreport every 5.x device as `unknown`.
 *
 * Anything unrecognised becomes `unknown` rather than being guessed at, and
 * the raw integer is kept on the resource so a new code stays diagnosable.
 */
export function deviceState(raw: Raw): DeviceState {
  const category = int(raw, ["statusCategory", "status"], {
    allowNegative: true,
  });
  switch (category) {
    case 0:
      return "disconnected";
    case 1:
      return "connected";
    case 2:
      return "pending";
    case 3:
      return "heartbeatMissed";
    case 4:
      return "isolated";
    case 5:
      return "upgrading";
    default:
      return "unknown";
  }
}

/** Map Omada's device `type` string onto a family. */
export function deviceKind(raw: Raw): DeviceKind {
  const type = str(raw, "type", "deviceType").toLowerCase();
  if (type === "ap" || type === "eap") return "ap";
  if (type === "switch") return "switch";
  if (type === "gateway") return "gateway";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Instance naming
// ---------------------------------------------------------------------------

/**
 * Build a resource instance name.
 *
 * Instance names are storage paths, and swamp requires them unique across
 * every spec on the model — two specs sharing a name silently overwrite each
 * other. Prefixing with the spec name makes collisions structurally
 * impossible, and slugging keeps a site called "Head Office / Floor 2" from
 * producing a path separator.
 *
 * Callers must pass MACs through `normaliseMac` first. The slugger turns any
 * separator into `-`, so `AA:BB:...` and `AA-BB-...` would otherwise yield the
 * same name while bare hex yielded a different one — and an instance name that
 * moves with the controller's formatting makes every object look new to drift
 * detection.
 */
export function instanceName(spec: string, ...parts: string[]): string {
  const slug = parts
    .map((p) => p.replace(/[^0-9a-zA-Z]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((p) => p !== "")
    .join("-")
    .toLowerCase();
  return slug === "" ? spec : `${spec}-${slug}`;
}

// ---------------------------------------------------------------------------
// Resource mappers
// ---------------------------------------------------------------------------

/** Shape one device from the Open API device list. */
export function toDevice(
  raw: Raw,
  site: SiteRef,
  p: Provenance,
): z.infer<typeof DeviceSchema> {
  const firmware = str(raw, "firmwareVersion", "version");
  const latest = str(raw, "latestFirmwareVersion");
  return {
    ...p,
    siteId: site.siteId,
    siteName: site.siteName,
    mac: str(raw, "mac"),
    name: str(raw, "name"),
    kind: deviceKind(raw),
    model: str(raw, "showModel", "model", "compoundModel"),
    serialNumber: str(raw, "sn", "serialNum"),
    ip: str(raw, "ip", "ipv4"),
    firmwareVersion: firmware,
    latestFirmwareVersion: latest,
    // Trust the controller's own flag; fall back to a version comparison only
    // when it is absent, since Omada's version strings are not orderable.
    needsUpgrade: bool(
      raw,
      ["needUpgrade"],
      latest !== "" && latest !== firmware,
    ),
    uplinkDeviceMac: str(raw, "uplinkDeviceMac", "uplinkMac"),
    uplinkDeviceName: str(raw, "uplinkDeviceName", "uplinkName"),
    state: deviceState(raw),
    // Record whichever key the coarse value actually came from, so the raw
    // code stays diagnosable on 6.x where `statusCategory` is absent.
    statusCategory: int(raw, ["statusCategory", "status"], {
      allowNegative: true,
    }),
    uptimeSec: uptimeSeconds(raw, "uptimeLong", "uptime"),
    cpuPercent: num(raw, ["cpuUtil"]),
    memoryPercent: num(raw, ["memUtil"]),
    clientCount: int(raw, ["clientNum"]),
    poeConsumptionW: num(raw, ["poePower", "poeConsumption"]),
    poeRemainW: num(raw, ["poeRemain"]),
    lastSeenAt: isoTime(raw, "lastSeen"),
  };
}

/** Shape one connected client from the Open API client list. */
export function toClient(
  raw: Raw,
  site: SiteRef,
  p: Provenance,
): z.infer<typeof ClientSchema> {
  const wireless = bool(raw, ["wireless"]);
  return {
    ...p,
    siteId: site.siteId,
    siteName: site.siteName,
    mac: str(raw, "mac"),
    name: str(raw, "name", "hostName"),
    hostName: str(raw, "hostName"),
    ip: str(raw, "ip", "ipAddress"),
    blocked: bool(raw, ["blocked", "block"]),
    guest: bool(raw, ["guest"]),
    vlanId: int(raw, ["vid", "vlanId"]),
    networkName: str(raw, "networkName"),
    wireless,
    ssid: str(raw, "ssid"),
    // The uplink is reported under a different key per connection type, and
    // an AP-attached client carries both — prefer the one that matches.
    uplinkDeviceMac: wireless
      ? str(raw, "apMac", "gatewayMac", "switchMac")
      : str(raw, "switchMac", "gatewayMac", "apMac"),
    uplinkDeviceName: wireless
      ? str(raw, "apName", "gatewayName", "switchName")
      : str(raw, "switchName", "gatewayName", "apName"),
    port: int(raw, ["port"]),
    radio: str(raw, "wifiMode", "radioId"),
    channel: int(raw, ["channel"]),
    active: bool(raw, ["active"], true),
    // `rssi` is already dBm and legitimately negative; `signalLevel` is a
    // 0-100 percentage. They are not interchangeable.
    signalDbm: num(raw, ["rssi"], { allowNegative: true }),
    signalPercent: num(raw, ["signalLevel"]),
    rxRateKbps: num(raw, ["rxRate"]),
    txRateKbps: num(raw, ["txRate"]),
    trafficDownBytes: num(raw, ["trafficDown", "download"]),
    trafficUpBytes: num(raw, ["trafficUp", "upload"]),
    uptimeSec: uptimeSeconds(raw, "uptime"),
    lastSeenAt: isoTime(raw, "lastSeen"),
  };
}

/**
 * Omada's link-speed enum, decoded to megabits.
 *
 * The wire value is an ordinal, not a rate: a gigabit link on an SG2428LP
 * reports `3`. Unrecognised codes yield `null` rather than a guessed rate —
 * `linkUp` already answers "is it connected", so an unknown speed does not
 * need inventing.
 */
const LINK_SPEED_MBPS: Record<number, number> = {
  1: 10,
  2: 100,
  3: 1000,
  4: 2500,
  5: 5000,
  6: 10000,
};

/** Omada's duplex enum. */
const DUPLEX: Record<number, string> = { 1: "half", 2: "full" };

/**
 * Shape one switch port from a `poe-info` row.
 *
 * The row is self-describing — it carries `switchMac` and `switchName` — so
 * unlike the 5.x `switch-detail` shape there is no parent record to thread
 * through. Live readings live in a nested `portStatus`, while admin state and
 * PoE capability sit at the top level, so both are consulted.
 */
export function toSwitchPort(
  raw: Raw,
  site: SiteRef,
  p: Provenance,
): z.infer<typeof SwitchPortSchema> {
  // `supportPoe` is capability; `poe` is the on/off state. They are different
  // keys with confusingly similar names, and conflating them would report
  // every non-PoE port as switched off.
  const poeCapable = maybeBool(raw, ["supportPoe", "poeSupport"]) ??
    (int(raw, ["switchSupportPoe"]) ?? 0) > 0;
  const status = obj(raw, "portStatus");
  const speedCode = int(status, ["linkSpeed"]) ?? int(raw, ["linkSpeed"]);
  const duplexCode = int(status, ["duplex"]) ?? int(raw, ["duplex"]);
  return {
    ...p,
    siteId: site.siteId,
    siteName: site.siteName,
    switchMac: str(raw, "switchMac"),
    switchName: str(raw, "switchName"),
    port: int(raw, ["port", "portNum"]) ?? 0,
    name: str(raw, "portName", "name"),
    profileName: str(raw, "profileName", "profile"),
    // `disable` is the controller's own spelling; invert rather than invent an
    // `enabled` key that no build actually sends.
    enabled: !bool(raw, ["disable", "disabled"]),
    poeEnabled: poeCapable
      ? maybeBool(raw, ["poe", "poeMode", "poeEnable"]) ??
        maybeBool(status, ["poe"])
      : null,
    poeCapable,
    linkUp: bool(status, ["linkStatus"]) || bool(raw, ["connectedStatus"]),
    linkSpeedMbps: speedCode === null
      ? null
      : LINK_SPEED_MBPS[speedCode] ?? null,
    duplex: duplexCode === null ? "" : DUPLEX[duplexCode] ?? "",
    poeDrawW: poeCapable
      ? num(status, ["poePower"]) ?? num(raw, ["power", "poeStatus"])
      : null,
    rxBytes: num(status, ["rx"]) ?? num(raw, ["rxBytes"]),
    txBytes: num(status, ["tx"]) ?? num(raw, ["txBytes"]),
  };
}

/** Shape one gateway WAN interface from a `wan-status` entry. */
export function toWan(
  raw: Raw,
  parent: { mac: string; name: string },
  site: SiteRef,
  p: Provenance,
): z.infer<typeof WanSchema> {
  return {
    ...p,
    siteId: site.siteId,
    siteName: site.siteName,
    gatewayMac: parent.mac,
    gatewayName: parent.name,
    portName: str(raw, "portName", "name", "portDesc"),
    ip: str(raw, "ipv4", "ip", "wanIp"),
    gatewayIp: str(raw, "gateway", "gatewayIp"),
    netmask: str(raw, "netmask", "mask"),
    primaryDns: str(raw, "priDns", "primaryDns", "dns1"),
    secondaryDns: str(raw, "sndDns", "secondaryDns", "dns2"),
    mode: str(raw, "mode", "proto", "connectType"),
    online: bool(raw, ["online", "wanPortLinkStatus"]),
    linkSpeedMbps: int(raw, ["linkSpeed", "speed"]),
    rxBytes: num(raw, ["rxBytes", "rx"]),
    txBytes: num(raw, ["txBytes", "tx"]),
    latencyMs: num(raw, ["latency", "delay"]),
  };
}

/** Shape one wireless network. */
export function toSsid(
  raw: Raw,
  site: SiteRef,
  wlanId: string,
  p: Provenance,
): z.infer<typeof SsidSchema> {
  return {
    ...p,
    siteId: site.siteId,
    siteName: site.siteName,
    ssidId: str(raw, "id", "ssidId"),
    wlanId,
    name: str(raw, "name", "ssid"),
    // An SSID with no explicit enable flag is enabled — the controller only
    // sends the key once someone has turned one off.
    enabled: bool(raw, ["enable", "enabled"], true),
    broadcast: bool(raw, ["broadcast", "ssidBroadcast"], true),
    security: str(raw, "security", "securityMode", "wpaMode"),
    guestNetwork: bool(raw, ["guestNetEnable", "guestNet"]),
    vlanEnabled: bool(raw, ["vlanEnable", "vlanEnabled"]),
    vlanId: int(raw, ["vlanId", "vid"]),
    band: str(raw, "band", "wlanBand"),
    rateLimitEnabled: bool(raw, ["rateLimitEnable", "rateLimit"]),
  };
}
