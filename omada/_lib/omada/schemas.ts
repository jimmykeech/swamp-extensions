/**
 * Zod schemas for `@jamesakeech/omada`.
 *
 * Omada's two APIs disagree with each other about naming and about how to say
 * "nothing": the Open API returns `-1` for an unread gauge, the web API
 * returns the key absent, and both use `0` for several fields that genuinely
 * can be zero. The schemas below define the swamp-facing shape only — every
 * gauge that may be unavailable is `.nullable()` so a missing reading is
 * distinguishable from a real zero, and translation lives in `map.ts`.
 *
 * Resource shapes are split along a line that matters for drift detection:
 * fields describing *configuration* (name, firmware, addressing, PoE mode,
 * SSID settings) sit alongside fields describing *telemetry* (uptime, CPU,
 * traffic counters, signal). `drift.ts` compares only the former.
 *
 * @module
 */
import { z } from "npm:zod@4";

// --- Connection -------------------------------------------------------------

/** How to reach and authenticate against one Omada controller. */
export const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "Root URL of the controller, including port — e.g. " +
      "https://192.0.2.10:8043 for a self-hosted or OC200 controller, or a " +
      "regional northbound host such as " +
      "https://euw1-omada-northbound.tplinkcloud.com for Omada Cloud. A " +
      "trailing slash is tolerated.",
  ),
  omadacId: z.string().optional().describe(
    "Controller id. Discovered automatically from the unauthenticated " +
      "/api/info on a self-hosted controller; required for cloud northbound " +
      "hosts, which do not serve that endpoint.",
  ),
  clientId: z.string().optional().describe(
    "Open API application client id, from Settings > Platform Integration > " +
      "Open API. The application must be in Client mode.",
  ),
  clientSecret: z.string().optional().meta({ sensitive: true }).describe(
    "Open API application client secret. Supply via a vault expression — it " +
      "is never written to any resource.",
  ),
  username: z.string().optional().describe(
    "Controller web login, used only for reads the Open API does not expose " +
      "(LAN networks, firewall ACLs, site settings). Omit to skip those.",
  ),
  password: z.string().optional().meta({ sensitive: true }).describe(
    "Password for `username`. Supply via a vault expression — it is never " +
      "written to any resource.",
  ),
  controllerLabel: z.string().default("omada").describe(
    "Human label for this controller, stamped onto every resource so output " +
      "from several controllers stays distinguishable.",
  ),
  siteFilter: z.array(z.string()).default([]).describe(
    "Site names to collect. Empty means every site the credentials can see.",
  ),
  caCertPem: z.string().optional().describe(
    "PEM certificate chain to trust in addition to the system roots. Omada " +
      "controllers ship a self-signed certificate on 8043; paste it here " +
      "rather than disabling verification.",
  ),
  requestTimeoutSec: z.number().int().positive().default(30).describe(
    "Per-request timeout. Raise it for controllers managing many sites.",
  ),
});

/** Connection settings for one Omada controller. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/**
 * Apply the schema's defaults by hand.
 *
 * Swamp parses `globalArguments` through the Zod schema before a *method*
 * runs, but hands pre-flight *checks* the raw definition — so a field the
 * operator never set arrives as `undefined` inside a check even though its
 * type says otherwise. That is how `requestTimeoutSec` reached
 * `AbortSignal.timeout(NaN)` and made `controller-reachable` fail against a
 * controller that was answering fine.
 *
 * Rather than have every call site guess, both entry points normalise here.
 * The casts are deliberate: the inferred type claims these are always present,
 * and this function exists precisely because that claim is not true on the
 * check path.
 */
export function withDefaults(g: GlobalArgs): GlobalArgs {
  return {
    ...g,
    controllerLabel: (g.controllerLabel ?? "omada") as string,
    siteFilter: (g.siteFilter ?? []) as string[],
    requestTimeoutSec: (g.requestTimeoutSec ?? 30) as number,
  };
}

// --- Shared -----------------------------------------------------------------

/** Fields every fanned-out resource carries. */
const provenance = {
  controllerLabel: z.string(),
  baseUrl: z.string(),
  fetchedAt: z.iso.datetime(),
};

