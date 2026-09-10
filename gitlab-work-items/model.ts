/** Read-only GitLab issues, tasks, incidents, and their direct hierarchy. */
import { z } from "npm:zod@4.4.3";
import { definition } from "./definition.ts";

/** Generic Swamp model; all GitLab connection and project details are arguments. */
export const model = {
  type: "@jamesakeech/gitlab-work-items",
  version: "2026.09.10.1",
  globalArguments: z.object({
    host: z.string().min(1).describe(
      "GitLab HTTPS hostname, with optional port and no path",
    ),
    token: z.string().min(1).meta({ sensitive: true }).describe(
      "GitLab API read token; use a Swamp vault reference",
    ),
  }),
  ...definition,
};
