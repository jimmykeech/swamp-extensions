/** Contracts for accepted control planes and isolated work-item factories. @module */
import { z } from "npm:zod@4";

/** Extension release tested against the official factory engine. */
export const VERSION = "2026.09.06.6";
/** Official engine version supported by this release. */
export const ENGINE_VERSION = "2026.06.24.1";
/** Content-addressed identifier. */
export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().trim().min(1).max(2000);
const Name = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const JsonObject = z.record(z.string(), z.unknown());

// Factory prompts are literal guidance, not executable CEL or binding slots.
const FactoryInstructions = Text.refine(
  (text) => !text.includes("${{") && !/__[A-Z][A-Z0-9_]*__/.test(text),
  "Factory instructions must be plain text without CEL or bootstrap placeholders.",
);
const FactorySkills = z.array(Name).min(1).max(16);

/** Supported customizations of bootstrap's protected base lifecycle. */
export const FactorySchema = z.strictObject({
  base: z.literal("bootstrap-default"),
  stages: z.array(
    z.strictObject({
      stage: z.enum(["planning", "plan-review", "implementing", "code-review"]),
      instructions: FactoryInstructions.optional(),
      skills: FactorySkills.optional(),
    }).refine(
      (stage) => stage.instructions !== undefined || stage.skills !== undefined,
      "A stage customization needs instructions or skills.",
    ),
  ).max(4).optional(),
  reviews: z.array(z.strictObject({
    id: z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    after: z.enum(["plan-review", "code-review"]),
    instructions: FactoryInstructions,
    skills: FactorySkills.optional(),
    requireApproval: z.boolean().optional(),
  })).max(8).optional(),
}).superRefine((factory, context) => {
  const stages = factory.stages ?? [];
  if (new Set(stages.map((stage) => stage.stage)).size !== stages.length) {
    context.addIssue({
      code: "custom",
      path: ["stages"],
      message: "Customize each base stage only once.",
    });
  }
  const reserved = new Set([
    "import-context",
    "planning",
    "plan-review",
    "implementing",
    "verification",
    "code-review",
    "ready",
    "aborted",
    "project-context",
    "plan",
    "change-summary",
    "verification-run",
    "verification-seal",
  ]);
  for (const [index, review] of (factory.reviews ?? []).entries()) {
    if (reserved.has(review.id)) {
      context.addIssue({
        code: "custom",
        path: ["reviews", index, "id"],
        message:
          "Review IDs must be unique and must not reuse a base stage, artifact, or evidence name.",
      });
    }
    reserved.add(review.id);
  }
});
/** Optional project-owned factory choices; omitted fields retain base behavior. */
export type Factory = z.infer<typeof FactorySchema>;

/** A real check executed through an existing Swamp model type. */
export const CheckSchema = z.strictObject({
  name: Name,
  modelType: z.string().regex(/^@[a-z0-9_-]+\/[a-z0-9_/-]+$/),
  methodName: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  globalArgs: JsonObject,
  inputs: JsonObject,
  command: Text.describe(
    "Human-readable command or behavior this check executes",
  ),
});