/**
 * Normalised device state.
 *
 * Omada reports `statusCategory` as a small integer whose meaning is not in
 * the response. Mapping it to a word here means a workflow guard reads
 * `state == "disconnected"` rather than `statusCategory == 0`, which would
 * silently change meaning if TP-Link renumbered.
 */
export const DeviceStateSchema = z.enum([
  "connected",
  "disconnected",
  "pending",
  "heartbeatMissed",
  "isolated",
  "upgrading",
  "unknown",
]);

/** Normalised device state. */
export type DeviceState = z.infer<typeof DeviceStateSchema>;

/** The three device families a controller manages. */
export const DeviceKindSchema = z.enum(["ap", "switch", "gateway", "unknown"]);

/** A device family. */
export type DeviceKind = z.infer<typeof DeviceKindSchema>;

// --- Inventory resources ----------------------------------------------------

/** Controller-wide rollup written once per sync. */
export const ControllerSchema = z.object({
  ...provenance,
  omadacId: z.string(),
  controllerVersion: z.string(),
  /** Which transports actually authenticated this run. */
  openApiAvailable: z.boolean(),
  webApiAvailable: z.boolean(),
  siteCount: z.number().int(),
  deviceCount: z.number().int(),
  devicesConnected: z.number().int(),
  devicesDisconnected: z.number().int(),
  devicesPendingUpgrade: z.number().int(),
  apCount: z.number().int(),
  switchCount: z.number().int(),
  gatewayCount: z.number().int(),
  clientCount: z.number().int(),
  wirelessClientCount: z.number().int(),
  wiredClientCount: z.number().int(),
  guestClientCount: z.number().int(),
  blockedClientCount: z.number().int(),
  ssidCount: z.number().int(),
  /** Total PoE draw across every switch that reports it, in watts. */
  poeConsumptionW: z.number().nullable(),
  /** Names of devices that are not in the `connected` state. */
  devicesNotConnected: z.array(z.string()),
  /** Devices whose running firmware is behind the latest offered. */
  devicesNeedingUpgrade: z.array(z.string()),
  /**
   * Instance names of every object watched for drift, recorded so the next
   * sync can tell "this object is gone" from "this object was never here".
   * Clients are excluded — they come and go by design.
   */
  trackedInstances: z.array(z.string()),
});

/** One managed site. */
export const SiteSchema = z.object({
  ...provenance,
  siteId: z.string(),
  name: z.string(),
  region: z.string(),
  timeZone: z.string(),
  scenario: z.string(),
  deviceCount: z.number().int(),
  clientCount: z.number().int(),
  alertCount: z.number().int(),
  /** Site-wide LED override, when the controller reports one. */
  ledEnabled: z.boolean().nullable(),
});

/** One managed device: an access point, switch or gateway. */
export const DeviceSchema = z.object({
  ...provenance,
  siteId: z.string(),
  siteName: z.string(),
  mac: z.string(),
  name: z.string(),
  kind: DeviceKindSchema,
  model: z.string(),
  serialNumber: z.string(),
  // --- configuration: compared for drift ---
  ip: z.string(),
  firmwareVersion: z.string(),
  latestFirmwareVersion: z.string(),
  needsUpgrade: z.boolean(),
  uplinkDeviceMac: z.string(),
  uplinkDeviceName: z.string(),
  // --- telemetry: excluded from drift ---
  state: DeviceStateSchema,
  /** Raw `statusCategory`, kept so an unmapped value is still inspectable. */
  statusCategory: z.number().int().nullable(),
  uptimeSec: z.number().int().nullable(),
  cpuPercent: z.number().nullable(),
  memoryPercent: z.number().nullable(),
  clientCount: z.number().int().nullable(),
  /** PoE watts currently delivered by this device, switches only. */
  poeConsumptionW: z.number().nullable(),
  /** PoE watts still available, switches only. */
  poeRemainW: z.number().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
});

