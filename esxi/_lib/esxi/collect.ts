/**
 * Remote collection script and the parsers for its output.
 *
 * One SSH round trip runs one script that emits every section the inventory
 * needs, delimited by sentinel lines. All parsing happens here, in TypeScript,
 * where it is testable — the remote side only concatenates command output and
 * never has to build JSON in busybox `ash`.
 *
 * Three sources, because a rebuild needs more than the virtual hardware:
 *
 *   - the **vmx**, captured whole, for every configured knob;
 *   - **`vim-cmd vmsvc/get.guest`**, for what only the running guest knows —
 *     addressing, DNS, default route, mounted filesystems and their fill;
 *   - **`vim-cmd vmsvc/get.summary`**, for power state, live resource usage,
 *     and committed storage.
 *
 * Where the vmx and `vim-cmd` overlap on configured values the vmx wins — it is
 * authoritative and is plain `key = "value"` text rather than a nested vim
 * struct. Where they do not overlap, `get.guest` is the only source: the vmx
 * knows a NIC exists, but not what IP the OS put on it.
 *
 * @module
 */

/** Sentinel that opens every section of the remote script's output. */
export const SECTION = "@@@SWAMP-SECTION@@@";

// ---------------------------------------------------------------------------
// Remote script
// ---------------------------------------------------------------------------

/**
 * Build the shell script executed on the ESXi host.
 *
 * Nothing user-supplied is interpolated — `includeDiskDetail` only selects
 * between two constant branches — so the script carries no injection surface.
 */
export function buildScript(includeDiskDetail: boolean): string {
  return `
S() { printf '%s %s\\n' '${SECTION}' "$1"; }

S host.hostname
hostname 2>/dev/null
S host.version
esxcli --formatter=xml system version get 2>&1
S host.platform
esxcli --formatter=xml hardware platform get 2>&1
S host.cpu
esxcli --formatter=xml hardware cpu global get 2>&1
S host.cpulist
esxcli --formatter=xml hardware cpu list 2>&1
S host.memory
esxcli --formatter=xml hardware memory get 2>&1
S host.filesystems
esxcli --formatter=xml storage filesystem list 2>&1
S host.portgroups
esxcli --formatter=xml network vswitch standard portgroup list 2>&1
S host.nics
esxcli --formatter=xml network nic list 2>&1
S host.summary
vim-cmd hostsvc/hostsummary 2>/dev/null
S host.autostart
vim-cmd hostsvc/autostartmanager/get_autostartseq 2>/dev/null

# First column of getallvms is the vmid. Selecting it by regex rather than by
# column position keeps guest names containing spaces from shifting the parse.
IDS=\`vim-cmd vmsvc/getallvms 2>/dev/null | awk '{print $1}' | grep '^[0-9][0-9]*$'\`

for id in $IDS; do
  S "vm.$id.summary"
  vim-cmd vmsvc/get.summary "$id" 2>/dev/null
  S "vm.$id.snapshot"
  vim-cmd vmsvc/get.snapshotinfo "$id" 2>/dev/null
  S "vm.$id.guest"
  vim-cmd vmsvc/get.guest "$id" 2>/dev/null

  vmx=\`vim-cmd vmsvc/get.summary "$id" 2>/dev/null | sed -n 's/.*vmPathName = "\\(.*\\)".*/\\1/p' | head -1\`
  ds=\`echo "$vmx" | sed -n 's/^\\[\\([^]]*\\)\\].*/\\1/p'\`
  rel=\`echo "$vmx" | sed -n 's/^\\[[^]]*\\] *//p'\`
  [ -n "$ds" ] || continue
  abs="/vmfs/volumes/$ds/$rel"
  [ -f "$abs" ] || continue

  S "vm.$id.vmxpath"
  echo "$abs"
  S "vm.$id.vmx"
  cat "$abs" 2>/dev/null
${includeDiskDetail ? DISK_DETAIL_BLOCK : ""}
done
`;
}

