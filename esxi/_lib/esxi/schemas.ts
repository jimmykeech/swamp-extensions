/**
 * Schemas for the `@jamesakeech/esxi/vm` model — transport, global arguments,
 * and the two resource shapes (`host`, `vm`).
 *
 * The inventory is shaped for a **rebuild**, not a lift-and-shift: the target
 * may be a fresh guest that only has to end up equivalent, so the record has to
 * carry enough to reconstruct one from nothing. That means the virtual hardware
 * *and* the guest's own identity — hostname, addressing, DNS, default route,
 * partition layout — plus live usage figures, because rebuilding is the moment
 * to correct a guest that was over-provisioned years ago.
 *
 * `rawVmx` holds the complete vmx key/value map verbatim. The typed fields
 * above it are the queryable summary; `rawVmx` is the guarantee that nothing
 * was dropped on the way through.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

/**
 * Refuse strings carrying newlines or NUL bytes in positions that become SSH
 * option values or remote argv. OpenSSH option parsing is not airtight against
 * embedded newlines; rejecting them at schema time stops a crafted config from
 * smuggling extra `-o` flags.
 */
export function safeArg(label: string): z.ZodString {
  return z.string().refine(
    // deno-lint-ignore no-control-regex
    (s) => !/[\x00\r\n]/.test(s),
    { message: `${label} must not contain newlines or NUL bytes` },
  );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Key/agent auth. The preferred mode: ESXi reads
 * `/etc/ssh/keys-root/authorized_keys`, so no secret passes through the model
 * definition at all.
 */
export const KeyAuthSchema = z.object({
  kind: z.literal("key"),
  identityFile: safeArg("identityFile").min(1).optional().describe(
    "Private key path. Omit to use the agent / ssh_config default.",
  ),
  identityAgent: safeArg("identityAgent").min(1).optional(),
});

/**
 * Password auth, delegated to `sshpass`. The password is handed over via the
 * `SSHPASS` environment variable (`sshpass -e`) so it never appears in argv,
 * where any local user could read it out of the process table.
 *
 * Requires `sshpass` on the swamp host — it is NOT part of a stock macOS
 * install and is not in homebrew-core. Prefer `kind: "key"`.
 */
export const PasswordAuthSchema = z.object({
  kind: z.literal("password"),
  password: z.string().min(1).meta({ sensitive: true }).describe(
    "Root password — supply via `${{ vault.get('<vault>', '<key>') }}`.",
  ),
  sshpassBinary: safeArg("sshpassBinary").min(1).default("sshpass").describe(
    "Path to sshpass. Must exist on the swamp host.",
  ),
});

export const AuthSchema = z.discriminatedUnion("kind", [
  KeyAuthSchema,
  PasswordAuthSchema,
]);
export type Auth = z.infer<typeof AuthSchema>;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * SSH transport. Standalone ESXi has no vSphere Automation REST API — that is
 * a vCenter-only surface — so the host shell (`vim-cmd`, `esxcli`, and the
 * `.vmx` files themselves) is the authoritative inventory source.
 */
export const TransportSchema = z.object({
  host: safeArg("host").min(1).describe("ESXi host address."),
  user: safeArg("user").min(1).default("root").describe(
    "SSH user — must be able to run vim-cmd/esxcli (typically root).",
  ),
  port: z.number().int().positive().max(65535).default(22),
  auth: AuthSchema,
  proxyJump: safeArg("proxyJump").min(1).optional(),
  strictHostKeyChecking: z.enum(["yes", "accept-new", "no", "off"]).optional(),
  connectTimeoutSec: z.number().int().positive().default(15),
  sshBinary: safeArg("sshBinary").min(1).default("ssh"),
});
export type Transport = z.infer<typeof TransportSchema>;

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

export const GlobalArgsSchema = z.object({
  name: z.string().min(1).describe("Instance label for this host's inventory."),
  transport: TransportSchema,
  /** Seconds to allow the whole remote collection script to run. */
  collectTimeoutSec: z.number().int().positive().default(300),
});
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Resource: vm
// ---------------------------------------------------------------------------

/** One virtual disk attached to a guest. */
export const DiskSchema = z.object({
  /** vmx device key, e.g. `scsi0:0`. */
  device: z.string(),
  /** Datastore-relative path as written in the vmx. */
  fileName: z.string(),
  /** Absolute `/vmfs/volumes/...` path, when it could be resolved. */
  resolvedPath: z.string().optional(),
  /** Provisioned size from the vmdk descriptor extents. */
  provisionedBytes: z.number().optional(),
  /** Bytes actually consumed on the datastore (thin disks differ). */
  allocatedBytes: z.number().optional(),
  /** `thin`, `eagerZeroedThick`, `zeroedThick`, or undefined when unreadable. */
  provisioning: z.string().optional(),
  /** Controller type backing the device, e.g. `pvscsi`, `lsisas1068`. */
  controller: z.string().optional(),
  /** True for RDMs and other non-file backings — these do not migrate cleanly. */
  isRawDeviceMapping: z.boolean().default(false),
  /** vmx disk mode, e.g. `independent-persistent`. Absent means the default. */
  mode: z.string().optional(),
  /** SCSI bus sharing — set for clustered guests, and a rebuild constraint. */
  busSharing: z.string().optional(),
  /** Changed-block tracking, which some backup tooling depends on. */
  changeBlockTracking: z.boolean().default(false),
});
export type Disk = z.infer<typeof DiskSchema>;

/** One virtual NIC attached to a guest. */
export const NicSchema = z.object({
  /** vmx device key, e.g. `ethernet0`. */
  device: z.string(),
  /** Port group label the NIC is attached to. */
  networkName: z.string().optional(),
  /** Adapter model, e.g. `vmxnet3`, `e1000e`. */
  adapterType: z.string().optional(),
  /** Effective MAC — the generated one unless a static address is set. */
  macAddress: z.string().optional(),
  /** `generated`, `static`, or `vpx`. Static MACs must be preserved on move. */
  addressType: z.string().optional(),
});
export type Nic = z.infer<typeof NicSchema>;

/** An IP address the guest OS has configured on a NIC. */
export const GuestIpSchema = z.object({
  address: z.string(),
  prefixLength: z.number().optional(),
});

/** A NIC as the running guest sees it — the addressing a rebuild must recreate. */
export const GuestNicSchema = z.object({
  network: z.string().optional(),
  macAddress: z.string().optional(),
  connected: z.boolean().default(false),
  ipAddresses: z.array(GuestIpSchema).default([]),
});

/** A filesystem mounted inside the guest — the partition layout to recreate. */
export const GuestFilesystemSchema = z.object({
  mountPoint: z.string(),
  capacityBytes: z.number().optional(),
  freeBytes: z.number().optional(),
  filesystemType: z.string().optional(),
});

/**
 * What only the running guest knows. Entirely dependent on VMware Tools: a
 * powered-off guest, or one without Tools, yields an empty record — which is
 * itself a finding, since that guest cannot be surveyed without booting it.
 */
export const GuestInfoSchema = z.object({
  hostName: z.string().optional(),
  domainName: z.string().optional(),
  guestState: z.string().optional(),
  guestFamily: z.string().optional(),
  toolsVersion: z.string().optional(),
  toolsRunningStatus: z.string().optional(),
  primaryIp: z.string().optional(),
  dnsServers: z.array(z.string()).default([]),
  searchDomains: z.array(z.string()).default([]),
  defaultGateway: z.string().optional(),
  nics: z.array(GuestNicSchema).default([]),
  filesystems: z.array(GuestFilesystemSchema).default([]),
});

/**
 * Reservations, limits, and shares. Rarely set in a homelab, but when they are
 * set they are invisible in the guest and silently change its behaviour — so
 * they have to be carried across deliberately or dropped deliberately.
 */
export const ResourceAllocationSchema = z.object({
  cpuReservationMhz: z.number().optional(),
  cpuLimitMhz: z.number().optional(),
  cpuShares: z.string().optional(),
  memoryReservationMib: z.number().optional(),
  memoryLimitMib: z.number().optional(),
  memoryShares: z.string().optional(),
  /** True when all guest memory is pinned — blocks overcommit on the target. */
  memoryReservedAll: z.boolean().default(false),
  cpuHotAdd: z.boolean().default(false),
  memoryHotAdd: z.boolean().default(false),
});
export type ResourceAllocation = z.infer<typeof ResourceAllocationSchema>;

/**
 * Live usage at collection time. The rightsizing evidence: a guest declared at
 * 8192 MiB that has never touched 1500 is one to rebuild smaller.
 */
export const QuickStatsSchema = z.object({
  overallCpuUsageMhz: z.number().optional(),
  guestMemoryUsageMib: z.number().optional(),
  hostMemoryUsageMib: z.number().optional(),
  uptimeSeconds: z.number().optional(),
  heartbeat: z.string().optional(),
});

/** A non-disk device that constrains where a guest can be rebuilt. */
export const PassthroughDeviceSchema = z.object({
  /** vmx device key, e.g. `pciPassthru0`, `serial0`, `usb_xhci`. */
  device: z.string(),
  kind: z.string(),
  /** Host-side identifier or backing, when the vmx records one. */
  backing: z.string().optional(),
});
export type PassthroughDevice = z.infer<typeof PassthroughDeviceSchema>;

/** A snapshot in the guest's snapshot tree. */
export const SnapshotSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  createTime: z.string().optional(),
});

