/**
 * Reading one controller's whole inventory.
 *
 * Collection is separated from the model so the degradation policy lives in
 * one place. Omada's endpoint set is not uniform: `switch-detail` is missing
 * on older 5.x builds, `wan-status` only answers for a gateway that has one,
 * a site with no APs has no `wlans` collection, and the Open API returns
 * bare arrays for small collections but paged envelopes for large ones. A
 * sync that threw on the first absent endpoint would be useless on half the
 * controllers in the wild.
 *
 * So optional collections degrade: a failed read logs a warning naming the
 * endpoint and yields nothing, and the sync completes with the rest. The two
 * things that cannot degrade are authentication and the site list — without
 * them there is no inventory to report, and returning an empty one would be a
 * lie rather than a partial answer.
 *
 * @module
 */
import {
  fetchOmadacId,
  OmadaError,
  OpenApiSession,
  type TransportOptions,
  WebApiSession,
} from "./client.ts";
import { apiMac, arr, num, type Raw, str } from "./map.ts";
import { type GlobalArgs, withDefaults } from "./schemas.ts";

/** Structured warning sink, satisfied by swamp's logger. */
export type Warn = (message: string, props?: Record<string, unknown>) => void;

/** Live sessions against one controller. */
export interface Sessions {
  /** The mandatory northbound session; every read and write goes through it. */
  openApi: OpenApiSession;
  /** Present only when web credentials were supplied and accepted. */
  webApi: WebApiSession | null;
  /** Controller id, discovered or configured. */
  omadacId: string;
  /** Controller version; empty when `omadacId` was configured explicitly. */
  controllerVersion: string;
  /** Release both transports' TLS clients. */
  close: () => void;
}

/** Everything read for one site. */
export interface SiteBundle {
  /** Raw device records, one per adopted AP, switch and gateway. */
  devices: Raw[];
  /** Raw client records; empty when clients were not requested. */
  clients: Raw[];
  /** One self-describing row per switch port; carries its own switch MAC. */
  ports: Raw[];
  /** WAN entries keyed by the gateway they belong to. */
  wans: Array<{ parent: { mac: string; name: string }; entries: Raw[] }>;
  /** SSID entries paired with the WLAN group id they came from. */
  ssids: Array<{ wlanId: string; entry: Raw }>;
  /** Site-wide LED override; null when the controller does not report one. */
  ledEnabled: boolean | null;
  /** Site PoE draw in watts; null when no switch reports it. */
  poeConsumptionW: number | null;
}

/** Build the transport options shared by both sessions. */
function transportOptions(g: GlobalArgs): TransportOptions {
  return {
    baseUrl: g.baseUrl,
    requestTimeoutSec: g.requestTimeoutSec,
    caCertPem: g.caCertPem,
  };
}

/**
 * Establish whichever sessions the supplied credentials allow.
 *
 * The Open API session is mandatory — it is the read path for everything the
 * extension reports. The web session is opened only when both a username and
 * a password are present, and a failure to open it is a warning rather than
 * an error: it exists to add optional detail, so losing it should degrade the
 * sync, not fail it.
 */