/**
 * Per-guest disk sizing. Split out because it is the expensive half — a stat
 * walk of every guest folder — and the caller can turn it off.
 *
 * Only descriptor vmdks are read. The `-flat`/`-delta`/`-sesparse` files are
 * raw disk data, often hundreds of gigabytes, and must never be `cat`-ed;
 * `head -c` bounds the read as a second line of defence.
 */
const DISK_DETAIL_BLOCK = `
  dir=\`dirname "$abs"\`
  S "vm.$id.ls"
  ls -l "$dir" 2>/dev/null
  S "vm.$id.du"
  du -ak "$dir" 2>/dev/null
  for d in "$dir"/*.vmdk; do
    case "$d" in
      *-flat.vmdk|*-delta.vmdk|*-sesparse.vmdk|*-ctk.vmdk|*-rdm.vmdk|*-rdmp.vmdk) continue ;;
    esac
    [ -f "$d" ] || continue
    S "vm.$id.vmdk $d"
    head -c 4096 "$d" 2>/dev/null
    echo
  done`;

// ---------------------------------------------------------------------------
// Section splitting
// ---------------------------------------------------------------------------

/**
 * Split raw stdout into `name → body`. A section name may carry one argument
 * after a space (the vmdk path); it is kept as part of the key.
 */
export function parseSections(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith(SECTION + " ")) {
      if (current !== null) out.set(current, buf.join("\n").trim());
      current = line.slice(SECTION.length + 1).trim();
      buf = [];
      continue;
    }
    if (current !== null) buf.push(line);
  }
  if (current !== null) out.set(current, buf.join("\n").trim());
  return out;
}

/** `JSON.parse` that yields null instead of throwing on empty/garbage input. */
export function parseJsonSection(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Expand the five XML predefined entities. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse esxcli's XML output into one record per `<structure>`.
 *
 * **Why XML and not JSON:** the `json` formatter only exists from ESXi 7.0 —
 * 6.7 answers `Unable to find requested formatter: json` and the whole host
 * section silently comes back empty. The `xml` formatter has been present since
 * 5.0 and uses the same human-readable field names ("Volume Name", "MAC
 * Address"), so it works across every version this model is likely to meet.
 *
 * A `get` command yields one structure, a `list` command yields several. Field
 * values are typed by their element name, so numbers arrive as numbers.
 */
export function parseEsxcliXml(
  text: string | undefined,
): Record<string, unknown>[] {
  if (!text) return [];
  const out: Record<string, unknown>[] = [];
  for (const chunk of text.split(/<structure\b/).slice(1)) {
    // Bound each record at its own closing tag so a nested structure cannot
    // bleed its fields into the parent.
    const body = chunk.split("</structure>")[0];
    const record: Record<string, unknown> = {};
    const field =
      /<field name="([^"]*)">\s*<(string|integer|long|double|float|boolean)>([\s\S]*?)<\/\2>/g;
    let m: RegExpExecArray | null;
    while ((m = field.exec(body)) !== null) {
      const [, name, type, raw] = m;
      const value = decodeXmlEntities(raw);
      record[name] = type === "boolean"
        ? value.trim() === "true"
        : type === "string"
        ? value
        : Number(value);
    }
    if (Object.keys(record).length > 0) out.push(record);
  }
  return out;
}

// ---------------------------------------------------------------------------
// vim struct field extraction
// ---------------------------------------------------------------------------

/**
 * First `key = "value"` (or `key = <number>`) in a vim struct dump.
 *
 * A full vim-struct parser is not worth building: the handful of fields worth
 * taking from `vim-cmd` are all scalars, and the vmx covers the structured
 * config far more cleanly.
 */
export function vimField(text: string, key: string): string | undefined {
  const q = new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(text);
  if (q) return q[1];
  const n = new RegExp(`\\b${key}\\s*=\\s*([0-9]+)`).exec(text);
  return n ? n[1] : undefined;
}

