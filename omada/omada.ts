/**
 * `@jamesakeech/omada` — observability and safe operational control for one
 * TP-Link Omada controller.
 *
 * One model instance represents one controller, not one site or one device.
 * That grouping is forced by the API rather than chosen: authentication is
 * controller-wide, every path is scoped by the controller id, and a device is
 * only addressable through the site that adopted it — a model that owned a
 * single switch could not resolve its own site.
 *
 * `sync` reads the whole controller and fans out one resource per site,
 * device, client, switch port, gateway WAN and SSID, so an individual port or
 * access point is addressable from CEL without post-processing a list. It also
 * writes a `drift` resource: a comparison against the previous sync restricted
 * to configuration fields, which is what makes "tell me when something changed
 * that I did not change" a query rather than a diffing exercise. Telemetry is
 * excluded from that comparison by design — see `_lib/omada/drift.ts`.
 *
 * The mutating methods are deliberately narrow. They cover operational
 * actions that are reversible from the same API — reboot, PoE, client access,
 * LED, locate, firmware — and nothing that rewrites configuration. Each takes
 * a list and fans out internally so a batch is one controller session and one
 * model lock, rather than N runs contending on the same instance.
 *
 * @module
 */
import { z } from "npm:zod@4";

import { buildChange, type ChangeResult } from "./_lib/omada/change.ts";
import type { OpenApiSession } from "./_lib/omada/client.ts";
import {
  collectSite,
  listSites,
  openSessions,
  type Sessions,
  type Warn,
} from "./_lib/omada/collect.ts";
import {
  buildDrift,
  type DriftBody,
  driftResource,
  type TrackedObject,
} from "./_lib/omada/drift.ts";
import {
  apiMac,
  instanceName,
  int,
  normaliseMac,
  type Provenance,
  type Raw,
  str,
  toClient,
  toDevice,
  toSsid,
  toSwitchPort,
  toWan,
} from "./_lib/omada/map.ts";
import {
  ChangeSchema,
  ClientSchema,
  ClientTargetArgsSchema,
  ControllerSchema,
  DeviceSchema,
  DeviceTargetArgsSchema,
  DriftSchema,
  type GlobalArgs,
  GlobalArgsSchema,
  LocateArgsSchema,
  SetClientAccessArgsSchema,
  SetLedArgsSchema,
  SetPoePortsArgsSchema,
  SiteSchema,
  SsidSchema,
  SwitchPortSchema,
  SyncArgsSchema,
  WanSchema,
} from "./_lib/omada/schemas.ts";

// --- Method context ---------------------------------------------------------
// Declared structurally rather than imported: swamp wires these at runtime and
// publishes no type package, so every extension states the slice it uses.

interface DataHandle {
  name: string;
  specName: string;
  kind: string;
  dataId: string;
  version: number;
}

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

interface MethodResult {
  dataHandles: DataHandle[];
}

/** Checks get global args only — they must not produce data. */
interface CheckContext {
  globalArgs: GlobalArgs;
  logger: { warning: (msg: string, props?: Record<string, unknown>) => void };
}

interface CheckResult {
  pass: boolean;
  errors?: string[];
}

// --- Shared helpers ---------------------------------------------------------

/** Stamp every resource with where and when it came from. */
function provenance(g: GlobalArgs, fetchedAt: string): Provenance {
  return {
    controllerLabel: g.controllerLabel,
    baseUrl: g.baseUrl,
    fetchedAt,
  };
}

/** One site as addressed by the write methods. */
interface SiteRef {
  siteId: string;
  siteName: string;
}

/**
 * Resolve the sites a mutating method should act across.
 *
 * `siteName` narrows to one site; without it the method spans every site the
 * credentials can see, intersected with `siteFilter` so a controller-wide
 * model that was scoped to one site at creation stays scoped when writing.
 * A `siteName` that matches nothing throws rather than silently acting on
 * zero devices.
 */
