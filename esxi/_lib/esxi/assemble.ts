/**
 * Turn the parsed sections of a collection run into `vm` and `host` records.
 *
 * This layer holds the judgement calls — which source wins for a given field,
 * what counts as a migration blocker — and is pure: sections in, records out,
 * no I/O. That keeps the interesting logic testable without an ESXi host.
 *
 * @module
 */

import {
  parseAutostart,
  parseDuAll,
  parseEsxcliXml,
  parseGuestInfo,
  parseLsLong,
  parseQuickStats,
  parseSnapshotInfo,
  parseStorageSummary,
  parseVmdkDescriptor,
  parseVmx,
  vimField,
  vmxBool,
} from "./collect.ts";
import type {
  Disk,
  Host,
  Nic,
  PassthroughDevice,
  ResourceAllocation,
  Vm,
} from "./schemas.ts";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Directory part of an absolute POSIX path. */
export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/**
 * Resolve a vmx disk reference to an absolute path.
 *
 * Three spellings occur: datastore-bracketed (`[ds1] guest/guest.vmdk`),
 * absolute, and relative to the vmx's own directory (the common case).
 */
export function resolveDiskPath(
  fileName: string,
  vmxPath: string | undefined,
): string | undefined {
  const bracket = /^\[([^\]]*)\]\s*(.*)$/.exec(fileName);
  if (bracket) {
    const ds = bracket[1].trim();
    const rel = bracket[2].trim();
    return ds === "" ? undefined : `/vmfs/volumes/${ds}/${rel}`;
  }
  if (fileName.startsWith("/")) return fileName;
  if (!vmxPath) return undefined;
  return `${dirname(vmxPath)}/${fileName}`;
}