/**
 * Values of a vim string array: `key = (string) [ "a", "b" ]`.
 *
 * Used for DNS servers, search domains, and a NIC's address list — all places
 * where the count is not knowable in advance.
 */
export function vimStringList(text: string, key: string): string[] {
  const start = new RegExp(`\\b${key}\\s*=\\s*\\(string\\)\\s*\\[`).exec(text);
  if (!start) return [];
  const from = start.index + start[0].length;
  const end = text.indexOf("]", from);
  if (end < 0) return [];
  const body = text.slice(from, end);
  return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter((s) =>
    s !== ""
  );
}

/**
 * Split a vim struct dump into the blocks introduced by `marker`.
 *
 * Nested arrays of the same type terminate a block early (the split cuts at
 * every occurrence), which is exactly what we want: a child block is a separate
 * entry, not part of its parent.
 */
export function vimBlocks(text: string, marker: string): string[] {
  return text.split(marker).slice(1);
}

/** One in-guest NIC as VMware Tools reports it. */
export interface GuestNicInfo {
  network?: string;
  macAddress?: string;
  connected: boolean;
  ipAddresses: { address: string; prefixLength?: number }[];
}

/** One mounted filesystem as VMware Tools reports it. */
export interface GuestDiskInfo {
  mountPoint: string;
  capacityBytes?: number;
  freeBytes?: number;
  filesystemType?: string;
}

/** Everything `vim-cmd vmsvc/get.guest` yields about the running OS. */
export interface GuestInfo {
  hostName?: string;
  domainName?: string;
  guestState?: string;
  guestFamily?: string;
  toolsVersion?: string;
  toolsRunningStatus?: string;
  primaryIp?: string;
  dnsServers: string[];
  searchDomains: string[];
  defaultGateway?: string;
  nics: GuestNicInfo[];
  filesystems: GuestDiskInfo[];
}

/**
 * Parse `vim-cmd vmsvc/get.guest`.
 *
 * Everything here is absent when VMware Tools is not running — a powered-off
 * guest yields an almost-empty struct. That is itself worth knowing, so the
 * function returns partial data rather than failing.
 */
export function parseGuestInfo(text: string | undefined): GuestInfo {
  const info: GuestInfo = {
    dnsServers: [],
    searchDomains: [],
    nics: [],
    filesystems: [],
  };
  if (!text) return info;

  info.guestState = vimField(text, "guestState");
  info.guestFamily = vimField(text, "guestFamily");
  info.toolsVersion = vimField(text, "toolsVersion");
  info.toolsRunningStatus = vimField(text, "toolsRunningStatus");
  info.primaryIp = vimField(text, "ipAddress");

  // --- NICs ---------------------------------------------------------------
  for (const block of vimBlocks(text, "(vim.vm.GuestInfo.NicInfo)")) {
    const macAddress = vimField(block, "macAddress");
    const network = vimField(block, "network");
    if (macAddress === undefined && network === undefined) continue;
    const ipAddresses: { address: string; prefixLength?: number }[] = [];
    // The structured IpAddress entries carry prefix lengths; the flat
    // `ipAddress = (string) [...]` list does not. Prefer the structured form
    // and fall back so an older Tools build still yields addresses.
    for (
      const ipBlock of vimBlocks(block, "(vim.net.IpConfigInfo.IpAddress)")
    ) {
      const address = vimField(ipBlock, "ipAddress");
      if (!address) continue;
      const prefix = vimField(ipBlock, "prefixLength");
      ipAddresses.push({
        address,
        prefixLength: prefix === undefined ? undefined : Number(prefix),
      });
    }
    if (ipAddresses.length === 0) {
      for (const address of vimStringList(block, "ipAddress")) {
        ipAddresses.push({ address });
      }
    }
    info.nics.push({
      network,
      macAddress,
      connected: /\bconnected\s*=\s*true/.test(block),
      ipAddresses,
    });
  }

  // --- DNS ----------------------------------------------------------------
  const dns = vimBlocks(text, "(vim.net.DnsConfigInfo)")[0];
  if (dns) {
    info.hostName = vimField(dns, "hostName");
    info.domainName = vimField(dns, "domainName");
    info.dnsServers = vimStringList(dns, "ipAddress");
    info.searchDomains = vimStringList(dns, "searchDomain");
  }
  // hostName also appears at the top level, fully qualified. Prefer the DNS
  // block's short name only when the top-level one is missing.
  info.hostName = vimField(text, "hostName") ?? info.hostName;

  // --- default route ------------------------------------------------------
  for (const route of vimBlocks(text, "(vim.net.IpRouteConfigInfo.IpRoute)")) {
    const network = vimField(route, "network");
    const prefix = vimField(route, "prefixLength");
    const isDefault = (network === "0.0.0.0" && prefix === "0") ||
      (network === "::" && prefix === "0");
    if (!isDefault) continue;
    const gw = vimBlocks(route, "(vim.net.IpRouteConfigInfo.Gateway)")[0];
    const address = gw ? vimField(gw, "ipAddress") : undefined;
    if (address) {
      info.defaultGateway = address;
      break;
    }
  }

  // --- mounted filesystems ------------------------------------------------
  for (const block of vimBlocks(text, "(vim.vm.GuestInfo.DiskInfo)")) {
    const mountPoint = vimField(block, "diskPath");
    if (!mountPoint) continue;
    const capacity = vimField(block, "capacity");
    const free = vimField(block, "freeSpace");
    info.filesystems.push({
      mountPoint,
      capacityBytes: capacity === undefined ? undefined : Number(capacity),
      freeBytes: free === undefined ? undefined : Number(free),
      filesystemType: vimField(block, "filesystemType"),
    });
  }

  return info;
}