async function resolveSites(
  session: OpenApiSession,
  g: GlobalArgs,
  siteName: string | undefined,
): Promise<SiteRef[]> {
  const raw = await listSites(session, g.siteFilter);
  const sites = raw.map((s) => ({
    siteId: str(s, "siteId", "id"),
    siteName: str(s, "name"),
  })).filter((s) => s.siteId !== "");

  if (siteName === undefined) return sites;
  const matched = sites.filter((s) =>
    s.siteName.toLowerCase() === siteName.toLowerCase()
  );
  if (matched.length === 0) {
    const available = sites.map((s) => s.siteName).sort().join(", ");
    throw new Error(
      `site "${siteName}" not found. Available: ${available || "(none)"}`,
    );
  }
  return matched;
}

/** A device located on the controller, with the site needed to address it. */
interface Located {
  siteId: string;
  siteName: string;
  mac: string;
  name: string;
}

/**
 * Build a MAC-to-site index over the given sites.
 *
 * Written as one pass over the device lists rather than a per-MAC search:
 * a batch reboot of six APs would otherwise re-read every site six times, and
 * the device list is the cheapest collection the controller serves.
 */
async function indexDevices(
  session: OpenApiSession,
  sites: SiteRef[],
  warn: Warn,
): Promise<Map<string, Located>> {
  const index = new Map<string, Located>();
  for (const site of sites) {
    let devices: Raw[];
    try {
      // Must go through the paginated path: `/devices` without a `page`
      // parameter is a bare HTTP 400 on 6.x, which would leave every device
      // unresolvable and quietly turn a batch reboot into a no-op.
      devices = await session.listAll<Raw>(`/sites/${site.siteId}/devices`);
    } catch (err) {
      warn("could not list devices in site {site} — skipping it. {reason}", {
        site: site.siteName,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const device of devices) {
      const mac = str(device, "mac");
      if (mac === "") continue;
      index.set(normaliseMac(mac), {
        siteId: site.siteId,
        siteName: site.siteName,
        mac,
        name: str(device, "name"),
      });
    }
  }
  return index;
}

/**
 * Build a MAC-to-site index over connected clients.
 *
 * Kept separate from the device index because it is far more expensive — a
 * busy site can hold hundreds of clients — so it is only built when a client
 * method actually needs to resolve a site it was not told.
 */
async function indexClients(
  session: OpenApiSession,
  sites: SiteRef[],
  warn: Warn,
): Promise<Map<string, Located>> {
  const index = new Map<string, Located>();
  for (const site of sites) {
    let clients: Raw[];
    try {
      // v1, matching the sync path — 6.x answers the v2 spelling with 405.
      clients = await session.listAll<Raw>(`/sites/${site.siteId}/clients`);
    } catch (err) {
      warn("could not list clients in site {site} — skipping it. {reason}", {
        site: site.siteName,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const client of clients) {
      const mac = str(client, "mac");
      if (mac === "") continue;
      index.set(normaliseMac(mac), {
        siteId: site.siteId,
        siteName: site.siteName,
        mac,
        name: str(client, "name", "hostName"),
      });
    }
  }
  return index;
}

/**
 * Resolve requested MACs against an index, recording a failure for each miss.
 *
 * A MAC the controller does not know is reported as a per-target failure
 * rather than throwing, so one stale entry in a workflow's device list does
 * not abandon the reboots that would have succeeded.
 */
function resolveTargets(
  macs: string[],
  index: Map<string, Located>,
  results: ChangeResult[],
  noun: string,
): Located[] {
  const found: Located[] = [];
  for (const mac of macs) {
    const located = index.get(normaliseMac(mac));
    if (located === undefined) {
      results.push({
        target: mac,
        action: "notFound",
        ok: false,
        message: `no ${noun} with MAC ${mac} is known to this controller`,
      });
      continue;
    }
    found.push(located);
  }
  return found;
}

/** Resolve requested device MACs to addressable devices in one step. */
async function deviceTargets(
  sessions: Sessions,
  g: GlobalArgs,
  siteName: string | undefined,
  macs: string[],
  results: ChangeResult[],
  warn: Warn,
): Promise<Located[]> {
  const sites = await resolveSites(sessions.openApi, g, siteName);
  const index = await indexDevices(sessions.openApi, sites, warn);
  return resolveTargets(macs, index, results, "device");
}

/** Resolve requested client MACs to addressable clients in one step. */
async function clientTargets(
  sessions: Sessions,
  g: GlobalArgs,
  siteName: string | undefined,
  macs: string[],
  results: ChangeResult[],
  warn: Warn,
): Promise<Located[]> {
  const sites = await resolveSites(sessions.openApi, g, siteName);
  const index = await indexClients(sessions.openApi, sites, warn);
  return resolveTargets(macs, index, results, "client");
}

/** Run one write call and fold its outcome into the results list. */
async function attempt(
  session: OpenApiSession,
  results: ChangeResult[],
  target: string,
  action: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const outcome = await session.call(method, path, { body });
  results.push({
    target,
    action: outcome.ok ? action : "failed",
    ok: outcome.ok,
    message: outcome.ok ? "" : outcome.message,
  });
}

/** Open sessions, run the body, and always release the TLS clients. */
async function withSessions<T>(
  ctx: MethodContext,
  body: (sessions: Sessions) => Promise<T>,
): Promise<T> {
  const warn: Warn = (msg, props) => ctx.logger.warning(msg, props);
  const sessions = await openSessions(ctx.globalArgs, warn);
  try {
    return await body(sessions);
  } finally {
    sessions.close();
  }
}

/**
 * Run one mutating method end to end.
 *
 * Every mutating method shares the same skeleton — log what is about to be
 * attempted, open a session, collect per-target outcomes, write one change
 * record — and the interesting part of each is only the middle. Hoisting the
 * skeleton keeps the entry log, the timestamp and the change write identical
 * across all seven rather than seven chances to drift apart.
 */
async function runMutation(
  ctx: MethodContext,
  method: string,
  target: string,
  body: (
    sessions: Sessions,
    results: ChangeResult[],
    warn: Warn,
  ) => Promise<void>,
): Promise<MethodResult> {
  ctx.logger.info("{method}: starting on {target} against {label}", {
    method,
    target,
    label: ctx.globalArgs.controllerLabel,
  });
  const performedAt = new Date().toISOString();
  const results: ChangeResult[] = [];
  const warn: Warn = (msg, props) => ctx.logger.warning(msg, props);
  await withSessions(ctx, (sessions) => body(sessions, results, warn));
  return await writeChange(ctx, method, performedAt, results);
}

/** Write the change record produced by a mutating method. */
async function writeChange(
  ctx: MethodContext,
  method: string,
  performedAt: string,
  results: ChangeResult[],
): Promise<MethodResult> {
  const change = buildChange(
    method,
    ctx.globalArgs.controllerLabel,
    ctx.globalArgs.baseUrl,
    performedAt,
    results,
  );
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    ctx.logger.warning("{method}: {count} target(s) failed — {detail}", {
      method,
      count: failures.length,
      detail: failures.map((f) => `${f.target}: ${f.message}`).join("; "),
    });
  }
  ctx.logger.info("{method}: {ok} succeeded, {fail} failed", {
    method,
    ok: results.length - failures.length,
    fail: failures.length,
  });
  const handle = await ctx.writeResource("change", "change", change);
  return { dataHandles: [handle] };
}

// --- Model ------------------------------------------------------------------

/** Model definition for a single TP-Link Omada controller. */
export const model = {
  type: "@jamesakeech/omada",
  version: "2026.08.08.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    controller: {
      description:
        "Controller-wide rollup: version, site and device counts, client " +
        "mix, PoE draw, and the lists of devices that are offline or behind " +
        "on firmware.",
      schema: ControllerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    site: {
      description:
        "One managed site: its identity, device and client counts, and " +
        "site-wide LED state.",
      schema: SiteSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    device: {
      description:
        "One access point, switch or gateway: identity, addressing, " +
        "firmware and upgrade availability, uplink, state, and live CPU, " +
        "memory, client count and PoE draw.",
      schema: DeviceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    client: {
      description:
        "One connected client: identity, addressing, whether it is blocked " +
        "or a guest, what it is attached to, and live signal and traffic.",
      schema: ClientSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    switchPort: {
      description:
        "One physical switch port: its profile, admin and PoE state, and " +
        "live link speed, duplex and PoE draw.",
      schema: SwitchPortSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    wan: {
      description:
        "One gateway WAN interface: addressing, DNS, connection mode, and " +
        "live link state and throughput.",
      schema: WanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    ssid: {
      description:
        "One wireless network as configured: enablement, broadcast, " +
        "security mode, guest and VLAN settings, and band.",
      schema: SsidSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    drift: {
      description:
        "Configuration changes since the previous sync — devices and SSIDs " +
        "that appeared or disappeared, and per-field before/after for " +
        "everything modified. Telemetry is excluded, so an idle network " +
        "reports no drift.",
      schema: DriftSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    change: {
      description:
        "Outcome of the most recent run of one mutating method: what was " +
        "rebooted, switched, blocked or upgraded, and what failed.",
      schema: ChangeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },
  checks: {
    "credentials-present": {
      description:
        "Open API credentials are configured — catches an unset vault " +
        "reference before a write is attempted against a controller that " +
        "would reject it anyway.",
      appliesTo: [
        "rebootDevices",
        "setPoePorts",
        "setClientAccess",
        "reconnectClients",
        "setLed",
        "locateDevices",
        "upgradeFirmware",
      ],
      execute: (context: CheckContext): CheckResult => {
        const { clientId, clientSecret } = context.globalArgs;
        const missing: string[] = [];
        if (!clientId) missing.push("clientId");
        if (!clientSecret) missing.push("clientSecret");
        if (missing.length > 0) {
          return {
            pass: false,
            errors: [
              `missing Open API credentials: ${missing.join(", ")} — create ` +
              "an application under Settings > Platform Integration > Open " +
              "API in Client mode and supply both via a vault expression",
            ],
          };
        }
        return { pass: true };
      },
    },
    "controller-reachable": {
      description:
        "The controller answers and the Open API credentials are accepted — " +
        "separates an unreachable controller from a rejected client secret " +
        "before a change is attempted.",
      labels: ["live"],
      appliesTo: [
        "rebootDevices",
        "setPoePorts",
        "setClientAccess",
        "reconnectClients",
        "setLed",
        "locateDevices",
        "upgradeFirmware",
      ],
      execute: async (context: CheckContext): Promise<CheckResult> => {
        try {
          const sessions = await openSessions(
            context.globalArgs,
            (msg, props) => context.logger.warning(msg, props),
          );
          sessions.close();
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [err instanceof Error ? err.message : String(err)],
          };
        }
      },
    },
  },
  methods: {
    sync: {
      description:
        "Read the whole controller and write one resource per site, device, " +
        "client, switch port, gateway WAN and SSID, plus a controller " +
        "rollup and a drift record against the previous sync. Run this " +
        "before any method that addresses a device or client by MAC.",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        ctx.logger.info("sync: reading {label} at {baseUrl}", {
          label: ctx.globalArgs.controllerLabel,
          baseUrl: ctx.globalArgs.baseUrl,
        });
        return await withSessions(ctx, async (sessions) => {
          const warn: Warn = (msg, props) => ctx.logger.warning(msg, props);
          const fetchedAt = new Date().toISOString();
          const p = provenance(ctx.globalArgs, fetchedAt);

          const rawSites = await listSites(
            sessions.openApi,
            ctx.globalArgs.siteFilter,
          );

          // Everything is collected and shaped before anything is written,
          // because drift compares against the *previous* stored version —
          // writing first would make every object its own baseline.
          const pending: Array<{
            spec: string;
            name: string;
            body: Record<string, unknown>;
            /** Watched for drift; clients are deliberately not. */
            track?: { subject: string };
          }> = [];

          let clientCount = 0;
          let wirelessClientCount = 0;
          let guestClientCount = 0;
          let blockedClientCount = 0;
          let ssidCount = 0;
          let poeTotal: number | null = null;
          const allDevices: Array<z.infer<typeof DeviceSchema>> = [];

          for (const rawSite of rawSites) {
            const siteId = str(rawSite, "siteId", "id");
            const siteName = str(rawSite, "name");
            if (siteId === "") continue;
            const site = { siteId, siteName };

            const bundle = await collectSite(
              sessions.openApi,
              siteId,
              siteName,
              {
                includeClients: args.includeClients,
                includePorts: args.includePorts,
                includeSsids: args.includeSsids,
              },
              warn,
            );

            const devices = bundle.devices.map((d) => toDevice(d, site, p));
            allDevices.push(...devices);
            for (const device of devices) {
              pending.push({
                spec: "device",
                name: instanceName("device", normaliseMac(device.mac)),
                body: device,
                track: { subject: `${siteName}/${device.name || device.mac}` },
              });
            }

            const clients = bundle.clients.map((c) => toClient(c, site, p));
            for (const client of clients) {
              clientCount++;
              if (client.wireless) wirelessClientCount++;
              if (client.guest) guestClientCount++;
              if (client.blocked) blockedClientCount++;
              pending.push({
                spec: "client",
                name: instanceName("client", normaliseMac(client.mac)),
                body: client,
              });
            }

            for (const entry of bundle.ports) {
              const port = toSwitchPort(entry, site, p);
              pending.push({
                spec: "switchPort",
                name: instanceName(
                  "port",
                  normaliseMac(port.switchMac),
                  String(port.port),
                ),
                body: port,
                track: {
                  subject: `${
                    port.switchName || port.switchMac
                  } port ${port.port}`,
                },
              });
            }

            for (const group of bundle.wans) {
              group.entries.forEach((entry, position) => {
                const wan = toWan(entry, group.parent, site, p);
                // A dual-WAN gateway whose builds omit `portName` would give
                // both interfaces the same name, and the second write would
                // silently replace the first. The ordinal is the only
                // discriminator the payload always has.
                const discriminator = wan.portName === ""
                  ? `port${position + 1}`
                  : wan.portName;
                pending.push({
                  spec: "wan",
                  name: instanceName(
                    "wan",
                    normaliseMac(wan.gatewayMac),
                    discriminator,
                  ),
                  body: wan,
                  track: {
                    subject: `${
                      wan.gatewayName || wan.gatewayMac
                    } ${discriminator}`,
                  },
                });
              });
            }

            bundle.ssids.forEach(({ wlanId, entry }, position) => {
              const ssid = toSsid(entry, site, wlanId, p);
              ssidCount++;
              // Same hazard as WAN ports: an SSID list that carries no id
              // would collapse every network in the group onto one resource.
              const discriminator = ssid.ssidId !== ""
                ? ssid.ssidId
                : ssid.name !== ""
                ? ssid.name
                : `ssid${position + 1}`;
              pending.push({
                spec: "ssid",
                name: instanceName("ssid", ssid.wlanId, discriminator),
                body: ssid,
                track: { subject: `${siteName}/${ssid.name}` },
              });
            });

            if (bundle.poeConsumptionW !== null) {
              poeTotal = (poeTotal ?? 0) + bundle.poeConsumptionW;
            }

            const siteBody = {
              ...p,
              siteId,
              name: siteName,
              region: str(rawSite, "region"),
              timeZone: str(rawSite, "timeZone"),
              scenario: str(rawSite, "scenario"),
              deviceCount: devices.length,
              clientCount: clients.length,
              alertCount: int(rawSite, ["alertNum", "unarchivedAlerts"]) ?? 0,
              ledEnabled: bundle.ledEnabled,
            };
            pending.push({
              spec: "site",
              name: instanceName("site", siteName || siteId),
              body: siteBody,
              track: { subject: siteName || siteId },
            });
          }

          // --- drift, computed while the stored data is still the old run ---
          const tracked: TrackedObject[] = pending
            .filter((item) => item.track !== undefined)
            .map((item) => ({
              kind: item.spec,
              instanceName: item.name,
              subject: item.track!.subject,
              current: item.body,
            }));

          let driftBody: DriftBody = {
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
          if (args.detectDrift) {
            const previousController = await ctx.readResource("controller");
            const previousNames = Array.isArray(
                previousController?.trackedInstances,
              )
              ? (previousController.trackedInstances as unknown[])
                .filter((n): n is string => typeof n === "string")
              : [];
            driftBody = await buildDrift(
              tracked,
              previousNames,
              (name) => ctx.readResource(name),
            );
          }

          // --- writes ---
          const handles: DataHandle[] = [];
          for (const item of pending) {
            handles.push(
              await ctx.writeResource(item.spec, item.name, item.body),
            );
          }

          handles.push(
            await ctx.writeResource(
              "drift",
              "drift",
              driftResource(p, driftBody),
            ),
          );

          const connected = allDevices.filter((d) => d.state === "connected");
          const notConnected = allDevices.filter((d) =>
            d.state !== "connected"
          );
          const needingUpgrade = allDevices.filter((d) => d.needsUpgrade);
          const controllerBody = {
            ...p,
            omadacId: sessions.omadacId,
            controllerVersion: sessions.controllerVersion,
            openApiAvailable: true,
            webApiAvailable: sessions.webApi !== null,
            siteCount: rawSites.length,
            deviceCount: allDevices.length,
            devicesConnected: connected.length,
            devicesDisconnected: notConnected.length,
            devicesPendingUpgrade: needingUpgrade.length,
            apCount: allDevices.filter((d) => d.kind === "ap").length,
            switchCount: allDevices.filter((d) => d.kind === "switch").length,
            gatewayCount: allDevices.filter((d) => d.kind === "gateway").length,
            clientCount,
            wirelessClientCount,
            wiredClientCount: clientCount - wirelessClientCount,
            guestClientCount,
            blockedClientCount,
            ssidCount,
            poeConsumptionW: poeTotal,
            devicesNotConnected: notConnected
              .map((d) => d.name || d.mac)
              .sort(),
            devicesNeedingUpgrade: needingUpgrade
              .map((d) => d.name || d.mac)
              .sort(),
            trackedInstances: tracked.map((t) => t.instanceName).sort(),
          };
          handles.push(
            await ctx.writeResource("controller", "controller", controllerBody),
          );

          ctx.logger.info(
            "{label}: {sites} site(s), {devices} device(s) " +
              "({offline} not connected), {clients} client(s), {ssids} SSID(s)",
            {
              label: ctx.globalArgs.controllerLabel,
              sites: rawSites.length,
              devices: allDevices.length,
              offline: notConnected.length,
              clients: clientCount,
              ssids: ssidCount,
            },
          );
          if (notConnected.length > 0) {
            ctx.logger.warning("{count} device(s) not connected: {names}", {
              count: notConnected.length,
              names: controllerBody.devicesNotConnected.join(", "),
            });
          }
          if (driftBody.changed) {
            ctx.logger.warning(
              "configuration drift since the last sync: {count} change(s) " +
                "({appeared} appeared, {disappeared} disappeared, " +
                "{modified} modified)",
              {
                count: driftBody.changeCount,
                appeared: driftBody.appearedCount,
                disappeared: driftBody.disappearedCount,
                modified: driftBody.modifiedCount,
              },
            );
          }

          return { dataHandles: handles };
        });
      },
    },

    rebootDevices: {
      description:
        "Reboot one or more adopted devices. Each MAC is resolved to its " +
        "site first, so a controller-wide model does not need the site named.",
      arguments: DeviceTargetArgsSchema,
      execute: (
        args: z.infer<typeof DeviceTargetArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> =>
        runMutation(
          ctx,
          "rebootDevices",
          `${args.macs.length} device(s)`,
          async (sessions, results, warn) => {
            const targets = await deviceTargets(
              sessions,
              ctx.globalArgs,
              args.siteName,
              args.macs,
              results,
              warn,
            );
            for (const device of targets) {
              await attempt(
                sessions.openApi,
                results,
                device.name || device.mac,
                "rebooted",
                "POST",
                `/sites/${device.siteId}/devices/${apiMac(device.mac)}/reboot`,
              );
            }
          },
        ),
    },

    setPoePorts: {
      description:
        "Switch PoE on or off for specific switch ports. Ports are grouped " +
        "by switch and sent through the multi-port batch endpoint, which " +
        "means one call per switch regardless of how many ports change. " +
        "Profile override is enabled first — the controller ignores a PoE " +
        "change on a port still following its profile.",
      arguments: SetPoePortsArgsSchema,
      execute: (
        args: z.infer<typeof SetPoePortsArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> =>
        runMutation(
          ctx,
          "setPoePorts",
          `${args.ports.length} port(s)`,
          async (sessions, results, warn) => {
            const sites = await resolveSites(
              sessions.openApi,
              ctx.globalArgs,
              args.siteName,
            );
            const index = await indexDevices(sessions.openApi, sites, warn);

            // Group by switch *and* by desired state: the batch endpoint sets
            // one PoE mode for the whole port list, so turning port 3 on and
            // port 5 off on the same switch is genuinely two calls.
            const groups = new Map<
              string,
              { mac: string; enabled: boolean; ports: number[] }
            >();
            for (const request of args.ports) {
              const mac = normaliseMac(request.switchMac);
              const key = `${mac}|${request.enabled}`;
              const group = groups.get(key) ??
                { mac, enabled: request.enabled, ports: [] };
              group.ports.push(request.port);
              groups.set(key, group);
            }

            for (const group of groups.values()) {
              const located = index.get(group.mac);
              const label = `${located?.name || group.mac} ports ${
                group.ports.join(",")
              }`;
              if (located === undefined) {
                results.push({
                  target: label,
                  action: "notFound",
                  ok: false,
                  message:
                    `no switch with MAC ${group.mac} is known to this controller`,
                });
                continue;
              }

              const base = `/sites/${located.siteId}/switches/${
                apiMac(located.mac)
              }/multi-ports`;
              // A port still following its profile ignores a PoE change, so
              // the override has to land first or the call succeeds and does
              // nothing — the worst possible outcome for a port toggle.
              const override = await sessions.openApi.call(
                "PUT",
                `${base}/profile-override`,
                {
                  body: {
                    portList: group.ports,
                    profileOverrideEnable: true,
                  },
                },
              );
              if (!override.ok) {
                results.push({
                  target: label,
                  action: "failed",
                  ok: false,
                  message:
                    `could not enable profile override: ${override.message}`,
                });
                continue;
              }
              await attempt(
                sessions.openApi,
                results,
                label,
                group.enabled ? "poeEnabled" : "poeDisabled",
                "PUT",
                `${base}/poe-mode`,
                { portList: group.ports, poeMode: group.enabled ? 1 : 0 },
              );
            }
          },
        ),
    },

    setClientAccess: {
      description:
        "Block or unblock clients by MAC. Blocking is the controller's own " +
        "access denial, so it survives the client reconnecting.",
      arguments: SetClientAccessArgsSchema,
      execute: (
        args: z.infer<typeof SetClientAccessArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> =>
        runMutation(
          ctx,
          "setClientAccess",
          `${args.macs.length} client(s) -> ${
            args.blocked ? "blocked" : "unblocked"
          }`,
          async (sessions, results, warn) => {
            const targets = await clientTargets(
              sessions,
              ctx.globalArgs,
              args.siteName,
              args.macs,
              results,
              warn,
            );
            const verb = args.blocked ? "block" : "unblock";
            for (const client of targets) {
              await attempt(
                sessions.openApi,
                results,
                client.name || client.mac,
                args.blocked ? "blocked" : "unblocked",
                "POST",
                `/sites/${client.siteId}/clients/${apiMac(client.mac)}/${verb}`,
              );
            }
          },
        ),
    },

    reconnectClients: {
      description:
        "Force clients to re-associate. Useful for pushing a client onto a " +
        "band or AP it should have roamed to on its own.",
      arguments: ClientTargetArgsSchema,
      execute: (
        args: z.infer<typeof ClientTargetArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> =>
        runMutation(
          ctx,
          "reconnectClients",
          `${args.macs.length} client(s)`,
          async (sessions, results, warn) => {
            const targets = await clientTargets(
              sessions,
              ctx.globalArgs,
              args.siteName,
              args.macs,
              results,
              warn,
            );
            for (const client of targets) {
              await attempt(
                sessions.openApi,
                results,
                client.name || client.mac,
                "reconnected",
                "POST",
                `/sites/${client.siteId}/clients/${
                  apiMac(client.mac)
                }/reconnect`,
              );
            }
          },
        ),
    },

    setLed: {
      description: "Turn the status LEDs on every device in a site on or off.",
      arguments: SetLedArgsSchema,
      execute: (
        args: z.infer<typeof SetLedArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> =>
        runMutation(
          ctx,
          "setLed",
          `LEDs ${args.enabled ? "on" : "off"} in ${
            args.siteName ?? "every site"
          }`,
          async (sessions, results) => {
            const sites = await resolveSites(
              sessions.openApi,
              ctx.globalArgs,
              args.siteName,
            );
            for (const site of sites) {
              await attempt(
                sessions.openApi,
                results,
                site.siteName,
                args.enabled ? "ledOn" : "ledOff",
                "PUT",
                `/sites/${site.siteId}/led`,
                { enable: args.enabled },
              );
            }
          },
        ),
    },

    locateDevices: {
      description:
        "Start or stop the locate flash on specific devices — the physical " +
        "way to find which box in the rack is which.",
      arguments: LocateArgsSchema,
      execute: (
        args: z.infer<typeof LocateArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> =>
        runMutation(
          ctx,
          "locateDevices",
          `${args.macs.length} device(s), locate ${
            args.enabled ? "on" : "off"
          }`,
          async (sessions, results, warn) => {
            const targets = await deviceTargets(
              sessions,
              ctx.globalArgs,
              args.siteName,
              args.macs,
              results,
              warn,
            );
            for (const device of targets) {
              await attempt(
                sessions.openApi,
                results,
                device.name || device.mac,
                args.enabled ? "locating" : "locateStopped",
                "POST",
                `/sites/${device.siteId}/devices/${apiMac(device.mac)}/locate`,
                { locateEnable: args.enabled },
              );
            }
          },
        ),
    },

    upgradeFirmware: {
      description:
        "Start an online firmware upgrade on specific devices. The " +
        "controller downloads and applies the update asynchronously — this " +
        "returns once the upgrade has been accepted, not once it is done. " +
        "Devices reboot as part of the upgrade.",
      arguments: DeviceTargetArgsSchema,
      execute: (
        args: z.infer<typeof DeviceTargetArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> =>
        runMutation(
          ctx,
          "upgradeFirmware",
          `${args.macs.length} device(s)`,
          async (sessions, results, warn) => {
            const targets = await deviceTargets(
              sessions,
              ctx.globalArgs,
              args.siteName,
              args.macs,
              results,
              warn,
            );
            for (const device of targets) {
              await attempt(
                sessions.openApi,
                results,
                device.name || device.mac,
                "upgradeStarted",
                "POST",
                `/sites/${device.siteId}/devices/${
                  apiMac(device.mac)
                }/start-online-upgrade`,
              );
            }
          },
        ),
    },
  },
};
