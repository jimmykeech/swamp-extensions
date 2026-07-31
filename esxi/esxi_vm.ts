/**
 * `@jamesakeech/esxi/vm` — read-only VM inventory for a **standalone** VMware
 * ESXi host, shaped for planning a migration off it and decommissioning it.
 *
 * The inventory assumes the migration may be a **rebuild** rather than a
 * lift-and-shift, so each `vm` record has to carry enough to reconstruct an
 * equivalent guest from nothing: the virtual hardware, the guest's own identity
 * (hostname, addressing, DNS, default route, mounted filesystems), live usage
 * for rightsizing, and the complete vmx verbatim in `rawVmx` so nothing is lost
 * to the summarising.
 *
 * Standalone ESXi has no vSphere Automation REST API — that surface only exists
 * on vCenter — so inventory comes over SSH from `vim-cmd`, `esxcli`, and the
 * guests' own `.vmx` files. A single `inventory` method does the whole host in
 * one SSH round trip and fans out one `vm` resource per guest plus one `host`
 * resource, rather than making the caller loop per guest.
 *
 * The model is deliberately read-only. Nothing here starts, stops, or deletes a
 * guest: the host is being retired, and the interesting operations (the actual
 * disk moves) belong to the target hypervisor's tooling.
 *
 * @module
 */

import { buildScript, parseSections } from "./_lib/esxi/collect.ts";
import {
  assembleHost,
  assembleVm,
  autoStartKeys,
  discoverVmids,
  esxcliDiagnostics,
} from "./_lib/esxi/assemble.ts";
import { EsxiError, runScript } from "./_lib/esxi/ssh.ts";
import {
  type GlobalArgs,
  GlobalArgsSchema,
  HostSchema,
  InventoryArgsSchema,
  VmSchema,
} from "./_lib/esxi/schemas.ts";

// --- Minimal structural typings for the method context (declared locally,
// never imported — the convention every swamp extension follows). ----------

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
    data: unknown,
  ) => Promise<DataHandle>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

interface MethodResult {
  dataHandles: DataHandle[];
}

/** Context passed to a pre-flight check (no resource writers, per the API). */
interface CheckContext {
  globalArgs: GlobalArgs;
}

interface CheckResult {
  pass: boolean;
  errors?: string[];
}

/**
 * Pre-flight probe.
 *
 * It always exits 0 and reports by printing markers, so a failure is a readable
 * statement about the host rather than an opaque shell exit code. It also
 * avoids `command -v`: ESXi's busybox `ash` does not reliably provide it, and a
 * probe whose own tooling is missing reports 127 and tells you nothing.
 */
const PROBE_SCRIPT = `
echo PROBE_SHELL_OK
if [ -x /bin/vim-cmd ]; then echo PROBE_VIMCMD_OK
elif which vim-cmd >/dev/null 2>&1; then echo PROBE_VIMCMD_OK
else echo PROBE_VIMCMD_MISSING; fi
if [ -x /bin/esxcli ]; then echo PROBE_ESXCLI_OK
elif which esxcli >/dev/null 2>&1; then echo PROBE_ESXCLI_OK
else echo PROBE_ESXCLI_MISSING; fi
exit 0
`;

/** Slug safe for use as a resource instance name. */
function instanceName(vmid: number, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  return slug === "" ? `vm-${vmid}` : `vm-${vmid}-${slug}`;
}