/** Live resource usage from the summary's QuickStats block. */
export interface QuickStats {
  overallCpuUsageMhz?: number;
  guestMemoryUsageMib?: number;
  hostMemoryUsageMib?: number;
  uptimeSeconds?: number;
  heartbeat?: string;
}

/**
 * Parse QuickStats.
 *
 * This is the rightsizing evidence: a guest declared at 8192 MiB that has never
 * touched more than 1500 is a guest to rebuild smaller, and only the live
 * figures say so.
 */
export function parseQuickStats(text: string | undefined): QuickStats {
  const block = text
    ? vimBlocks(text, "(vim.vm.Summary.QuickStats)")[0]
    : undefined;
  if (!block) return {};
  const n = (k: string) => {
    const v = vimField(block, k);
    return v === undefined ? undefined : Number(v);
  };
  return {
    overallCpuUsageMhz: n("overallCpuUsage"),
    guestMemoryUsageMib: n("guestMemoryUsage"),
    hostMemoryUsageMib: n("hostMemoryUsage"),
    uptimeSeconds: n("uptimeSeconds"),
    heartbeat: vimField(block, "guestHeartbeatStatus"),
  };
}

/** Datastore bytes the guest actually occupies, per the host's own accounting. */
export function parseStorageSummary(
  text: string | undefined,
): { committedBytes?: number; uncommittedBytes?: number } {
  const block = text
    ? vimBlocks(text, "(vim.vm.Summary.StorageSummary)")[0]
    : undefined;
  if (!block) return {};
  const committed = vimField(block, "committed");
  const uncommitted = vimField(block, "uncommitted");
  return {
    committedBytes: committed === undefined ? undefined : Number(committed),
    uncommittedBytes: uncommitted === undefined
      ? undefined
      : Number(uncommitted),
  };
}