/** Project-owned configuration; contains references, never credential values. */
export const ProjectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: Name,
  title: Text,
  purpose: Text,
  agentTool: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).refine(
    (tool) => tool !== "none",
    "Select a Swamp-integrated agent; 'none' does not install agent scaffolding.",
  ).describe(
    "Selected Swamp agent tool ID; verify enrollment with the bootstrap skill",
  ),
  documents: z.array(z.strictObject({
    role: z.enum([
      "instructions",
      "conventions",
      "system-context",
      "containers",
      "decision",
      "architecture-skill",
      "review-guidance",
    ]),
    path: Text,
  })).min(7).max(64),
  decisions: z.array(Text).min(1).max(64),
  skills: z.array(Name).min(1).max(16),
  factory: FactorySchema.optional(),
  dependencies: z.array(
    z.strictObject({
      name: z.string().regex(/^@[a-z0-9_-]+\/[a-z0-9_/-]+$/),
      version: z.string().regex(/^\d{4}\.\d{2}\.\d{2}\.\d+$/),
    }),
  ).min(2).max(32),
  issueIntegration: z.strictObject({
    provider: z.enum(["local", "gitlab", "github", "forgejo", "swamp"]),
    scope: Text.describe(
      "Stable project/repository identity, including host for remote trackers",
    ),
    modelName: Text.optional(),
    readMethod: Text.optional(),
    extension: Text.optional(),
  }),
  policy: z.strictObject({
    materialDecisions: z.literal("explicit-approval"),
    externalActions: z.literal("explicit-approval"),
    requirePlanApproval: z.boolean(),
    requireDeliveryApproval: z.boolean(),
    maxCycles: z.number().int().min(1).max(5),
  }),
  verification: z.strictObject({
    sourcePaths: z.array(Text).min(1).max(32),
    checks: z.array(CheckSchema).min(1).max(16),
  }),
});
/** Parsed project configuration. */
export type Project = z.infer<typeof ProjectSchema>;
/** A pinned, readable document. */
export const DocumentSchema = z.strictObject({
  path: Text,
  sha256: Digest,
  content: z.string().min(1),
});
/** Complete candidate or accepted baseline. */
export const BaselineSchema = z.strictObject({
  schemaVersion: z.literal(1),
  baselineId: Digest,
  projectId: Name,
  specPath: Text,
  spec: ProjectSchema,
  documents: z.array(DocumentSchema),
  factoryTemplate: JsonObject,
  verificationTemplate: JsonObject,
  createdAt: z.iso.datetime(),
  acceptance: z.strictObject({
    actor: Text,
    reference: Text,
    acceptedAt: z.iso.datetime(),
    validation: Text,
  }).nullable(),
});
/** Accepted or candidate project snapshot. */
export type Baseline = z.infer<typeof BaselineSchema>;
/** Exact scaffold identities allocated by Swamp, never generated by bootstrap. */
export const BindingSchema = z.strictObject({
  factoryId: z.uuid(),
  factoryPath: Text,
  workflowId: z.uuid(),
  workflowPath: Text,
});
/** Stable item reservation and its execution mapping. */
export const ItemSchema = z.strictObject({
  workItem: z.string().regex(/^item-[a-f0-9]{40}$/),
  reference: Text,
  provider: Text,
  scope: Text,
  baselineId: Digest,
  factoryName: z.string(),
  workflowName: z.string(),
  workspace: Text,
  active: z.boolean(),
  binding: BindingSchema.nullable(),
});
/** Stable work-item reservation. */
export type Item = z.infer<typeof ItemSchema>;
/** Single-controller registry; Swamp serializes this model's methods. */
export const RegistrySchema = z.strictObject({
  projectId: Name,
  baselineId: Digest,
  items: z.array(ItemSchema).max(1000),
});
/** Assembled, ID-free definitions ready to apply to Swamp-created scaffolds. */
export const AssemblySchema = z.strictObject({
  item: ItemSchema,
  factoryArguments: JsonObject,
  workflow: JsonObject,
});
/** Verification proof. The workflow records this in its own factory. */
export const VerificationSchema = z.strictObject({
  workItem: z.string(),
  baselineId: Digest,
  sourceDigest: Digest,
  status: z.literal("succeeded"),
});
/** Minimal method context used by the controller. */
export interface Context {
  repoDir: string;
  globalArgs: { specPath: string };
  definition: { name: string; id: string };
  logger: { info(message: string, properties?: Record<string, unknown>): void };
  readResource(
    name: string,
    version?: number,
  ): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ): Promise<{ name: string }>;
  dataRepository: {
    getContent(
      type: string,
      id: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
  queryData?: (predicate: string) => Promise<unknown[]>;
}