/** Datastore name from an absolute `/vmfs/volumes/<ds>/...` path. */
export function datastoreOf(absPath: string | undefined): string | undefined {
  if (!absPath) return undefined;
  const m = /^\/vmfs\/volumes\/([^/]+)\//.exec(absPath);
  return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// Device extraction from the vmx
// ---------------------------------------------------------------------------

/** Backings that are removable media, not disks worth migrating. */
function isRemovableMedia(deviceType: string, fileName: string): boolean {
  const dt = deviceType.toLowerCase();
  const fn = fileName.toLowerCase();
  return dt.includes("cdrom") || dt.includes("atapi") ||
    dt.includes("floppy") || fn.endsWith(".iso") || fn.endsWith(".flp") ||
    fn === "emptybackingstring" || fn === "auto detect" || fn === "";
}

/** Extract virtual disks from a parsed vmx. */
export function extractDisks(
  vmx: Record<string, string>,
  vmxPath: string | undefined,
): Disk[] {
  const disks: Disk[] = [];
  for (const key of Object.keys(vmx)) {
    const m = /^((?:scsi|sata|ide|nvme)\d+):(\d+)\.filename$/.exec(key);
    if (!m) continue;
    const controllerKey = m[1];
    const device = `${controllerKey}:${m[2]}`;
    if (
      vmx[`${device}.present`] !== undefined &&
      !vmxBool(vmx[`${device}.present`])
    ) continue;

    const fileName = vmx[key] ?? "";
    const deviceType = vmx[`${device}.devicetype`] ?? "";
    if (isRemovableMedia(deviceType, fileName)) continue;

    const resolvedPath = resolveDiskPath(fileName, vmxPath);
    const isRdm = deviceType.toLowerCase().includes("rdm") ||
      /-rdmp?\.vmdk$/i.test(fileName);

    disks.push({
      device,
      fileName,
      resolvedPath,
      isRawDeviceMapping: isRdm,
      controller: vmx[`${controllerKey}.virtualdev`],
      mode: vmx[`${device}.mode`],
      busSharing: vmx[`${controllerKey}.sharedbus`],
      changeBlockTracking: vmxBool(vmx[`${device}.ctkenabled`]),
    });
  }
  return disks.sort((a, b) => a.device.localeCompare(b.device));
}

/**
 * Devices that tie a guest to this specific host.
 *
 * PCI passthrough is the hard case — the device is physically in the ESXi box,
 * so a rebuild elsewhere either finds equivalent hardware or does without.
 * Serial and USB backings are softer but still need a deliberate decision.
 */
export function extractPassthrough(
  vmx: Record<string, string>,
): PassthroughDevice[] {
  const out: PassthroughDevice[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(vmx)) {
    const m = /^(pcipassthru\d+|serial\d+|parallel\d+|usb_xhci|usb)\./.exec(
      key,
    );
    if (!m) continue;
    const device = m[1];
    if (seen.has(device)) continue;
    seen.add(device);
    if (!vmxBool(vmx[`${device}.present`])) continue;

    const kind = device.startsWith("pcipassthru")
      ? "pci-passthrough"
      : device.startsWith("serial")
      ? "serial-port"
      : device.startsWith("parallel")
      ? "parallel-port"
      : "usb-controller";
    out.push({
      device,
      kind,
      backing: vmx[`${device}.id`] ?? vmx[`${device}.filename`] ??
        vmx[`${device}.devicename`] ?? vmx[`${device}.filetype`],
    });
  }
  return out.sort((a, b) => a.device.localeCompare(b.device));
}

/** Reservations, limits, shares, and hot-add flags from the vmx. */
export function extractResourceAllocation(
  vmx: Record<string, string>,
): ResourceAllocation {
  const memReservation = num(vmx["sched.mem.min"]);
  const memSize = num(vmx["memsize"]);
  return {
    cpuReservationMhz: num(vmx["sched.cpu.min"]),
    cpuLimitMhz: num(vmx["sched.cpu.max"]),
    cpuShares: vmx["sched.cpu.shares"],
    memoryReservationMib: memReservation,
    memoryLimitMib: num(vmx["sched.mem.max"]),
    memoryShares: vmx["sched.mem.shares"],
    // "Reserve all guest memory" shows up either as an explicit pin or as a
    // reservation equal to the configured size.
    memoryReservedAll: vmxBool(vmx["sched.mem.pin"]) ||
      (memReservation !== undefined && memSize !== undefined &&
        memReservation >= memSize),
    cpuHotAdd: vmxBool(vmx["vcpu.hotadd"]),
    memoryHotAdd: vmxBool(vmx["mem.hotadd"]),
  };
}

/** Extract virtual NICs from a parsed vmx. */
export function extractNics(vmx: Record<string, string>): Nic[] {
  const nics: Nic[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(vmx)) {
    const m = /^(ethernet\d+)\./.exec(key);
    if (!m) continue;
    const device = m[1];
    if (seen.has(device)) continue;
    seen.add(device);
    if (
      vmx[`${device}.present`] !== undefined &&
      !vmxBool(vmx[`${device}.present`])
    ) continue;

    const addressType = vmx[`${device}.addresstype`];
    // A static address wins when set; ESXi only fills generatedAddress for
    // vpx/generated types. Preserving whichever is effective is what keeps
    // DHCP reservations and licence bindings intact across a migration.
    const macAddress = vmx[`${device}.address`] ??
      vmx[`${device}.generatedaddress`];

    nics.push({
      device,
      networkName: vmx[`${device}.networkname`],
      adapterType: vmx[`${device}.virtualdev`],
      macAddress,
      addressType,
    });
  }
  return nics.sort((a, b) => a.device.localeCompare(b.device));
}

// ---------------------------------------------------------------------------
// Per-guest assembly
// ---------------------------------------------------------------------------

/** Numeric vmx value, or undefined when absent/unparseable. */
function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build one `vm` record from that guest's sections.
 *
 * `sections` is the whole map: disk detail lives under keys this function has
 * to match by prefix (`vm.<id>.vmdk <path>`), so it cannot take a pre-sliced
 * view.
 */
export function assembleVm(
  vmid: number,
  sections: Map<string, string>,
  autoStartKeys: Set<string>,
  recordedAt: string,
): Vm {
  const summary = sections.get(`vm.${vmid}.summary`) ?? "";
  const vmxPath = sections.get(`vm.${vmid}.vmxpath`) || undefined;
  const vmx = parseVmx(sections.get(`vm.${vmid}.vmx`));
  const warnings: string[] = [];

  if (vmxPath === undefined) {
    warnings.push(
      "vmx could not be located or read — hardware detail is incomplete",
    );
  }

  const disks = extractDisks(vmx, vmxPath);
  const nics = extractNics(vmx);
  const snapshots = parseSnapshotInfo(sections.get(`vm.${vmid}.snapshot`));
  const passthroughDevices = extractPassthrough(vmx);
  const guest = parseGuestInfo(sections.get(`vm.${vmid}.guest`));
  const quickStats = parseQuickStats(summary);
  const storage = parseStorageSummary(summary);

  // --- disk sizing -------------------------------------------------------
  const duMap = parseDuAll(sections.get(`vm.${vmid}.du`));
  const lsMap = parseLsLong(sections.get(`vm.${vmid}.ls`));
  for (const disk of disks) {
    if (!disk.resolvedPath) continue;
    const descriptor = sections.get(`vm.${vmid}.vmdk ${disk.resolvedPath}`);
    const info = parseVmdkDescriptor(descriptor);
    if (info.provisionedBytes !== undefined) {
      disk.provisionedBytes = info.provisionedBytes;
    }
    if (info.provisioning !== undefined) disk.provisioning = info.provisioning;

    const dir = dirname(disk.resolvedPath);
    let allocated = 0;
    let sawAny = false;
    for (const extent of info.extents) {
      const abs = extent.startsWith("/") ? extent : `${dir}/${extent}`;
      const bytes = duMap.get(abs);
      if (bytes !== undefined) {
        allocated += bytes;
        sawAny = true;
      }
    }
    if (sawAny) disk.allocatedBytes = allocated;

    // Fall back to the apparent size when there was no readable descriptor —
    // better a provisioned figure from `ls` than no figure at all.
    if (disk.provisionedBytes === undefined) {
      const base = disk.resolvedPath.slice(
        dirname(disk.resolvedPath).length + 1,
      );
      const flat = base.replace(/\.vmdk$/i, "-flat.vmdk");
      const apparent = lsMap.get(flat) ?? lsMap.get(base);
      if (apparent !== undefined) disk.provisionedBytes = apparent;
    }
  }

  const folderBytes = vmxPath ? duMap.get(dirname(vmxPath)) : undefined;

  // --- migration blockers ------------------------------------------------
  if (snapshots.length > 0) {
    warnings.push(
      `${snapshots.length} snapshot(s) present — consolidate before migrating, ` +
        "delta disks do not convert cleanly",
    );
  }
  for (const d of disks.filter((d) => d.isRawDeviceMapping)) {
    warnings.push(
      `${d.device} is a raw device mapping (${d.fileName}) — needs a storage ` +
        "decision, it is not a copyable file",
    );
  }
  const firmware = (vmx["firmware"] ?? "bios").toLowerCase();
  const secureBoot = vmxBool(vmx["uefi.secureboot.enabled"]);
  if (secureBoot) {
    warnings.push(
      "Secure Boot is enforced — the target must present a matching UEFI " +
        "setup or the guest will not boot",
    );
  }
  for (const d of disks) {
    if (!(d.mode ?? "").toLowerCase().includes("independent")) continue;
    warnings.push(
      `${d.device} is in independent mode — excluded from snapshots, verify ` +
        "backup coverage before the move",
    );
  }
  for (
    const d of passthroughDevices.filter((p) => p.kind === "pci-passthrough")
  ) {
    warnings.push(
      `${d.device} is PCI passthrough (${d.backing ?? "unknown device"}) — ` +
        "tied to this host's hardware, the rebuild needs an equivalent or a " +
        "decision to drop it",
    );
  }

  const powerState = vimField(summary, "powerState") ?? "unknown";

  // A guest nobody can survey from outside is a guest that has to be booted
  // before it can be planned for — worth stating rather than leaving as an
  // empty `guest` field the reader has to notice.
  if (guest.nics.length === 0 && guest.filesystems.length === 0) {
    warnings.push(
      powerState === "poweredOn"
        ? "VMware Tools is not reporting — no in-guest addressing or " +
          "filesystem layout was collected"
        : "guest is powered off — no in-guest addressing or filesystem " +
          "layout is available without booting it",
    );
  }

  return {
    vmid,
    name: vimField(summary, "name") ?? vmx["displayname"] ?? `vmid-${vmid}`,
    configPath: vmxPath,
    datastore: datastoreOf(vmxPath),
    powerState,
    guestOsId: vmx["guestos"],
    guestOsName: vimField(summary, "guestFullName"),
    hardwareVersion: vmx["virtualhw.version"],
    firmware,
    secureBoot,
    numVcpus: num(vmx["numvcpus"]) ?? 1,
    coresPerSocket: num(vmx["cpuid.corespersocket"]),
    memoryMib: num(vmx["memsize"]),
    biosUuid: vmx["uuid.bios"],
    bootOrder: vmx["bios.bootorder"],
    bootDelayMs: num(vmx["bios.bootdelay"]),
    isTemplate: /\btemplate\s*=\s*true/.test(summary),
    disks,
    nics,
    snapshots,
    passthroughDevices,
    resourceAllocation: extractResourceAllocation(vmx),
    quickStats,
    guest,
    folderBytes,
    storageCommittedBytes: storage.committedBytes,
    storageUncommittedBytes: storage.uncommittedBytes,
    toolsStatus: vimField(summary, "toolsStatus") ??
      vimField(summary, "toolsRunningStatus"),
    annotation: vmx["annotation"],
    autoStart: autoStartKeys.has(String(vmid)),
    warnings,
    rawVmx: vmx,
    recordedAt,
  };
}

// ---------------------------------------------------------------------------
// Host assembly
// ---------------------------------------------------------------------------

/** Every record an esxcli section produced. */
function esxcliRecords(
  sections: Map<string, string>,
  name: string,
): Record<string, unknown>[] {
  return parseEsxcliXml(sections.get(name));
}

/** The single record a `get` command produces. */
function esxcliOne(
  sections: Map<string, string>,
  name: string,
): Record<string, unknown> | undefined {
  return esxcliRecords(sections, name)[0];
}

/**
 * First non-empty string among `keys`.
 *
 * esxcli's JSON keys carry spaces and have been renamed across releases
 * ("Physical Memory" vs "PhysicalMemory", "MAC Address" vs "MACAddress"), so
 * every lookup accepts the spellings seen in the wild rather than betting on
 * one.
 */
function str(o: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

function numField(o: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === "number") return v;
    if (
      typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
    ) {
      return Number(v);
    }
  }
  return undefined;
}