export async function openSessions(
  rawArgs: GlobalArgs,
  warn: Warn,
): Promise<Sessions> {
  // Checks receive unparsed global args, so defaults are not applied for us.
  const g = withDefaults(rawArgs);
  const opts = transportOptions(g);

  if (!g.clientId || !g.clientSecret) {
    throw new OmadaError(
      "no Open API credentials — set `clientId` and `clientSecret` from an " +
        "application created under Settings > Platform Integration > Open API",
      { path: "/openapi/authorize/token" },
    );
  }

  let omadacId = g.omadacId ?? "";
  let controllerVersion = "";
  if (omadacId === "") {
    const info = await fetchOmadacId(opts);
    omadacId = info.omadacId;
    controllerVersion = info.controllerVersion;
  }

  const openApi = new OpenApiSession(
    opts,
    { clientId: g.clientId, clientSecret: g.clientSecret },
    omadacId,
  );
  try {
    await openApi.login();
  } catch (err) {
    openApi.close();
    throw err;
  }

  let webApi: WebApiSession | null = null;
  if (g.username && g.password) {
    const candidate = new WebApiSession(
      opts,
      { username: g.username, password: g.password },
      omadacId,
    );
    try {
      await candidate.login();
      webApi = candidate;
    } catch (err) {
      candidate.close();
      warn(
        "web API login failed — continuing with Open API only. {reason}",
        { reason: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  return {
    openApi,
    webApi,
    omadacId,
    controllerVersion,
    close: () => {
      openApi.close();
      webApi?.close();
    },
  };
}

/**
 * Read an optional collection, degrading to nothing on failure.
 *
 * Every collection goes through the paginated path, including the ones that
 * answer with a bare array. Which endpoints *require* `page` is not knowable
 * from the shape they return: on controller 6.x `/wireless-network/wlans`
 * answers fine without it and `/wireless-network/wlans/{id}/ssids` returns a
 * bare HTTP 400, and the same split exists between `switch-detail` and
 * `/devices`. Since `listAll` returns a bare array untouched and the
 * array-returning endpoints all tolerate the extra query parameters, sending
 * them unconditionally is the one behaviour that works everywhere — and it
 * removes a class of bug where a 400 reads as "this site has no SSIDs".
 *
 * The warning names the endpoint rather than just the failure, because the
 * common cause is a controller build that never had it — and "reporting no
 * switch ports" must never look like "this switch has no ports".
 */
async function optional(
  session: OpenApiSession,
  path: string,
  label: string,
  warn: Warn,
  opts: {
    query?: Record<string, string | number | undefined>;
    apiVersion?: "v1" | "v2";
  } = {},
): Promise<Raw[]> {
  try {
    return await session.listAll<Raw>(path, {
      query: opts.query,
      apiVersion: opts.apiVersion,
    });
  } catch (err) {
    warn("could not read {label} — reporting none. {reason}", {
      label,
      reason: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Read a single object endpoint, degrading to null on failure. */
async function optionalOne(
  session: OpenApiSession,
  path: string,
  label: string,
  warn: Warn,
  opts: { apiVersion?: "v1" | "v2" } = {},
): Promise<Raw | null> {
  const outcome = await session.call("GET", path, {
    apiVersion: opts.apiVersion,
  });
  if (!outcome.ok) {
    warn("could not read {label} — skipping. {reason}", {
      label,
      reason: outcome.message,
    });
    return null;
  }
  const result = (outcome.body as { result?: unknown })?.result;
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? result as Raw
    : null;
}

/**
 * List the sites this controller manages, honouring `siteFilter`.
 *
 * A filter that matches nothing throws rather than syncing zero sites: it is
 * almost always a typo in a site name, and an empty-but-successful sync would
 * quietly wipe the previous inventory's drift baseline.
 */
export async function listSites(
  session: OpenApiSession,
  filter: string[],
): Promise<Raw[]> {
  const sites = await session.listAll<Raw>("/sites");
  if (filter.length === 0) return sites;

  const wanted = new Set(filter.map((f) => f.toLowerCase()));
  const matched = sites.filter((s) => wanted.has(str(s, "name").toLowerCase()));
  if (matched.length === 0) {
    const available = sites.map((s) => str(s, "name")).sort().join(", ");
    throw new OmadaError(
      `siteFilter matched no sites. Available: ${available || "(none)"}`,
      { path: "/sites" },
    );
  }
  return matched;
}

/** Read everything the extension reports for one site. */
export async function collectSite(
  session: OpenApiSession,
  siteId: string,
  siteName: string,
  opts: {
    includeClients: boolean;
    includePorts: boolean;
    includeSsids: boolean;
  },
  warn: Warn,
): Promise<SiteBundle> {
  const base = `/sites/${siteId}`;

  // Devices are read first and unconditionally: the port, WAN and SSID reads
  // are all scoped to a device or a WLAN group discovered here.
  //
  // `page` is mandatory here — controller 6.x answers a request without it
  // with a bare HTTP 400 carrying no Omada envelope at all, which reads as
  // "site has no devices" rather than as the malformed request it is.
  const devices = await optional(
    session,
    `${base}/devices`,
    `devices for site ${siteName}`,
    warn,
  );

  // Clients live on v1. Controller 6.x answers `/openapi/v2/.../clients` with
  // 405 Method Not Allowed; only older builds exposed the v2 spelling.
  const clients = opts.includeClients
    ? await optional(
      session,
      `${base}/clients`,
      `clients for site ${siteName}`,
      warn,
    )
    : [];

  // `poe-info` is the port source rather than `switch-detail`, despite the
  // PoE-centric name: it returns one self-describing row per physical port
  // (all 28 on a 24-port switch, SFP cages included) carrying the switch's own
  // MAC and name, admin state, PoE capability and draw, and a nested
  // `portStatus` with link, speed, duplex and byte counters. `switch-detail`
  // returns one row per *switch* with no port list at all on 6.x, so it cannot
  // answer "is port 5 still powered".
  const ports: SiteBundle["ports"] = opts.includePorts &&
      devices.some((d) => str(d, "type").toLowerCase() === "switch")
    ? await optional(
      session,
      `${base}/switches/ports/poe-info`,
      `switch ports for site ${siteName}`,
      warn,
    )
    : [];

  const wans: SiteBundle["wans"] = [];
  for (const gw of devices) {
    if (str(gw, "type").toLowerCase() !== "gateway") continue;
    const mac = str(gw, "mac");
    const status = await optionalOne(
      session,
      `${base}/gateways/${apiMac(mac)}/wan-status`,
      `WAN status for gateway ${str(gw, "name") || mac}`,
      warn,
    );
    if (status === null) continue;
    // The payload is either a list of ports or a single port object.
    const entries = arr(status, "portStats", "wanPortStats", "portList");
    wans.push({
      parent: { mac, name: str(gw, "name") },
      entries: entries.length > 0 ? entries : [status],
    });
  }

  const ssids: SiteBundle["ssids"] = [];
  if (opts.includeSsids) {
    const wlans = await optional(
      session,
      `${base}/wireless-network/wlans`,
      `WLAN groups for site ${siteName}`,
      warn,
    );
    for (const wlan of wlans) {
      const wlanId = str(wlan, "id", "wlanId");
      if (wlanId === "") continue;
      const entries = await optional(
        session,
        `${base}/wireless-network/wlans/${wlanId}/ssids`,
        `SSIDs in WLAN group ${str(wlan, "name") || wlanId}`,
        warn,
      );
      for (const entry of entries) ssids.push({ wlanId, entry });
    }
  }

  const led = await optionalOne(
    session,
    `${base}/led`,
    `LED setting for site ${siteName}`,
    warn,
  );
  const ledValue = led === null ? null : led.enable;
  const ledEnabled = typeof ledValue === "boolean"
    ? ledValue
    : typeof ledValue === "number"
    ? ledValue !== 0
    : null;

  // `poe-usage` returns a bare array with one entry per PoE-capable switch,
  // each reporting its own `totalPowerUsed` — there is no site-wide total to
  // read, so the site figure is the sum. Null when nothing reported, so "no
  // PoE switches" stays distinguishable from "drawing zero watts".
  const poeRows = await optional(
    session,
    `${base}/dashboard/poe-usage`,
    `PoE usage for site ${siteName}`,
    warn,
  );
  let poeConsumptionW: number | null = null;
  for (const row of poeRows) {
    const used = num(row, ["totalPowerUsed", "totalPower"]);
    if (used !== null) poeConsumptionW = (poeConsumptionW ?? 0) + used;
  }

  return { devices, clients, ports, wans, ssids, ledEnabled, poeConsumptionW };
}
