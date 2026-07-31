/**
 * Tests for the ESXi collection parsers and assembly.
 *
 * Fixtures are real-shaped `vim-cmd` / `esxcli` / vmx / vmdk output — the
 * awkward parts (vim structs with single-quoted managed object refs, busybox
 * `ls -l` with spaces in names, thin disks whose apparent size lies) are what
 * these tests exist to pin down.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  buildScript,
  parseAutostart,
  parseDuAll,
  parseEsxcliXml,
  parseGuestInfo,
  parseLsLong,
  parseQuickStats,
  parseSections,
  parseSnapshotInfo,
  parseStorageSummary,
  parseVmdkDescriptor,
  parseVmx,
  SECTION,
  vimField,
  vimStringList,
} from "./_lib/esxi/collect.ts";
import {
  assembleHost,
  assembleVm,
  datastoreOf,
  esxcliDiagnostics,
  extractDisks,
  extractNics,
  extractPassthrough,
  extractResourceAllocation,
  resolveDiskPath,
} from "./_lib/esxi/assemble.ts";
import { buildArgv, buildEnv } from "./_lib/esxi/ssh.ts";
import { TransportSchema, VmSchema } from "./_lib/esxi/schemas.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUMMARY = `Listsummary:
(vim.vm.Summary) {
   vm = 'vim.VirtualMachine:3',
   runtime = (vim.vm.RuntimeInfo) {
      host = 'vim.HostSystem:ha-host',
      connectionState = "connected",
      powerState = "poweredOn",
      maxCpuUsage = 4400,
   },
   guest = (vim.vm.Summary.GuestSummary) {
      guestId = "ubuntu64Guest",
      guestFullName = "Ubuntu Linux (64-bit)",
      toolsStatus = "toolsOk",
      toolsVersionStatus = "guestToolsUnmanaged",
      hostName = "web01",
      ipAddress = "192.0.2.31",
   },
   config = (vim.vm.Summary.ConfigSummary) {
      name = "web01",
      template = false,
      vmPathName = "[datastore1] web01/web01.vmx",
      memorySizeMB = 4096,
      numCpu = 2,
      numVirtualDisks = 1,
      guestFullName = "Ubuntu Linux (64-bit)",
   },
   storage = (vim.vm.Summary.StorageSummary) {
      committed = 21474836480,
      uncommitted = 21474836480,
      unshared = 21474836480,
   },
   quickStats = (vim.vm.Summary.QuickStats) {
      overallCpuUsage = 142,
      guestMemoryUsage = 1503,
      hostMemoryUsage = 2210,
      guestHeartbeatStatus = "green",
      uptimeSeconds = 8640000,
   },
}`;

const GUEST = `Guest information:
(vim.vm.GuestInfo) {
   toolsStatus = "toolsOk",
   toolsRunningStatus = "guestToolsRunning",
   toolsVersion = "12325",
   guestId = "ubuntu64Guest",
   guestFamily = "linuxGuest",
   guestFullName = "Ubuntu Linux (64-bit)",
   hostName = "web01.example.com",
   ipAddress = "192.0.2.31",
   net = (vim.vm.GuestInfo.NicInfo) [
      (vim.vm.GuestInfo.NicInfo) {
         network = "VM Network",
         ipAddress = (string) [
            "192.0.2.31",
            "fe80::250:56ff:fe11:2233"
         ],
         macAddress = "00:0c:29:aa:bb:cc",
         connected = true,
         deviceConfigId = 4000,
         ipConfig = (vim.net.IpConfigInfo) {
            ipAddress = (vim.net.IpConfigInfo.IpAddress) [
               (vim.net.IpConfigInfo.IpAddress) {
                  ipAddress = "192.0.2.31",
                  prefixLength = 24,
                  state = "preferred",
               },
               (vim.net.IpConfigInfo.IpAddress) {
                  ipAddress = "fe80::250:56ff:fe11:2233",
                  prefixLength = 64,
                  state = "preferred",
               },
            ],
         },
      }
   ],
   ipStack = (vim.vm.GuestInfo.StackInfo) [
      (vim.vm.GuestInfo.StackInfo) {
         dnsConfig = (vim.net.DnsConfigInfo) {
            dhcp = false,
            hostName = "web01",
            domainName = "example.com",
            ipAddress = (string) [
               "192.0.2.1",
               "1.1.1.1"
            ],
            searchDomain = (string) [
               "example.com"
            ],
         },
         ipRouteConfig = (vim.net.IpRouteConfigInfo) {
            ipRoute = (vim.net.IpRouteConfigInfo.IpRoute) [
               (vim.net.IpRouteConfigInfo.IpRoute) {
                  network = "192.0.2.0",
                  prefixLength = 24,
                  gateway = (vim.net.IpRouteConfigInfo.Gateway) {
                     device = "0",
                  },
               },
               (vim.net.IpRouteConfigInfo.IpRoute) {
                  network = "0.0.0.0",
                  prefixLength = 0,
                  gateway = (vim.net.IpRouteConfigInfo.Gateway) {
                     ipAddress = "192.0.2.1",
                     device = "0",
                  },
               },
            ],
         },
      }
   ],
   disk = (vim.vm.GuestInfo.DiskInfo) [
      (vim.vm.GuestInfo.DiskInfo) {
         diskPath = "/",
         capacity = 41660301312,
         freeSpace = 30064771072,
         filesystemType = "ext4",
      },
      (vim.vm.GuestInfo.DiskInfo) {
         diskPath = "/boot",
         capacity = 1063256064,
         freeSpace = 812646400,
         filesystemType = "ext4",
      },
   ],
   guestState = "running",
}`;

const VMX = `.encoding = "UTF-8"
config.version = "8"
virtualHW.version = "19"
displayName = "web01"
guestOS = "ubuntu-64"
memSize = "4096"
numvcpus = "2"
cpuid.coresPerSocket = "2"
firmware = "efi"
uefi.secureBoot.enabled = "TRUE"
scsi0.virtualDev = "pvscsi"
scsi0.present = "TRUE"
scsi0:0.deviceType = "scsi-hardDisk"
scsi0:0.fileName = "web01.vmdk"
scsi0:0.present = "TRUE"
ide0:0.deviceType = "cdrom-image"
ide0:0.fileName = "/vmfs/volumes/datastore1/iso/ubuntu.iso"
ide0:0.present = "TRUE"
ethernet0.virtualDev = "vmxnet3"
ethernet0.networkName = "VM Network"
ethernet0.addressType = "generated"
ethernet0.generatedAddress = "00:0c:29:aa:bb:cc"
ethernet0.present = "TRUE"
annotation = "web frontend"
# a comment line
`;

const VMDK = `# Disk DescriptorFile
version=1
encoding="UTF-8"
CID=fffffffe
parentCID=ffffffff
createType="vmfs"

# Extent description
RW 83886080 VMFS "web01-flat.vmdk"

# The Disk Data Base
#DDB
ddb.thinProvisioned = "1"
ddb.virtualHWVersion = "19"
`;

const DU = `1	/vmfs/volumes/datastore1/web01/web01.vmx
20971520	/vmfs/volumes/datastore1/web01/web01-flat.vmdk
1	/vmfs/volumes/datastore1/web01/web01.vmdk
20971530	/vmfs/volumes/datastore1/web01`;

const LS = `total 41943044
-rw-------    1 root     root     42949672960 Jul 31 10:00 web01-flat.vmdk
-rw-------    1 root     root            546 Jul 31 10:00 web01.vmdk
-rw-------    1 root     root           3210 Jul 31 10:00 web01.vmx
-rw-------    1 root     root           1024 Jul 31 10:00 my notes.txt`;

const SNAPSHOTS = `Get Snapshot Info:
(vim.vm.SnapshotInfo) {
   currentSnapshot = 'vim.vm.Snapshot:3-1',
   rootSnapshotList = (vim.vm.SnapshotTree) [
      (vim.vm.SnapshotTree) {
         snapshot = 'vim.vm.Snapshot:3-1',
         vm = 'vim.VirtualMachine:3',
         name = "pre-patch",
         description = "before kernel update",
         id = 1,
         createTime = "2026-06-01T09:14:22.123456Z",
         state = "poweredOn",
         quiesced = false,
         childSnapshotList = (vim.vm.SnapshotTree) [],
      }
   ]
}`;

const AUTOSTART = `(vim.host.AutoStartManager.AutoPowerInfo) [
   (vim.host.AutoStartManager.AutoPowerInfo) {
      key = 'vim.VirtualMachine:3',
      startAction = "powerOn",
      startOrder = 1,
      stopAction = "systemDefault",
   },
   (vim.host.AutoStartManager.AutoPowerInfo) {
      key = 'vim.VirtualMachine:7',
      startAction = "none",
      startOrder = -1,
   }
]`;

/** Build esxcli XML output from `[name, type, value]` triples per structure. */
function xml(structures: [string, string, string][][]): string {
  const body = structures.map((fields) =>
    `  <structure typeName="Fixture">\n` +
    fields.map(([n, t, v]) => `   <field name="${n}"><${t}>${v}</${t}></field>`)
      .join("\n") +
    `\n  </structure>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<output xmlns="http://www.vmware.com/Products/ESX/5.0/esxcli">\n` +
    ` <list type="structure">\n${body}\n </list>\n</output>`;
}

// ---------------------------------------------------------------------------
// Section splitting
// ---------------------------------------------------------------------------

Deno.test("parseSections splits on the sentinel and keeps section arguments", () => {
  const out = parseSections(
    `${SECTION} host.hostname\nesxi01\n` +
      `${SECTION} vm.3.vmdk /vmfs/volumes/ds1/web01/web01.vmdk\nRW 100 VMFS "x"\n`,
  );
  assertEquals(out.get("host.hostname"), "esxi01");
  assertEquals(
    out.get("vm.3.vmdk /vmfs/volumes/ds1/web01/web01.vmdk"),
    'RW 100 VMFS "x"',
  );
});

Deno.test("parseSections ignores preamble before the first sentinel", () => {
  const out = parseSections(`motd banner\n${SECTION} a\nbody`);
  assertEquals(out.size, 1);
  assertEquals(out.get("a"), "body");
});

// ---------------------------------------------------------------------------
// vim struct fields
// ---------------------------------------------------------------------------

Deno.test("vimField reads the config name, not guestFullName or hostName", () => {
  assertEquals(vimField(SUMMARY, "name"), "web01");
  assertEquals(vimField(SUMMARY, "powerState"), "poweredOn");
  assertEquals(vimField(SUMMARY, "guestFullName"), "Ubuntu Linux (64-bit)");
  assertEquals(vimField(SUMMARY, "toolsStatus"), "toolsOk");
  assertEquals(vimField(SUMMARY, "vmPathName"), "[datastore1] web01/web01.vmx");
});

Deno.test("vimField falls back to unquoted numerics", () => {
  assertEquals(vimField(SUMMARY, "memorySizeMB"), "4096");
  assertEquals(vimField(SUMMARY, "nosuchfield"), undefined);
});

Deno.test("parseSnapshotInfo skips the array header block", () => {
  const snaps = parseSnapshotInfo(SNAPSHOTS);
  assertEquals(snaps.length, 1);
  assertEquals(snaps[0].name, "pre-patch");
  assertEquals(snaps[0].id, "1");
  assertEquals(snaps[0].createTime, "2026-06-01T09:14:22.123456Z");
});

Deno.test("parseSnapshotInfo returns empty for a guest with none", () => {
  assertEquals(
    parseSnapshotInfo("Get Snapshot Info:\n(vim.vm.SnapshotInfo) null"),
    [],
  );
  assertEquals(parseSnapshotInfo(undefined), []);
});

Deno.test("parseAutostart takes single-quoted morefs and drops startAction none", () => {
  const ids = parseAutostart(AUTOSTART);
  assertEquals(ids.has("3"), true);
  assertEquals(ids.has("7"), false);
});

// ---------------------------------------------------------------------------
// Guest info (VMware Tools)
// ---------------------------------------------------------------------------

Deno.test("vimStringList reads a vim string array", () => {
  assertEquals(
    vimStringList(
      'ipAddress = (string) [\n "1.1.1.1",\n "8.8.8.8"\n ],',
      "ipAddress",
    ),
    ["1.1.1.1", "8.8.8.8"],
  );
  assertEquals(vimStringList("nothing here", "ipAddress"), []);
});

Deno.test("parseGuestInfo extracts the addressing a rebuild has to recreate", () => {
  const g = parseGuestInfo(GUEST);
  assertEquals(g.hostName, "web01.example.com");
  assertEquals(g.domainName, "example.com");
  assertEquals(g.guestState, "running");
  assertEquals(g.guestFamily, "linuxGuest");
  assertEquals(g.toolsVersion, "12325");
  assertEquals(g.primaryIp, "192.0.2.31");
  assertEquals(g.dnsServers, ["192.0.2.1", "1.1.1.1"]);
  assertEquals(g.searchDomains, ["example.com"]);
});

Deno.test("parseGuestInfo takes the default route's gateway, not the first one", () => {
  // The 192.0.2.0/24 route comes first and has no gateway address; picking
  // the first gateway block would yield undefined.
  assertEquals(parseGuestInfo(GUEST).defaultGateway, "192.0.2.1");
});

Deno.test("parseGuestInfo reads per-NIC addresses with prefix lengths", () => {
  const nics = parseGuestInfo(GUEST).nics;
  assertEquals(nics.length, 1);
  assertEquals(nics[0].network, "VM Network");
  assertEquals(nics[0].macAddress, "00:0c:29:aa:bb:cc");
  assertEquals(nics[0].connected, true);
  assertEquals(nics[0].ipAddresses, [
    { address: "192.0.2.31", prefixLength: 24 },
    { address: "fe80::250:56ff:fe11:2233", prefixLength: 64 },
  ]);
});

Deno.test("parseGuestInfo falls back to the flat address list without ipConfig", () => {
  const nics = parseGuestInfo(
    `net = (vim.vm.GuestInfo.NicInfo) [
       (vim.vm.GuestInfo.NicInfo) {
          network = "VM Network",
          macAddress = "00:0c:29:00:00:01",
          ipAddress = (string) [
             "192.0.2.10"
          ],
       }
     ]`,
  ).nics;
  assertEquals(nics[0].ipAddresses, [{ address: "192.0.2.10" }]);
});

Deno.test("parseGuestInfo reads the in-guest partition layout", () => {
  const fs = parseGuestInfo(GUEST).filesystems;
  assertEquals(fs.length, 2);
  assertEquals(fs[0].mountPoint, "/");
  assertEquals(fs[0].capacityBytes, 41660301312);
  assertEquals(fs[0].filesystemType, "ext4");
  assertEquals(fs[1].mountPoint, "/boot");
});

Deno.test("parseGuestInfo returns empty for a guest without Tools", () => {
  const g = parseGuestInfo("(vim.vm.GuestInfo) null");
  assertEquals(g.nics, []);
  assertEquals(g.filesystems, []);
  assertEquals(g.dnsServers, []);
});

Deno.test("parseQuickStats and parseStorageSummary read the summary blocks", () => {
  const q = parseQuickStats(SUMMARY);
  assertEquals(q.overallCpuUsageMhz, 142);
  assertEquals(q.guestMemoryUsageMib, 1503);
  assertEquals(q.uptimeSeconds, 8640000);
  assertEquals(q.heartbeat, "green");

  const s = parseStorageSummary(SUMMARY);
  assertEquals(s.committedBytes, 21474836480);
  assertEquals(s.uncommittedBytes, 21474836480);
});

// ---------------------------------------------------------------------------
// vmx / vmdk / filesystem
// ---------------------------------------------------------------------------

Deno.test("parseVmx lowercases keys, strips quotes, and skips comments", () => {
  const vmx = parseVmx(VMX);
  assertEquals(vmx["virtualhw.version"], "19");
  assertEquals(vmx["annotation"], "web frontend");
  assertEquals(vmx["memsize"], "4096");
  assertEquals(Object.keys(vmx).some((k) => k.startsWith("#")), false);
});

Deno.test("parseVmdkDescriptor sums extents into provisioned bytes", () => {
  const info = parseVmdkDescriptor(VMDK);
  assertEquals(info.provisionedBytes, 83886080 * 512);
  assertEquals(info.provisioning, "thin");
  assertEquals(info.extents, ["web01-flat.vmdk"]);
});

Deno.test("parseVmdkDescriptor reports thick when not thin-provisioned", () => {
  const info = parseVmdkDescriptor(
    'createType="vmfs"\nRW 2048 VMFS "x-flat.vmdk"\n',
  );
  assertEquals(info.provisioning, "vmfs");
  assertEquals(info.provisionedBytes, 2048 * 512);
});

Deno.test("parseLsLong handles filenames containing spaces", () => {
  const ls = parseLsLong(LS);
  assertEquals(ls.get("web01-flat.vmdk"), 42949672960);
  assertEquals(ls.get("my notes.txt"), 1024);
  assertEquals(ls.get("total"), undefined);
});

Deno.test("parseDuAll converts kibibytes and keeps the directory entry", () => {
  const du = parseDuAll(DU);
  assertEquals(
    du.get("/vmfs/volumes/datastore1/web01/web01-flat.vmdk"),
    20971520 * 1024,
  );
  assertEquals(du.get("/vmfs/volumes/datastore1/web01"), 20971530 * 1024);
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

Deno.test("resolveDiskPath handles all three vmx spellings", () => {
  const vmx = "/vmfs/volumes/datastore1/web01/web01.vmx";
  assertEquals(
    resolveDiskPath("web01.vmdk", vmx),
    "/vmfs/volumes/datastore1/web01/web01.vmdk",
  );
  assertEquals(
    resolveDiskPath("[datastore2] other/other.vmdk", vmx),
    "/vmfs/volumes/datastore2/other/other.vmdk",
  );
  assertEquals(
    resolveDiskPath("/vmfs/volumes/ds3/x.vmdk", vmx),
    "/vmfs/volumes/ds3/x.vmdk",
  );
});

Deno.test("datastoreOf extracts the volume name", () => {
  assertEquals(
    datastoreOf("/vmfs/volumes/datastore1/web01/web01.vmx"),
    "datastore1",
  );
  assertEquals(datastoreOf(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Device extraction
// ---------------------------------------------------------------------------

Deno.test("extractDisks excludes cdrom backings", () => {
  const disks = extractDisks(
    parseVmx(VMX),
    "/vmfs/volumes/datastore1/web01/web01.vmx",
  );
  assertEquals(disks.length, 1);
  assertEquals(disks[0].device, "scsi0:0");
  assertEquals(disks[0].controller, "pvscsi");
  assertEquals(disks[0].isRawDeviceMapping, false);
});

Deno.test("extractDisks flags raw device mappings", () => {
  const disks = extractDisks(
    parseVmx(
      'scsi0:1.present = "TRUE"\nscsi0:1.fileName = "db-rdmp.vmdk"\n' +
        'scsi0:1.deviceType = "scsi-passthru-rdm"\n',
    ),
    "/vmfs/volumes/ds1/db/db.vmx",
  );
  assertEquals(disks.length, 1);
  assertEquals(disks[0].isRawDeviceMapping, true);
});

Deno.test("extractDisks skips devices explicitly marked absent", () => {
  const disks = extractDisks(
    parseVmx('scsi0:2.present = "FALSE"\nscsi0:2.fileName = "old.vmdk"\n'),
    "/vmfs/volumes/ds1/x/x.vmx",
  );
  assertEquals(disks.length, 0);
});

Deno.test("extractNics prefers a static address over the generated one", () => {
  const nics = extractNics(parseVmx(VMX));
  assertEquals(nics.length, 1);
  assertEquals(nics[0].macAddress, "00:0c:29:aa:bb:cc");
  assertEquals(nics[0].networkName, "VM Network");
  assertEquals(nics[0].adapterType, "vmxnet3");

  const staticNic = extractNics(parseVmx(
    'ethernet0.present = "TRUE"\nethernet0.addressType = "static"\n' +
      'ethernet0.address = "00:50:56:11:22:33"\n' +
      'ethernet0.generatedAddress = "00:0c:29:99:99:99"\n',
  ));
  assertEquals(staticNic[0].macAddress, "00:50:56:11:22:33");
});

// ---------------------------------------------------------------------------
// Passthrough + resource allocation
// ---------------------------------------------------------------------------

Deno.test("extractPassthrough finds PCI passthrough and serial backings", () => {
  const devices = extractPassthrough(parseVmx(
    'pciPassthru0.present = "TRUE"\npciPassthru0.id = "0000:03:00.0"\n' +
      'serial0.present = "TRUE"\nserial0.fileType = "network"\n' +
      'usb_xhci.present = "FALSE"\n',
  ));
  assertEquals(devices.length, 2);
  assertEquals(devices[0].device, "pciPassthru0".toLowerCase());
  assertEquals(devices[0].kind, "pci-passthrough");
  assertEquals(devices[0].backing, "0000:03:00.0");
  assertEquals(devices[1].kind, "serial-port");
  // present = FALSE must not produce an entry.
  assertEquals(devices.some((d) => d.device.includes("xhci")), false);
});

Deno.test("extractResourceAllocation detects a full memory reservation", () => {
  const pinned = extractResourceAllocation(parseVmx(
    'memSize = "4096"\nsched.mem.min = "4096"\nvcpu.hotadd = "TRUE"\n',
  ));
  assertEquals(pinned.memoryReservedAll, true);
  assertEquals(pinned.memoryReservationMib, 4096);
  assertEquals(pinned.cpuHotAdd, true);

  const unpinned = extractResourceAllocation(parseVmx(
    'memSize = "4096"\nsched.mem.min = "0"\n',
  ));
  assertEquals(unpinned.memoryReservedAll, false);
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function webVmSections(): Map<string, string> {
  return new Map<string, string>([
    ["vm.3.summary", SUMMARY],
    ["vm.3.snapshot", SNAPSHOTS],
    ["vm.3.guest", GUEST],
    ["vm.3.vmxpath", "/vmfs/volumes/datastore1/web01/web01.vmx"],
    ["vm.3.vmx", VMX],
    ["vm.3.ls", LS],
    ["vm.3.du", DU],
    ["vm.3.vmdk /vmfs/volumes/datastore1/web01/web01.vmdk", VMDK],
    ["host.autostart", AUTOSTART],
  ]);
}

Deno.test("assembleVm produces a schema-valid, migration-shaped record", () => {
  const sections = webVmSections();
  const vm = VmSchema.parse(
    assembleVm(3, sections, parseAutostart(AUTOSTART), "2026-07-31T12:00:00Z"),
  );

  assertEquals(vm.name, "web01");
  assertEquals(vm.powerState, "poweredOn");
  assertEquals(vm.guestOsId, "ubuntu-64");
  assertEquals(vm.guestOsName, "Ubuntu Linux (64-bit)");
  assertEquals(vm.hardwareVersion, "19");
  assertEquals(vm.firmware, "efi");
  assertEquals(vm.secureBoot, true);
  assertEquals(vm.numVcpus, 2);
  assertEquals(vm.coresPerSocket, 2);
  assertEquals(vm.memoryMib, 4096);
  assertEquals(vm.datastore, "datastore1");
  assertEquals(vm.toolsStatus, "toolsOk");
  assertEquals(vm.annotation, "web frontend");
  assertEquals(vm.autoStart, true);
  assertEquals(vm.folderBytes, 20971530 * 1024);
});

Deno.test("assembleVm separates provisioned from allocated on a thin disk", () => {
  const vm = assembleVm(
    3,
    webVmSections(),
    new Set(),
    "2026-07-31T12:00:00Z",
  );
  const disk = vm.disks[0];
  // 40 GiB provisioned, 20 GiB actually written — the copy cost is the latter.
  assertEquals(disk.provisionedBytes, 42949672960);
  assertEquals(disk.allocatedBytes, 21474836480);
  assertEquals(disk.provisioning, "thin");
});

Deno.test("assembleVm carries the guest's own identity for a rebuild", () => {
  const vm = VmSchema.parse(
    assembleVm(3, webVmSections(), new Set(), "2026-07-31T12:00:00Z"),
  );
  assertEquals(vm.guest?.hostName, "web01.example.com");
  assertEquals(vm.guest?.defaultGateway, "192.0.2.1");
  assertEquals(vm.guest?.dnsServers, ["192.0.2.1", "1.1.1.1"]);
  assertEquals(vm.guest?.nics[0].ipAddresses[0].address, "192.0.2.31");
  assertEquals(vm.guest?.nics[0].ipAddresses[0].prefixLength, 24);
  assertEquals(vm.guest?.filesystems.map((f) => f.mountPoint), ["/", "/boot"]);
});

Deno.test("assembleVm keeps the complete vmx verbatim in rawVmx", () => {
  const vm = VmSchema.parse(
    assembleVm(3, webVmSections(), new Set(), "2026-07-31T12:00:00Z"),
  );
  // Keys nothing in the typed surface models must still survive.
  assertEquals(vm.rawVmx["config.version"], "8");
  assertEquals(vm.rawVmx[".encoding"], "UTF-8");
  assertEquals(vm.rawVmx["ide0:0.devicetype"], "cdrom-image");
  assertEquals(vm.rawVmx["displayname"], "web01");
});

Deno.test("assembleVm records live usage against the declared size", () => {
  const vm = VmSchema.parse(
    assembleVm(3, webVmSections(), new Set(), "2026-07-31T12:00:00Z"),
  );
  // Declared 4096 MiB, actually using 1503 — the rightsizing signal.
  assertEquals(vm.memoryMib, 4096);
  assertEquals(vm.quickStats?.guestMemoryUsageMib, 1503);
  assertEquals(vm.quickStats?.uptimeSeconds, 8640000);
  assertEquals(vm.storageCommittedBytes, 21474836480);
  assertEquals(vm.isTemplate, false);
});

Deno.test("assembleVm warns when no in-guest data could be collected", () => {
  const sections = new Map(webVmSections());
  sections.delete("vm.3.guest");
  const vm = assembleVm(3, sections, new Set(), "2026-07-31T12:00:00Z");
  // Powered on but silent means Tools is the problem, not the power state.
  assertEquals(
    vm.warnings.some((w) => w.includes("VMware Tools is not reporting")),
    true,
  );
});

Deno.test("assembleVm warns about PCI passthrough as a rebuild constraint", () => {
  const sections = new Map(webVmSections());
  sections.set(
    "vm.3.vmx",
    VMX + '\npciPassthru0.present = "TRUE"\npciPassthru0.id = "0000:03:00.0"\n',
  );
  const vm = assembleVm(3, sections, new Set(), "2026-07-31T12:00:00Z");
  assertEquals(vm.passthroughDevices.length, 1);
  assertEquals(
    vm.warnings.some((w) => w.includes("PCI passthrough")),
    true,
  );
});

Deno.test("assembleVm surfaces snapshots and Secure Boot as migration blockers", () => {
  const vm = assembleVm(
    3,
    webVmSections(),
    new Set(),
    "2026-07-31T12:00:00Z",
  );
  assertEquals(vm.snapshots.length, 1);
  assertEquals(vm.warnings.some((w) => w.includes("snapshot")), true);
  assertEquals(vm.warnings.some((w) => w.includes("Secure Boot")), true);
});

Deno.test("assembleVm degrades gracefully when the vmx could not be read", () => {
  const sections = new Map<string, string>([["vm.9.summary", SUMMARY]]);
  const vm = VmSchema.parse(
    assembleVm(9, sections, new Set(), "2026-07-31T12:00:00Z"),
  );
  assertEquals(vm.name, "web01");
  assertEquals(vm.disks, []);
  assertEquals(vm.warnings.some((w) => w.includes("vmx")), true);
});

Deno.test("assembleHost reads spaced esxcli keys and totals the guests", () => {
  const sections = new Map<string, string>([
    ["host.hostname", "esxi01.example.com"],
    [
      "host.version",
      xml([[
        ["Build", "string", "Releasebuild-20328353"],
        ["Product", "string", "VMware ESXi"],
        ["Version", "string", "7.0.3"],
      ]]),
    ],
    [
      "host.platform",
      xml([[
        ["Vendor Name", "string", "Dell Inc."],
        ["Product Name", "string", "PowerEdge R620"],
      ]]),
    ],
    [
      "host.cpu",
      xml([[
        ["CPU Cores", "integer", "12"],
        ["CPU Threads", "integer", "24"],
        ["CPU Packages", "integer", "2"],
      ]]),
    ],
    [
      "host.memory",
      xml([[
        ["Physical Memory", "long", "137303654400"],
        ["NUMA Node Count", "integer", "2"],
      ]]),
    ],
    [
      "host.cpulist",
      xml([[
        ["Brand", "string", "Intel(R) Xeon(R) CPU E5-2620 0"],
      ]]),
    ],
    [
      "host.filesystems",
      xml([[
        ["Volume Name", "string", "datastore1"],
        ["Type", "string", "VMFS-6"],
        ["Size", "long", "1000"],
        ["Free", "long", "400"],
        ["Mount Point", "string", "/vmfs/volumes/abc"],
        ["UUID", "string", "abc"],
      ]]),
    ],
    [
      "host.portgroups",
      xml([
        [["Name", "string", "VM Network"]],
        [["Name", "string", "Management Network"]],
      ]),
    ],
    [
      "host.nics",
      xml([[
        ["Name", "string", "vmnic0"],
        ["MAC Address", "string", "aa:bb:cc:dd:ee:ff"],
        ["Link Status", "string", "Up"],
        ["Speed", "integer", "1000"],
        ["Driver", "string", "ntg3"],
      ]]),
    ],
  ]);
  const vm = assembleVm(
    3,
    webVmSections(),
    new Set(),
    "2026-07-31T12:00:00Z",
  );
  const host = assembleHost(sections, [vm], "2026-07-31T12:00:00Z");

  assertEquals(host.hostname, "esxi01.example.com");
  assertEquals(host.version, "7.0.3");
  assertEquals(host.vendor, "Dell Inc.");
  assertEquals(host.model, "PowerEdge R620");
  assertEquals(host.cpuCores, 12);
  assertEquals(host.memoryBytes, 137303654400);
  assertEquals(host.cpuModel, "Intel(R) Xeon(R) CPU E5-2620 0");
  assertEquals(host.datastores[0].name, "datastore1");
  assertEquals(host.physicalNics[0].macAddress, "aa:bb:cc:dd:ee:ff");
  assertEquals(host.physicalNics[0].linkStatus, "Up");
  assertEquals(host.portGroups, ["VM Network", "Management Network"]);
  assertEquals(host.vmCount, 1);
  assertEquals(host.poweredOnCount, 1);
  assertEquals(host.totalVcpus, 2);
  assertEquals(host.totalMemoryMib, 4096);
});

Deno.test("assembleHost tolerates a host where every esxcli call failed", () => {
  const host = assembleHost(new Map(), [], "2026-07-31T12:00:00Z");
  assertEquals(host.hostname, "unknown");
  assertEquals(host.datastores, []);
  assertEquals(host.vmCount, 0);
});

Deno.test("parseEsxcliXml types values by element and decodes entities", () => {
  const records = parseEsxcliXml(xml([[
    ["Name", "string", "vmnic0"],
    ["Speed", "integer", "1000"],
    ["Up", "boolean", "true"],
    ["Desc", "string", "Intel &amp; Co &lt;NIC&gt;"],
  ]]));
  assertEquals(records.length, 1);
  assertEquals(records[0]["Name"], "vmnic0");
  assertEquals(records[0]["Speed"], 1000);
  assertEquals(records[0]["Up"], true);
  assertEquals(records[0]["Desc"], "Intel & Co <NIC>");
});

Deno.test("esxcliDiagnostics reports the 6.7 missing-formatter message", () => {
  // ESXi 6.7 has no json formatter; the failure has to name itself rather than
  // silently produce an empty datastore list.
  const sections = new Map<string, string>([
    ["host.version", "Unable to find requested formatter: json"],
  ]);
  const problems = esxcliDiagnostics(sections);
  assertEquals(
    problems.some((p) => p.includes("Unable to find requested formatter")),
    true,
  );
  // Sections that produced nothing at all are called out separately.
  assertEquals(problems.some((p) => p.includes("host.nics: no output")), true);
});

// ---------------------------------------------------------------------------
// SSH argv
// ---------------------------------------------------------------------------

Deno.test("buildArgv uses BatchMode for key auth and wraps sshpass for password", () => {
  const key = TransportSchema.parse({
    host: "esxi01",
    auth: { kind: "key", identityFile: "/home/j/.ssh/id_ed25519" },
  });
  const argv = buildArgv(key);
  assertEquals(argv[0], "ssh");
  assertEquals(argv.includes("BatchMode=yes"), true);
  assertEquals(argv.includes("/home/j/.ssh/id_ed25519"), true);
  assertEquals(argv[argv.length - 1], "sh -s");
  assertEquals(buildEnv(key), undefined);

  const pw = TransportSchema.parse({
    host: "esxi01",
    auth: { kind: "password", password: "hunter2" },
  });
  const pwArgv = buildArgv(pw);
  assertEquals(pwArgv[0], "sshpass");
  assertEquals(pwArgv[1], "-e");
  // BatchMode would suppress the very prompt sshpass exists to answer.
  assertEquals(pwArgv.includes("BatchMode=yes"), false);
  // The password must never reach argv, only the environment.
  assertEquals(pwArgv.includes("hunter2"), false);
  assertEquals(buildEnv(pw), { SSHPASS: "hunter2" });
});

Deno.test("transport schema rejects newline smuggling in ssh option values", () => {
  const bad = TransportSchema.safeParse({
    host: "esxi01\n-oProxyCommand=touch /tmp/pwned",
    auth: { kind: "key" },
  });
  assertEquals(bad.success, false);
});

Deno.test("buildScript never cats raw disk data files", () => {
  const script = buildScript(true);
  assertEquals(script.includes("*-flat.vmdk|*-delta.vmdk"), true);
  assertEquals(script.includes("head -c 4096"), true);
  // Disk detail is genuinely optional, not always-on.
  assertEquals(buildScript(false).includes("du -ak"), false);
});