/**
 * A single guest as it exists on the ESXi host — the migration unit.
 */
export const VmSchema = z.object({
  /** `vim-cmd` numeric VM id. Stable only while registered on this host. */
  vmid: z.number(),
  name: z.string(),
  /** Absolute path to the guest's `.vmx`. */
  configPath: z.string().optional(),
  /** Datastore the vmx lives on. */
  datastore: z.string().optional(),
  powerState: z.string(),
  /** Guest OS as configured in the vmx (`guestOS` key), e.g. `ubuntu-64`. */
  guestOsId: z.string().optional(),
  /** Human-readable guest OS from the summary, e.g. `Ubuntu Linux (64-bit)`. */
  guestOsName: z.string().optional(),
  /** Virtual hardware version — caps which Proxmox machine types work. */
  hardwareVersion: z.string().optional(),
  /** `bios` or `efi`. Mismatching this on the target is the classic no-boot. */
  firmware: z.string().optional(),
  /** True when the guest boots UEFI with Secure Boot enforced. */
  secureBoot: z.boolean().default(false),
  numVcpus: z.number().optional(),
  coresPerSocket: z.number().optional(),
  memoryMib: z.number().optional(),
  /** BIOS UUID. Licences and DHCP reservations are sometimes bound to it. */
  biosUuid: z.string().optional(),
  /** vmx `bios.bootOrder`, e.g. `hdd,cdrom`. */
  bootOrder: z.string().optional(),
  /** Boot delay in ms — occasionally load-bearing for slow-starting guests. */
  bootDelayMs: z.number().optional(),
  /** True when the guest is registered as a template rather than a live VM. */
  isTemplate: z.boolean().default(false),
  disks: z.array(DiskSchema).default([]),
  nics: z.array(NicSchema).default([]),
  snapshots: z.array(SnapshotSchema).default([]),
  /** Serial, parallel, USB and PCI passthrough — rebuild constraints. */
  passthroughDevices: z.array(PassthroughDeviceSchema).default([]),
  resourceAllocation: ResourceAllocationSchema.optional(),
  quickStats: QuickStatsSchema.optional(),
  /** Identity and layout from inside the guest, via VMware Tools. */
  guest: GuestInfoSchema.optional(),
  /** Total bytes the guest's folder occupies — the copy cost for the move. */
  folderBytes: z.number().optional(),
  /** Datastore bytes the host accounts to this guest. */
  storageCommittedBytes: z.number().optional(),
  /** Bytes the guest could still grow into on thin disks. */
  storageUncommittedBytes: z.number().optional(),
  /** VMware Tools running state as reported by the host. */
  toolsStatus: z.string().optional(),
  /** vmx `annotation` — often the only record of what a guest is for. */
  annotation: z.string().optional(),
  /** True when the guest is set to power on with the host. */
  autoStart: z.boolean().default(false),
  /**
   * Migration blockers found during collection — RDMs, snapshots present,
   * passthrough devices, unreadable vmx, and so on. Empty means nothing stood
   * out.
   */
  warnings: z.array(z.string()).default([]),
  /**
   * The complete vmx, verbatim, keys lowercased.
   *
   * The typed fields above are the queryable summary of what usually matters;
   * this is the guarantee that nothing was dropped. When a rebuild turns up a
   * guest that behaves oddly, the answer is normally one of the several hundred
   * keys nobody thought to model.
   */
  rawVmx: z.record(z.string(), z.string()).default({}),
  recordedAt: z.iso.datetime(),
});
export type Vm = z.infer<typeof VmSchema>;