/** Model definition for standalone-ESXi guest inventory. */
export const model = {
  type: "@jamesakeech/esxi/vm",
  version: "2026.07.31.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    vm: {
      description:
        "One guest registered on the ESXi host: virtual hardware, storage, " +
        "in-guest identity and filesystem layout, live usage, the complete " +
        "vmx, and any blockers found — enough to rebuild it from nothing.",
      schema: VmSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    host: {
      description:
        "The ESXi host being decommissioned: version, hardware, datastores, " +
        "port groups, and the aggregate load its guests represent.",
      schema: HostSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "host-reachable": {
      description:
        "The host answers over SSH and exposes vim-cmd — validates " +
        "reachability, authentication, and that this is in fact an ESXi host " +
        "before a collection run is attempted.",
      labels: ["live"],
      appliesTo: ["inventory"],
      execute: async (context: CheckContext): Promise<CheckResult> => {
        try {
          const out = await runScript(
            context.globalArgs.transport,
            PROBE_SCRIPT,
            context.globalArgs.collectTimeoutSec * 1000,
          );
          const missing: string[] = [];
          if (!out.includes("PROBE_VIMCMD_OK")) missing.push("vim-cmd");
          if (!out.includes("PROBE_ESXCLI_OK")) missing.push("esxcli");
          if (missing.length > 0) {
            return {
              pass: false,
              errors: [
                `${context.globalArgs.transport.host} answered over SSH but ` +
                `${missing.join(" and ")} could not be found — is this a ` +
                "standalone ESXi host? Probe output: " +
                out.replace(/\s+/g, " ").trim().slice(0, 300),
              ],
            };
          }
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
    inventory: {
      description:
        "Collect every guest on the host in one SSH round trip, writing one " +
        "vm resource per guest plus a host resource.",
      arguments: InventoryArgsSchema,
      execute: async (
        args: { vmNames: string[]; includeDiskDetail: boolean },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const global = ctx.globalArgs;
        ctx.logger.info("collecting inventory from {host}", {
          host: global.transport.host,
        });

        const stdout = await runScript(
          global.transport,
          buildScript(args.includeDiskDetail),
          global.collectTimeoutSec * 1000,
        );
        const sections = parseSections(stdout);
        const vmids = discoverVmids(sections);
        if (vmids.length === 0 && !sections.has("host.version")) {
          throw new EsxiError(
            "collection produced no recognisable sections — the remote shell " +
              "may have rejected the script",
          );
        }

        // An esxcli that returned nothing would otherwise surface as an empty
        // `datastores: []`, which reads as "the host has none" rather than
        // "the call failed". Say which, and what it said.
        for (const problem of esxcliDiagnostics(sections)) {
          ctx.logger.warning("host detail unavailable — {problem}", {
            problem,
          });
        }

        const recordedAt = new Date().toISOString();
        const keys = autoStartKeys(sections);
        // Every guest is assembled, even when the caller filtered by name: the
        // host totals describe the whole machine being retired, not a subset.
        const all = vmids.map((id) =>
          VmSchema.parse(assembleVm(id, sections, keys, recordedAt))
        );

        const wanted = args.vmNames.length > 0
          ? new Set(args.vmNames)
          : undefined;
        const selected = wanted ? all.filter((v) => wanted.has(v.name)) : all;
        if (wanted) {
          const missing = args.vmNames.filter((n) =>
            !all.some((v) => v.name === n)
          );
          if (missing.length > 0) {
            ctx.logger.warning("no guest named {names} on {host}", {
              names: missing.join(", "),
              host: global.transport.host,
            });
          }
        }

        const handles: DataHandle[] = [];
        for (const vm of selected) {
          if (vm.warnings.length > 0) {
            ctx.logger.warning("{name}: {count} migration warning(s)", {
              name: vm.name,
              count: vm.warnings.length,
            });
          }
          handles.push(
            await ctx.writeResource("vm", instanceName(vm.vmid, vm.name), vm),
          );
        }

        const host = HostSchema.parse(assembleHost(sections, all, recordedAt));
        ctx.logger.info(
          "{host}: {vms} guest(s), {on} powered on, {vcpu} vCPU, {mem} MiB",
          {
            host: host.hostname,
            vms: host.vmCount,
            on: host.poweredOnCount,
            vcpu: host.totalVcpus,
            mem: host.totalMemoryMib,
          },
        );
        handles.push(await ctx.writeResource("host", "host", host));

        return { dataHandles: handles };
      },
    },
  },
};

// Re-exported so the schemas are reachable for consumers building reports over
// this model's output without reaching into _lib.
export { HostSchema, VmSchema };
