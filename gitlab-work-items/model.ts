/** GitLab work-item CRUD, labels, lifecycle state and direct hierarchy. */
import { z } from "npm:zod@4.4.3";
import { definition } from "./definition.ts";

/** Generic Swamp model; all GitLab connection and project details are arguments. */
export const model = {
  type: "@jamesakeech/gitlab-work-items",
  version: "2026.09.10.2",
  globalArguments: z.object({
    host: z.string().min(1).describe(
      "GitLab HTTPS hostname, with optional port and no path",
    ),
    token: z.string().min(1).meta({ sensitive: true }).describe(
      "GitLab API token via a vault reference; read_api for reads, api for mutations",
    ),
  }),
  upgrades: [{
    toVersion: "2026.09.10.2",
    description: "Add CRUD methods; preserve existing host and token arguments",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }],
  ...definition,
};