// ---------------------------------------------------------------------------
// Resource: host
// ---------------------------------------------------------------------------

/** A datastore visible to the host. */
export const DatastoreSchema = z.object({
  name: z.string(),
  /** `VMFS-6`, `NFS`, `vfat`, … */
  type: z.string().optional(),
  uuid: z.string().optional(),
  mountPoint: z.string().optional(),
  totalBytes: z.number().optional(),
  freeBytes: z.number().optional(),
});

/** A physical uplink on the host. */
export const PhysicalNicSchema = z.object({
  name: z.string(),
  macAddress: z.string().optional(),
  linkStatus: z.string().optional(),
  speedMbps: z.number().optional(),
  driver: z.string().optional(),
});

/**
 * The host itself — the thing being decommissioned. Capacity numbers here are
 * what the migration target has to absorb.
 */
export const HostSchema = z.object({
  hostname: z.string(),
  product: z.string().optional(),
  version: z.string().optional(),
  build: z.string().optional(),
  /** Hardware vendor/model, for the decommissioning record. */
  vendor: z.string().optional(),
  model: z.string().optional(),
  cpuModel: z.string().optional(),
  cpuCores: z.number().optional(),
  cpuThreads: z.number().optional(),
  memoryBytes: z.number().optional(),
  datastores: z.array(DatastoreSchema).default([]),
  portGroups: z.array(z.string()).default([]),
  physicalNics: z.array(PhysicalNicSchema).default([]),
  /** Guests registered on the host at collection time. */
  vmCount: z.number(),
  poweredOnCount: z.number(),
  /** Sum of configured vCPUs across all guests. */
  totalVcpus: z.number(),
  /** Sum of configured memory across all guests. */
  totalMemoryMib: z.number(),
  /** Sum of guest folder sizes — the total bytes to move off this host. */
  totalFolderBytes: z.number(),
  recordedAt: z.iso.datetime(),
});
export type Host = z.infer<typeof HostSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

export const InventoryArgsSchema = z.object({
  /**
   * Restrict collection to these guest names. Empty means every registered
   * guest — the default, because a decommissioning plan needs all of them.
   */
  vmNames: z.array(safeArg("vmNames").min(1)).default([]),
  /**
   * Reading vmdk descriptors and sizing folders costs a stat walk per guest.
   * Disable for a fast name/power-state-only pass.
   */
  includeDiskDetail: z.boolean().default(true),
});