/** Build the `host` record from host-level sections plus the assembled guests. */
export function assembleHost(
  sections: Map<string, string>,
  vms: Vm[],
  recordedAt: string,
): Host {
  const version = esxcliOne(sections, "host.version");
  const platform = esxcliOne(sections, "host.platform");
  const cpu = esxcliOne(sections, "host.cpu");
  const memory = esxcliOne(sections, "host.memory");

  const datastores = esxcliRecords(sections, "host.filesystems")
    .map((o) => ({
      name: str(o, "Volume Name", "VolumeName", "Mount Point") ?? "unknown",
      type: str(o, "Type"),
      uuid: str(o, "UUID"),
      mountPoint: str(o, "Mount Point", "MountPoint"),
      totalBytes: numField(o, "Size"),
      freeBytes: numField(o, "Free"),
    }))
    .filter((d) => d.name !== "unknown");

  const portGroups = esxcliRecords(sections, "host.portgroups")
    .map((o) => str(o, "Name"))
    .filter((n): n is string => n !== undefined);

  const physicalNics = esxcliRecords(sections, "host.nics")
    .map((o) => ({
      name: str(o, "Name") ?? "unknown",
      macAddress: str(o, "MAC Address", "MACAddress"),
      linkStatus: str(o, "Link Status", "LinkStatus", "Link"),
      speedMbps: numField(o, "Speed"),
      driver: str(o, "Driver"),
    }))
    .filter((n) => n.name !== "unknown");

  // `esxcli hardware cpu list` only carries the vendor string ("GenuineIntel")
  // on 6.7, which says nothing useful. hostsummary has the real part number,
  // so prefer it and keep esxcli as the fallback.
  const hostSummary = sections.get("host.summary") ?? "";
  const cpuModel = vimField(hostSummary, "cpuModel") ??
    str(esxcliOne(sections, "host.cpulist"), "Brand");

  return {
    hostname: (sections.get("host.hostname") ?? "").trim() || "unknown",
    product: str(version, "Product"),
    version: str(version, "Version"),
    build: str(version, "Build"),
    vendor: str(platform, "Vendor Name", "VendorName", "Vendor"),
    model: str(platform, "Product Name", "ProductName"),
    cpuModel,
    cpuCores: numField(cpu, "CPU Cores", "CPUCores"),
    cpuThreads: numField(cpu, "CPU Threads", "CPUThreads"),
    memoryBytes: numField(memory, "Physical Memory", "PhysicalMemory"),
    datastores,
    portGroups,
    physicalNics,
    vmCount: vms.length,
    poweredOnCount: vms.filter((v) => v.powerState === "poweredOn").length,
    totalVcpus: vms.reduce((s, v) => s + (v.numVcpus ?? 0), 0),
    totalMemoryMib: vms.reduce((s, v) => s + (v.memoryMib ?? 0), 0),
    totalFolderBytes: vms.reduce((s, v) => s + (v.folderBytes ?? 0), 0),
    recordedAt,
  };
}