/** One connected client, wired or wireless. */
export const ClientSchema = z.object({
  ...provenance,
  siteId: z.string(),
  siteName: z.string(),
  mac: z.string(),
  name: z.string(),
  hostName: z.string(),
  ip: z.string(),
  // --- configuration-ish: compared for drift ---
  /** True when the controller is blocking this client's network access. */
  blocked: z.boolean(),
  guest: z.boolean(),
  vlanId: z.number().int().nullable(),
  networkName: z.string(),
  // --- association ---
  wireless: z.boolean(),
  ssid: z.string(),
  /** MAC of the AP or switch the client is attached to. */
  uplinkDeviceMac: z.string(),
  uplinkDeviceName: z.string(),
  /** Switch port number for wired clients. */
  port: z.number().int().nullable(),
  radio: z.string(),
  channel: z.number().int().nullable(),
  // --- telemetry: excluded from drift ---
  active: z.boolean(),
  signalDbm: z.number().nullable(),
  signalPercent: z.number().nullable(),
  rxRateKbps: z.number().nullable(),
  txRateKbps: z.number().nullable(),
  trafficDownBytes: z.number().nullable(),
  trafficUpBytes: z.number().nullable(),
  uptimeSec: z.number().int().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
});

/** One physical port on one switch. */
export const SwitchPortSchema = z.object({
  ...provenance,
  siteId: z.string(),
  siteName: z.string(),
  switchMac: z.string(),
  switchName: z.string(),
  port: z.number().int(),
  name: z.string(),
  // --- configuration: compared for drift ---
  profileName: z.string(),
  /** True when the port is administratively enabled. */
  enabled: z.boolean(),
  /** True when PoE is switched on for this port. Null when not PoE-capable. */
  poeEnabled: z.boolean().nullable(),
  poeCapable: z.boolean(),
  // --- telemetry: excluded from drift ---
  linkUp: z.boolean(),
  linkSpeedMbps: z.number().int().nullable(),
  duplex: z.string(),
  poeDrawW: z.number().nullable(),
  rxBytes: z.number().nullable(),
  txBytes: z.number().nullable(),
});

/** One gateway WAN interface. */
export const WanSchema = z.object({
  ...provenance,
  siteId: z.string(),
  siteName: z.string(),
  gatewayMac: z.string(),
  gatewayName: z.string(),
  portName: z.string(),
  // --- configuration: compared for drift ---
  ip: z.string(),
  gatewayIp: z.string(),
  netmask: z.string(),
  primaryDns: z.string(),
  secondaryDns: z.string(),
  /** How the address was obtained — dhcp, static, pppoe, and so on. */
  mode: z.string(),
  // --- telemetry: excluded from drift ---
  online: z.boolean(),
  linkSpeedMbps: z.number().int().nullable(),
  rxBytes: z.number().nullable(),
  txBytes: z.number().nullable(),
  latencyMs: z.number().nullable(),
});

/** One wireless network as configured on a site. */
export const SsidSchema = z.object({
  ...provenance,
  siteId: z.string(),
  siteName: z.string(),
  ssidId: z.string(),
  wlanId: z.string(),
  name: z.string(),
  // --- configuration: compared for drift ---
  enabled: z.boolean(),
  broadcast: z.boolean(),
  security: z.string(),
  guestNetwork: z.boolean(),
  vlanEnabled: z.boolean(),
  vlanId: z.number().int().nullable(),
  band: z.string(),
  rateLimitEnabled: z.boolean(),
});

// --- Drift ------------------------------------------------------------------

/** One field that changed between two syncs. */
export const DriftEntrySchema = z.object({
  /** Resource spec the change was seen on, e.g. `device`. */
  kind: z.string(),
  /** Resource instance name, so the changed object is directly addressable. */
  instanceName: z.string(),
  /** Human label for the object — a device name, an SSID, a port. */
  subject: z.string(),
  field: z.string(),
  /** Previous value rendered as text; null when the field was absent. */
  before: z.string().nullable(),
  /** Current value rendered as text; null when the field is now absent. */
  after: z.string().nullable(),
});

