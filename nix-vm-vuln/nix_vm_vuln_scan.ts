/**
 * Scan a running NixOS VM for vulnerabilities.
 *
 * The scan SSHes to the VM, reads the booted system closure, and matches it
 * against OSV.dev and the NixOS GitHub security advisories. It does not change
 * the VM.
 *
 * @module
 */
import { z } from "npm:zod@4.1.12";
import {
  Args,
  GlobalArgs,
  runScan,
  targetErrors,
  VulnerabilityScan,
} from "./nix_vm_vuln.ts";

/** Read-only SSH scan of a booted NixOS system closure. */
export const model = {
  // Literals so the registry catalog lists this behavior. Keep them equal to
  // nixVmVulnScanType and nixVmVulnReportName in nix_vm_vuln.ts.
  type: "@jamesakeech/nix-vm-vuln-scan",
  version: "2026.11.26.1",
  globalArguments: GlobalArgs,
  resources: {
    vulnerabilityScan: {
      description:
        "Read-only vulnerability scan of a booted NixOS system. Package names, versions, and advisory ids. No credentials.",
      schema: VulnerabilityScan,
      lifetime: "180d",
      garbageCollection: 50,
    },
  },
  reports: ["@jamesakeech/nix-vm-vuln-report"],
  checks: {
    sshTarget: {
      description: "Require a host name and SSH user before connecting.",
      execute: (context: { globalArgs: unknown }) => {
        const parsed = GlobalArgs.safeParse(context.globalArgs ?? {});
        if (!parsed.success) {
          return Promise.resolve({
            pass: false,
            errors: parsed.error.issues.slice(0, 3).map((issue) =>
              issue.message
            ),
          });
        }
        const errors = targetErrors(parsed.data);
        return Promise.resolve(
          errors.length > 0 ? { pass: false, errors } : { pass: true },
        );
      },
    },
  },
  methods: {
    scan: {
      description:
        "Read the booted NixOS closure over SSH and store vulnerability matches. Does not install software or change the generation.",
      arguments: Args,
      execute: (args: z.infer<typeof Args>, context: {
        globalArgs: z.infer<typeof GlobalArgs>;
        signal?: AbortSignal;
        writeResource: (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => Promise<{ name: string }>;
        logger?: {
          info: (message: string, fields?: Record<string, unknown>) => void;
          warning?: (message: string, fields?: Record<string, unknown>) => void;
        };
      }) => runScan(args, context),
    },
  },
};