/** Host sections expected to contain esxcli JSON. */
const ESXCLI_SECTIONS = [
  "host.version",
  "host.platform",
  "host.cpu",
  "host.cpulist",
  "host.memory",
  "host.filesystems",
  "host.portgroups",
  "host.nics",
];

/**
 * Sections that produced no parseable esxcli output.
 *
 * esxcli's stderr is captured rather than discarded precisely so that a failure
 * here reads as "esxcli said X" instead of an empty `datastores: []` that looks
 * like the host genuinely has none. That is how the 6.7 JSON-formatter gap was
 * found. Returns one short message per bad section.
 */
export function esxcliDiagnostics(sections: Map<string, string>): string[] {
  const out: string[] = [];
  for (const name of ESXCLI_SECTIONS) {
    const text = sections.get(name);
    if (text === undefined || text === "") {
      out.push(`${name}: no output`);
      continue;
    }
    if (parseEsxcliXml(text).length === 0) {
      out.push(`${name}: ${text.replace(/\s+/g, " ").trim().slice(0, 160)}`);
    }
  }
  return out;
}

/** Every vmid that produced a summary section, in ascending order. */
export function discoverVmids(sections: Map<string, string>): number[] {
  const ids: number[] = [];
  for (const key of sections.keys()) {
    const m = /^vm\.(\d+)\.summary$/.exec(key);
    if (m) ids.push(Number(m[1]));
  }
  return ids.sort((a, b) => a - b);
}

/** Autostart keys, exposed so the model can pass them into `assembleVm`. */
export function autoStartKeys(sections: Map<string, string>): Set<string> {
  return parseAutostart(sections.get("host.autostart"));
}