/** What changed on the controller since the previous sync. */
export const DriftSchema = z.object({
  ...provenance,
  /** True when a previous sync existed to compare against. */
  hasBaseline: z.boolean(),
  changed: z.boolean(),
  changeCount: z.number().int(),
  appearedCount: z.number().int(),
  disappearedCount: z.number().int(),
  modifiedCount: z.number().int(),
  /** Instance names of objects seen for the first time. */
  appeared: z.array(z.string()),
  /** Instance names of objects present last sync and absent now. */
  disappeared: z.array(z.string()),
  entries: z.array(DriftEntrySchema),
});

// --- Change -----------------------------------------------------------------

/** Outcome for one target of a mutating method. */
export const ChangeResultSchema = z.object({
  /** MAC, or `mac:port` for a port-scoped operation. */
  target: z.string(),
  action: z.string(),
  ok: z.boolean(),
  message: z.string(),
});

/** Outcome of the most recent run of one mutating method. */
export const ChangeSchema = z.object({
  controllerLabel: z.string(),
  baseUrl: z.string(),
  method: z.string(),
  performedAt: z.iso.datetime(),
  /** Collapsed headline: the shared action, or `partial` on a mixed batch. */
  action: z.string(),
  ok: z.boolean(),
  okCount: z.number().int(),
  failCount: z.number().int(),
  results: z.array(ChangeResultSchema),
});

// --- Method arguments -------------------------------------------------------

/** Arguments for `sync`. */
export const SyncArgsSchema = z.object({
  includeClients: z.boolean().default(true).describe(
    "Collect connected clients. The largest part of a sync on a busy site — " +
      "turn it off for a device-only inventory.",
  ),
  includePorts: z.boolean().default(true).describe(
    "Collect per-port switch detail, including PoE state.",
  ),
  includeSsids: z.boolean().default(true).describe(
    "Collect wireless network configuration.",
  ),
  detectDrift: z.boolean().default(true).describe(
    "Compare configuration fields against the previous sync and write a " +
      "`drift` resource. Telemetry — uptime, CPU, traffic, signal — is never " +
      "compared, so an idle network produces no drift.",
  ),
});

/** Arguments for methods that address a list of devices by MAC. */
export const DeviceTargetArgsSchema = z.object({
  macs: z.array(z.string()).min(1).describe(
    "Device MAC addresses. Separators and case are normalised, so " +
      "`AA-BB-CC-DD-EE-FF` and `aa:bb:cc:dd:ee:ff` both resolve.",
  ),
  siteName: z.string().optional().describe(
    "Restrict the lookup to one site. Omit to search every synced site.",
  ),
});

/** Arguments for `locateDevices`. */
export const LocateArgsSchema = DeviceTargetArgsSchema.extend({
  enabled: z.boolean().default(true).describe(
    "True starts the locate flash, false stops it.",
  ),
});

/** Arguments for methods that address a list of clients by MAC. */
export const ClientTargetArgsSchema = z.object({
  macs: z.array(z.string()).min(1).describe(
    "Client MAC addresses. Separators and case are normalised.",
  ),
  siteName: z.string().optional().describe(
    "Restrict the lookup to one site. Omit to search every synced site.",
  ),
});

/** Arguments for `setClientAccess`. */
export const SetClientAccessArgsSchema = ClientTargetArgsSchema.extend({
  blocked: z.boolean().describe(
    "True blocks the clients from the network, false restores access.",
  ),
});

/** One port to switch PoE on or off. */
export const PoePortSchema = z.object({
  switchMac: z.string(),
  port: z.number().int().positive(),
  enabled: z.boolean(),
});

/** Arguments for `setPoePorts`. */
export const SetPoePortsArgsSchema = z.object({
  ports: z.array(PoePortSchema).min(1).describe(
    "Ports to change, each as `{switchMac, port, enabled}`. Batched into one " +
      "call per switch so a multi-port change is a single controller write.",
  ),
  siteName: z.string().optional().describe(
    "Restrict the lookup to one site. Omit to search every synced site.",
  ),
});

/** Arguments for `setLed`. */
export const SetLedArgsSchema = z.object({
  enabled: z.boolean().describe(
    "True turns site-wide device LEDs on, false turns them off.",
  ),
  siteName: z.string().optional().describe(
    "Site to change. Omit to apply to every synced site.",
  ),
});