/** Snapshot entries from `vim-cmd vmsvc/get.snapshotinfo`. */
export function parseSnapshotInfo(
  text: string | undefined,
): { id?: string; name?: string; description?: string; createTime?: string }[] {
  if (!text) return [];
  const blocks = text.split("(vim.vm.SnapshotTree)").slice(1);
  const out: {
    id?: string;
    name?: string;
    description?: string;
    createTime?: string;
  }[] = [];
  for (const b of blocks) {
    const name = vimField(b, "name");
    // A SnapshotTree with no name is the array header, not a snapshot.
    if (name === undefined) continue;
    out.push({
      id: vimField(b, "id"),
      name,
      description: vimField(b, "description"),
      createTime: vimField(b, "createTime"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// vmx parsing
// ---------------------------------------------------------------------------

/** Parse a `.vmx` into a flat key→value map. Keys are lowercased. */
export function parseVmx(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** True for vmx boolean spellings (`TRUE`, `true`, `1`). */
export function vmxBool(v: string | undefined): boolean {
  return v !== undefined && /^(true|1)$/i.test(v.trim());
}

// ---------------------------------------------------------------------------
// vmdk descriptor + filesystem output
// ---------------------------------------------------------------------------

export interface VmdkInfo {
  provisionedBytes?: number;
  provisioning?: string;
  /** Data files the descriptor points at, relative to the descriptor's dir. */
  extents: string[];
}

/**
 * Parse a vmdk descriptor. Extent lines look like:
 * `RW 41943040 VMFS "guest-flat.vmdk"` — the count is 512-byte sectors.
 */
export function parseVmdkDescriptor(text: string | undefined): VmdkInfo {
  const info: VmdkInfo = { extents: [] };
  if (!text) return info;
  let sectors = 0;
  const re = /^\s*(RW|RDONLY|NOACCESS)\s+(\d+)\s+(\S+)\s+"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    sectors += Number(m[2]);
    info.extents.push(m[4]);
  }
  if (sectors > 0) info.provisionedBytes = sectors * 512;

  const createType = /createType\s*=\s*"([^"]+)"/.exec(text)?.[1];
  const thin = /ddb\.thinProvisioned\s*=\s*"1"/.test(text);
  if (thin) info.provisioning = "thin";
  else if (createType) info.provisioning = createType;
  return info;
}

/** Filename → size in bytes, from busybox `ls -l` output. */
export function parseLsLong(text: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!text) return out;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("total ")) continue;
    // perms links owner group size <date fields> name — the name may contain
    // spaces, so take everything after the 8th whitespace-delimited field.
    const m =
      /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/
        .exec(line);
    if (!m) continue;
    out.set(m[7].trim(), Number(m[5]));
  }
  return out;
}

/**
 * Path → allocated bytes, from `du -ak <dir>` (kibibytes in column 1).
 *
 * `du` is used rather than `ls` because a thin disk's `-flat.vmdk` reports its
 * full provisioned size to `ls` while occupying far less on the datastore.
 * Provisioned-vs-allocated is exactly the distinction that decides how long a
 * migration copy takes, so both are recorded. The directory's own entry is the
 * folder total.
 */
export function parseDuAll(text: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!text) return out;
  for (const raw of text.split("\n")) {
    const m = /^(\d+)\s+(.+)$/.exec(raw.trim());
    if (!m) continue;
    out.set(m[2].trim(), Number(m[1]) * 1024);
  }
  return out;
}

/**
 * vmids configured to power on with the host, from `get_autostartseq`.
 *
 * The `key` field is a managed object reference in single quotes
 * (`key = 'vim.VirtualMachine:3'`) rather than a plain quoted string, so it
 * needs its own regex — {@link vimField} only handles double-quoted scalars.
 */
export function parseAutostart(text: string | undefined): Set<string> {
  const ids = new Set<string>();
  if (!text) return ids;
  const blocks = text.split("(vim.host.AutoStartManager.AutoPowerInfo)").slice(
    1,
  );
  for (const b of blocks) {
    const action = vimField(b, "startAction");
    if (!action || action.toLowerCase() === "none") continue;
    const key = /\bkey\s*=\s*'vim\.VirtualMachine:(\d+)'/.exec(b);
    if (key) ids.add(key[1]);
  }
  return ids;
}
