/** Accept project control planes and allocate isolated software factories. @module */
import { z } from "npm:zod@4";
import { parse } from "npm:yaml@2.8.3";
import {
  canonical,
  readProjectText,
  resolveWorkspace,
  sha256,
  sourceDigest,
  validateSourcePaths,
} from "./files.ts";
import { createFactoryArguments } from "./templates.ts";
import { createVerificationTemplate, substitute } from "./workflows.ts";
import {
  AssemblySchema,
  type Baseline,
  BaselineSchema,
  BindingSchema,
  type Context,
  Digest,
  DocumentSchema,
  ENGINE_VERSION,
  type Item,
  ItemSchema,
  ProjectSchema,
  RegistrySchema,
  VerificationSchema,
  VERSION,
} from "./schema.ts";

const Text = z.string().trim().min(1).max(2000);
// Swamp merges global inputs into method inputs. Strip those extra keys here.
const Empty = z.object({});
const WorkItemArgs = z.object({ workItem: ItemSchema.shape.workItem });
const VerifyArgs = WorkItemArgs.extend({
  baselineId: Digest,
  expectedDigest: Digest,
});
const ContextSchema = z.strictObject({
  baselineId: Digest,
  workItem: z.string(),
  documents: z.array(DocumentSchema),
  spec: ProjectSchema,
});
const ReadinessSchema = z.strictObject({
  configurationReady: z.boolean(),
  operationallyVerified: z.boolean(),
  baselineId: Digest.nullable(),
  activeItems: z.number().int(),
  configuredItems: z.number().int(),
  blockers: z.array(z.string()),
});
const InspectionSchema = z.strictObject({
  specPath: Text,
  configured: z.boolean().describe(
    "The project specification file exists, even if incomplete",
  ),
  acceptedBaselineId: Digest.nullable(),
  instructionsPresent: z.boolean().describe(
    "All instructions documents listed in the project specification exist; false without a configured inventory",
  ),
  status: z.enum([
    "needs-details",
    "needs-configuration",
    "ready-for-check",
    "invalid-configuration",
  ]),
  nextQuestion: Text.nullable(),
  issues: z.array(Text),
  nextAction: Text,
});
const DigestSchema = z.strictObject({
  workItem: z.string(),
  sourceDigest: Digest,
  fileCount: z.number().int().positive(),
});
const resourceSchemas = {
  baseline: BaselineSchema,
  registry: RegistrySchema,
  assembly: AssemblySchema,
  context: ContextSchema,
  readiness: ReadinessSchema,
  inspection: InspectionSchema,
  digest: DigestSchema,
  verification: VerificationSchema,
};
type SpecName = keyof typeof resourceSchemas;
type Result = { dataHandles: { name: string }[] };

async function emit(
  context: Context,
  spec: SpecName,
  name: string,
  value: unknown,
): Promise<Result> {
  // Swamp warns on schema mismatches; parse here to fail closed instead.
  const data = resourceSchemas[spec].parse(value);
  const handle = await context.writeResource(spec, name, data);
  context.logger.info("Bootstrap wrote {spec} {name}", { spec, name });
  return { dataHandles: [handle] };
}

async function registry(
  context: Context,
): Promise<z.infer<typeof RegistrySchema>> {
  const raw = await context.readResource("registry");
  if (!raw) {
    throw new Error(
      "No accepted baseline. Run check, validate its templates, then accept the exact baseline digest.",
    );
  }
  return RegistrySchema.parse(raw);
}

async function baseline(context: Context, id: string): Promise<Baseline> {
  const value = BaselineSchema.parse(
    await context.readResource(`baseline-${id}`),
  );
  if (value.baselineId !== id || !value.acceptance) {
    throw new Error("Accepted baseline is missing or inconsistent.");
  }
  return value;
}

async function findItem(
  context: Context,
  workItem: string,
): Promise<
  { state: z.infer<typeof RegistrySchema>; item: Item; base: Baseline }
> {
  const state = await registry(context);
  const item = state.items.find((entry) => entry.workItem === workItem);
  if (!item) throw new Error("Work item is not reserved. Run intake first.");
  return { state, item, base: await baseline(context, item.baselineId) };
}

function checkSecrets(value: unknown): void {
  if (typeof value === "string") {
    if (/\$\{\{(?:(?!\}\})[\s\S])*?\bvault\s*(?:\.|\[)/.test(value)) {
      throw new Error(
        "Executable vault expressions cannot enter a project snapshot. Keep authentication in provider configuration or environment outside the snapshot.",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) checkSecrets(entry);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      /token|password|secret|credential|api.?key|authorization|cookie/i.test(
        key,
      )
    ) {
      throw new Error(
        `Credential field '${key}' cannot enter a project snapshot. Configure authentication outside the baseline.`,
      );
    }
    checkSecrets(entry);
  }
}

async function capture(context: Context): Promise<Baseline> {
  const specPath = context.globalArgs.specPath;
  const rawSpec = await readProjectText(context.repoDir, specPath);
  const spec = ProjectSchema.parse(JSON.parse(rawSpec));
  // Check decoded strings too: escaped JSON must not hide an executable reference.
  checkSecrets(spec);
  validateSourcePaths(spec.verification.sourcePaths);
  const roles = new Set(spec.documents.map((doc) => doc.role));
  for (
    const role of [
      "instructions",
      "conventions",
      "system-context",
      "containers",
      "decision",
      "architecture-skill",
      "review-guidance",
    ]
  ) {
    if (!roles.has(role as (typeof spec.documents)[number]["role"])) {
      throw new Error(`Missing control-plane document role: ${role}`);
    }
  }
  const paths = [specPath, ...spec.documents.map((doc) => doc.path)];
  if (new Set(paths).size !== paths.length) {
    throw new Error(
      "Document paths must be unique and must not repeat the project specification.",
    );
  }
  const selectedSkills = new Set([
    ...spec.skills,
    ...(spec.factory?.stages ?? []).flatMap((stage) => stage.skills ?? []),
    ...(spec.factory?.reviews ?? []).flatMap((review) => review.skills ?? []),
  ]);
  for (const skill of selectedSkills) {
    if (
      !spec.documents.some((doc) =>
        doc.path === `${skill}/SKILL.md` ||
        doc.path.endsWith(`/${skill}/SKILL.md`)
      )
    ) {
      throw new Error(
        `Include the selected skill ${skill}/SKILL.md from its project-local skill directory in documents.`,
      );
    }
  }
  for (
    const [name, version] of [["@swamp/software-factory", ENGINE_VERSION], [
      "@jamesakeech/bootstrap",
      VERSION,
    ]]
  ) {
    if (
      !spec.dependencies.some((dep) =>
        dep.name === name && dep.version === version
      )
    ) throw new Error(`Record the tested dependency ${name}@${version}.`);
  }
  if (
    new Set(spec.dependencies.map((dep) => dep.name)).size !==
      spec.dependencies.length
  ) throw new Error("Dependency names must be unique.");
  if (spec.issueIntegration.provider !== "local") {
    const integration = spec.issueIntegration;
    if (
      !integration.modelName || !integration.readMethod ||
      !integration.extension || !spec.dependencies.some((dep) =>
        dep.name === integration.extension
      )
    ) {
      throw new Error(
        "A remote tracker needs its installed extension/version, modelName and readMethod. Use local intake until that integration is configured.",
      );
    }
  }
  const checkNames = spec.verification.checks.map((check) => check.name);
  if (
    new Set(checkNames).size !== checkNames.length ||
    checkNames.some((name) => ["begin", "seal", "record"].includes(name))
  ) {
    throw new Error(
      "Verification check names must be unique and cannot be begin, seal, or record.",
    );
  }
  for (const check of spec.verification.checks) {
    if (
      ["@swamp/software-factory", "@jamesakeech/bootstrap"].includes(
        check.modelType,
      )
    ) {
      throw new Error(
        "Verification checks must perform real project checks, not call bootstrap or factory control methods.",
      );
    }
    if (
      !spec.dependencies.some((dep) =>
        check.modelType === dep.name ||
        check.modelType.startsWith(`${dep.name}/`)
      )
    ) {
      throw new Error(
        `Record the dependency that provides ${check.modelType}.`,
      );
    }
    checkSecrets(check);
  }
  const documents = [];
  let documentBytes = 0;
  for (const path of paths) {
    const content = path === specPath
      ? rawSpec
      : await readProjectText(context.repoDir, path);
    checkSecrets(content);
    documentBytes += new TextEncoder().encode(content).byteLength;
    if (documentBytes > 8 * 1024 * 1024) {
      throw new Error(
        "Control-plane snapshot exceeds 8 MiB. Reduce the selected documents.",
      );
    }
    if (!content.trim() || content.includes("__BOOTSTRAP_DRAFT__")) {
      throw new Error(
        `Finish the control-plane document before acceptance: ${path}`,
      );
    }
    documents.push({ path, sha256: await sha256(content), content });
  }
  const factoryTemplate = createFactoryArguments({
    bootstrapModel: "__BOOTSTRAP_MODEL__",
    workItem: "__WORK_ITEM__",
    baselineId: "__BASELINE_ID__",
    workflowName: "__VERIFY_WORKFLOW__",
    contextPaths: paths,
    skills: spec.skills,
    factory: spec.factory,
    maxCycles: spec.policy.maxCycles,
    requirePlanApproval: spec.policy.requirePlanApproval,
    requireDeliveryApproval: spec.policy.requireDeliveryApproval,
  });
  const verificationTemplate = createVerificationTemplate(spec);
  const content = {
    schemaVersion: 1 as const,
    projectId: spec.projectId,
    specPath,
    spec,
    documents,
    factoryTemplate,
    verificationTemplate,
  };
  return {
    ...content,
    baselineId: await sha256(canonical(content)),
    createdAt: new Date().toISOString(),
    acceptance: null,
  };
}

async function assertCurrentFiles(
  context: Context,
  base: Baseline,
  workspace = ".",
): Promise<void> {
  const root = await resolveWorkspace(context.repoDir, workspace);
  for (const doc of base.documents) {
    if (await sha256(await readProjectText(root, doc.path)) !== doc.sha256) {
      throw new Error(
        `Accepted control-plane file changed: ${doc.path}. Restore the pinned content or explicitly accept a new baseline for new items.`,
      );
    }
  }
}

async function assembly(
  context: Context,
  item: Item,
  base: Baseline,
): Promise<z.infer<typeof AssemblySchema>> {
  const workspace = await resolveWorkspace(context.repoDir, item.workspace);
  const replacements: Record<string, string> = {
    __WORK_ITEM__: item.workItem,
    __BASELINE_ID__: item.baselineId,
    __VERIFY_WORKFLOW__: item.workflowName,
    __BOOTSTRAP_MODEL__: context.definition.name,
    __FACTORY_NAME__: item.factoryName,
    __WORKSPACE__: workspace,
    __SEAL_EXPRESSION__: `\u0024{{ data.latest(${
      JSON.stringify(context.definition.name)
    }, ${JSON.stringify(`verification-${item.workItem}`)}).attributes }}`,
  };
  for (const [index, check] of base.spec.verification.checks.entries()) {
    replacements[`__CHECK_${check.name}__`] = `${item.factoryName}-check-${
      index + 1
    }`;
  }
  return AssemblySchema.parse({
    item,
    factoryArguments: substitute(base.factoryTemplate, replacements),
    workflow: substitute(base.verificationTemplate, replacements),
  });
}

async function assertBinding(
  context: Context,
  item: Item,
  base: Baseline,
): Promise<void> {
  if (!item.binding) {
    throw new Error(
      "Work item has no bound definitions. Create the returned scaffolds, validate them, then bind.",
    );
  }
  const expected = await assembly(context, item, base);
  const factory = z.object({
    id: z.uuid(),
    name: z.string(),
    type: z.string(),
    typeVersion: z.string(),
    globalArguments: z.unknown(),
  }).parse(
    parse(await readProjectText(context.repoDir, item.binding.factoryPath)),
  );
  if (
    factory.id !== item.binding.factoryId ||
    factory.name !== item.factoryName ||
    factory.type !== "@swamp/software-factory" ||
    factory.typeVersion !== ENGINE_VERSION ||
    canonical(factory.globalArguments) !== canonical(expected.factoryArguments)
  ) {
    throw new Error(
      "Factory definition differs from the reserved baseline, name, ID, or supported engine version.",
    );
  }
  const workflow = z.record(z.string(), z.unknown()).parse(
    parse(await readProjectText(context.repoDir, item.binding.workflowPath)),
  );
  if (workflow.id !== item.binding.workflowId) {
    throw new Error("Workflow ID does not match its Swamp-created scaffold.");
  }
  const { id: _id, ...body } = workflow;
  // Swamp's scaffold may include empty tags and a definition revision.
  if (body.tags && canonical(body.tags) === "{}") delete body.tags;
  if (body.version === 1) delete body.version;
  if (canonical(body) !== canonical(expected.workflow)) {
    throw new Error(
      "Verification workflow differs from the accepted template. Do not share or weaken it.",
    );
  }
}

async function readFactoryState(
  context: Context,
  item: Item,
): Promise<Record<string, unknown> | null> {
  if (!item.binding) return null;
  const raw = await context.dataRepository.getContent(
    "@swamp/software-factory",
    item.binding.factoryId,
    `state-${item.workItem}`,
  );
  return raw
    ? z.record(z.string(), z.unknown()).parse(
      JSON.parse(new TextDecoder().decode(raw)),
    )
    : null;
}

async function verifyInputs(
  context: Context,
  args: z.infer<typeof VerifyArgs>,
): Promise<{ item: Item; base: Baseline }> {
  const { item, base } = await findItem(context, args.workItem);
  if (!item.active || item.baselineId !== args.baselineId) {
    throw new Error(
      "Verification requires an active work item and its pinned baseline.",
    );
  }
  await assertBinding(context, item, base);
  await assertCurrentFiles(context, base, item.workspace);
  const current = await sourceDigest(
    context.repoDir,
    item.workspace,
    base.spec.verification.sourcePaths,
  );
  if (current.sourceDigest !== args.expectedDigest) {
    throw new Error(
      "Source digest changed. Record the current implementation and rerun verification.",
    );
  }
  const state = await readFactoryState(context, item);
  if (state?.stageId !== "verification" || state.status !== "active") {
    throw new Error("The factory must be in its verification stage.");
  }
  return { item, base };
}

/** Bootstrap controller. Keep exactly one instance per project repository. */
export const model = {
  type: "@jamesakeech/bootstrap",
  version: "2026.09.06.6",
  upgrades: [{
    toVersion: "2026.09.06.2",
    description:
      "Enable readiness reporting; preserve the unchanged configuration schema.",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }, {
    toVersion: "2026.09.06.3",
    description:
      "Support native Swamp agent layouts; preserve existing specPath arguments and accepted baselines.",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }, {
    toVersion: "2026.09.06.4",
    description:
      "Guide first-run project discovery; preserve existing specPath arguments and accepted baselines.",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }, {
    toVersion: "2026.09.06.5",
    description:
      "Offer architecture philosophy selection and matching skills; preserve arguments and accepted baselines.",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }, {
    toVersion: "2026.09.06.6",
    description:
      "Add optional project factory customization; preserve specPath arguments and accepted templates.",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }],
  reports: ["@jamesakeech/bootstrap/readiness"],
  globalArguments: z.strictObject({
    specPath: Text.default("docs/bootstrap/project.json"),
  }),
  resources: Object.fromEntries(
    Object.entries(resourceSchemas).map((
      [name, schema],
    ) => [name, {
      description: `Bootstrap ${name}`,
      schema,
      lifetime: "infinite",
      garbageCollection: name === "baseline" ? 1 : 20,
    }]),
  ),
  methods: {
    inspect: {
      description:
        "Inspect project entry points and return the next onboarding action for the active agent; change no project files.",
      kind: "read" as const,
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<Result> => {
        context.logger.info("Inspecting bootstrap entry points");
        const readOptional = async (path: string): Promise<string | null> => {
          try {
            return await readProjectText(context.repoDir, path);
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) return null;
            throw error;
          }
        };
        const text = await readOptional(context.globalArgs.specPath);
        const current = await context.readResource("registry");
        const acceptedBaselineId = current
          ? RegistrySchema.parse(current).baselineId
          : null;
        const inspection: z.infer<typeof InspectionSchema> = {
          specPath: context.globalArgs.specPath,
          configured: text !== null,
          acceptedBaselineId,
          instructionsPresent: false,
          status: "invalid-configuration",
          nextQuestion: null,
          issues: [],
          nextAction:
            "Use the bootstrap skill to repair the existing project specification without discarding known details.",
        };
        let raw: unknown;
        try {
          raw = text?.trim() ? JSON.parse(text) : {};
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // Do not echo JSON parse errors: they can include credential values.
          inspection.issues = ["Project specification is not valid JSON."];
        }
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          const parsed = ProjectSchema.safeParse(raw);
          if (!parsed.success) {
            // Group by fixed schema keys, without persisting user values or unknown keys.
            const fields = Object.keys(ProjectSchema.shape).filter((field) =>
              parsed.error.issues.some((issue) => issue.path[0] === field)
            );
            inspection.issues = fields.map((field) =>
              `Complete or correct ${field}.`
            );
            if (parsed.error.issues.some((issue) => issue.path.length === 0)) {
              inspection.issues.push(
                "Remove unsupported project specification fields.",
              );
            }
          }
          const purpose = (raw as Record<string, unknown>).purpose;
          const hasPurpose = typeof purpose === "string" &&
            purpose.trim().length > 0 &&
            !purpose.includes("__BOOTSTRAP_DRAFT__");
          inspection.status = hasPurpose || acceptedBaselineId
            ? "needs-configuration"
            : "needs-details";
          inspection.nextAction = acceptedBaselineId
            ? "Use the bootstrap skill to resume from the accepted baseline and reconcile project files; do not restart discovery."
            : "Use the bootstrap skill to reuse known details, ask only missing project questions, and draft the control plane.";
          if (!hasPurpose && !acceptedBaselineId) {
            inspection.nextQuestion =
              "What would you like to build, and who is it for?";
          }
          if (parsed.success) {
            const instructions = parsed.data.documents.filter((doc) =>
              doc.role === "instructions"
            );
            inspection.instructionsPresent = instructions.length > 0 &&
              (await Promise.all(
                instructions.map((doc) => readOptional(doc.path)),
              ))
                .every((content) => content !== null);
            if (!inspection.instructionsPresent) {
              inspection.issues.push(
                "Complete the native instruction document inventory and restore missing files.",
              );
            }
            if (hasPurpose && inspection.instructionsPresent) {
              inspection.status = "ready-for-check";
              inspection.nextAction =
                "Run check and review the candidate baseline; inspection does not validate or accept it.";
            }
          }
        } else if (inspection.issues.length === 0) {
          inspection.issues = ["Project specification must be a JSON object."];
        }
        return emit(context, "inspection", "inspection", inspection);
      },
    },
    check: {
      description:
        "Snapshot and structurally validate the complete project control plane and templates.",
      kind: "read" as const,
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<Result> => {
        context.logger.info(
          "Checking project documents and template configuration",
        );
        const candidate = await capture(context);
        const current = await context.readResource("registry");
        if (
          current &&
          RegistrySchema.parse(current).projectId !== candidate.projectId
        ) {
          throw new Error(
            "Do not change projectId on an existing bootstrap controller.",
          );
        }
        return emit(context, "baseline", "candidate", candidate);
      },
    },
    preview: {
      description:
        "Assemble candidate templates for CLI validation before acceptance; allocate no IDs.",
      kind: "read" as const,
      arguments: z.object({ workspace: Text.default(".") }),
      execute: async (
        args: { workspace: string },
        context: Context,
      ): Promise<Result> => {
        context.logger.info("Preparing candidate definitions for validation");
        const candidate = BaselineSchema.parse(
          await context.readResource("candidate"),
        );
        const hash = await sha256(`preview:${candidate.baselineId}`);
        const item: Item = {
          workItem: `item-${hash.slice(0, 40)}`,
          reference: "baseline-preview",
          provider: "local",
          scope: candidate.projectId,
          baselineId: candidate.baselineId,
          factoryName: `bootstrap-preview-${hash.slice(0, 16)}`,
          workflowName: `bootstrap-preview-verify-${hash.slice(0, 16)}`,
          workspace: args.workspace,
          active: false,
          binding: null,
        };
        return emit(
          context,
          "assembly",
          "preview",
          await assembly(context, item, candidate),
        );
      },
    },
    accept: {
      description:
        "Record explicit acceptance of an unchanged, CLI-validated baseline digest. Approval is an audit record, not authentication.",
      kind: "action" as const,
      arguments: z.object({
        baselineId: Digest,
        actor: Text,
        reference: Text,
        validation: Text.describe(
          "Reference to successful factory/workflow validation and installed-version checks",
        ),
      }),
      execute: async (
        args: {
          baselineId: string;
          actor: string;
          reference: string;
          validation: string;
        },
        context: Context,
      ): Promise<Result> => {
        context.logger.info(
          "Checking exact baseline before recording acceptance",
        );
        const candidate = BaselineSchema.parse(
          await context.readResource("candidate"),
        );
        const fresh = await capture(context);
        if (
          candidate.baselineId !== args.baselineId ||
          fresh.baselineId !== args.baselineId
        ) {
          throw new Error(
            "Candidate changed since review. Run check and validate again, then approve the new digest.",
          );
        }
        const raw = await context.readResource("registry");
        const state = raw ? RegistrySchema.parse(raw) : {
          projectId: candidate.projectId,
          baselineId: candidate.baselineId,
          items: [],
        };
        if (state.projectId !== candidate.projectId) {
          throw new Error("Project identity cannot change.");
        }
        const stored = await context.readResource(
          `baseline-${args.baselineId}`,
        );
        const handles: { name: string }[] = [];
        if (!stored) {
          const acceptedAt = new Date().toISOString();
          handles.push(
            ...(await emit(context, "baseline", `baseline-${args.baselineId}`, {
              ...candidate,
              acceptance: {
                actor: args.actor,
                reference: args.reference,
                acceptedAt,
                validation: args.validation,
              },
            })).dataHandles,
          );
        } else if (!BaselineSchema.parse(stored).acceptance) {
          throw new Error("Existing baseline is not accepted.");
        }
        // Snapshot first, pointer last: interrupted acceptance can safely resume.
        handles.push(
          ...(await emit(context, "registry", "registry", {
            ...state,
            baselineId: args.baselineId,
          })).dataHandles,
        );
        return { dataHandles: handles };
      },
    },
    intake: {
      description:
        "Reserve or resume a stable work item and return its isolated factory/workflow templates.",
      kind: "action" as const,
      arguments: z.object({
        reference: Text,
        provider: z.enum(["local", "gitlab", "github", "forgejo", "swamp"])
          .default("local"),
        workspace: Text.default("."),
      }),
      execute: async (
        args: { reference: string; provider: string; workspace: string },
        context: Context,
      ): Promise<Result> => {
        context.logger.info("Reserving work-item factory identity");
        const state = await registry(context);
        const current = await baseline(context, state.baselineId);
        if (
          args.provider !== "local" &&
          args.provider !== current.spec.issueIntegration.provider
        ) {
          throw new Error(
            "This issue provider is not configured in the accepted baseline.",
          );
        }
        const scope = args.provider === "local"
          ? state.projectId
          : current.spec.issueIntegration.scope;
        const hash = await sha256(
          canonical({
            projectId: state.projectId,
            provider: args.provider,
            scope,
            reference: args.reference,
          }),
        );
        // The pinned factory engine rewrites names longer than 48 characters.
        const key = `item-${hash.slice(0, 40)}`;
        const found = state.items.find((item) => item.workItem === key);
        let item: Item;
        let base: Baseline;
        if (found) {
          if (
            found.reference !== args.reference ||
            found.provider !== args.provider || found.scope !== scope
          ) {
            throw new Error(
              "Work-item identity digest collision; no existing allocation was changed.",
            );
          }
          if (found.workspace !== args.workspace) {
            throw new Error(
              "Work item already has a workspace. Resume it there; do not rebind implicitly.",
            );
          }
          item = found;
          base = await baseline(context, found.baselineId);
        } else {
          await assertCurrentFiles(context, current, args.workspace);
          item = {
            workItem: key,
            reference: args.reference,
            provider: args.provider,
            scope,
            baselineId: current.baselineId,
            factoryName: `factory-${hash.slice(0, 40)}`,
            workflowName: `verify-${hash.slice(0, 40)}`,
            workspace: args.workspace,
            active: false,
            binding: null,
          };
          base = current;
        }
        const prepared = await assembly(context, item, base);
        const handles: { name: string }[] = [];
        if (!found) {
          handles.push(
            ...(await emit(context, "registry", "registry", {
              ...state,
              items: [...state.items, item],
            })).dataHandles,
          );
        }
        handles.push(
          ...(await emit(context, "assembly", `assembly-${key}`, prepared))
            .dataHandles,
        );
        return { dataHandles: handles };
      },
    },
    bind: {
      description:
        "Verify and bind the actual Swamp-created model and workflow definitions to a reservation.",
      kind: "action" as const,
      arguments: WorkItemArgs.extend({ binding: BindingSchema }),
      execute: async (
        args: { workItem: string; binding: z.infer<typeof BindingSchema> },
        context: Context,
      ): Promise<Result> => {
        context.logger.info(
          "Verifying allocated factory and workflow definitions",
        );
        const { state, item, base } = await findItem(context, args.workItem);
        if (
          item.binding && canonical(item.binding) !== canonical(args.binding)
        ) {
          throw new Error(
            "An existing binding cannot be replaced. Resume its original IDs.",
          );
        }
        const proposed = { ...item, binding: args.binding };
        for (const other of state.items) {
          if (
            other.workItem !== item.workItem && other.binding &&
            (other.binding.factoryId === args.binding.factoryId ||
              other.binding.workflowId === args.binding.workflowId ||
              other.binding.factoryPath === args.binding.factoryPath ||
              other.binding.workflowPath === args.binding.workflowPath)
          ) throw new Error("Another work item owns these definitions.");
        }
        await assertBinding(context, proposed, base);
        return emit(context, "registry", "registry", {
          ...state,
          items: state.items.map((entry) =>
            entry.workItem === item.workItem ? proposed : entry
          ),
        });
      },
    },
    activate: {
      description:
        "Acquire the work item's workspace before coding; reject overlapping active workspaces.",
      kind: "action" as const,
      arguments: WorkItemArgs,
      execute: async (
        args: { workItem: string },
        context: Context,
      ): Promise<Result> => {
        context.logger.info("Checking workspace isolation before activation");
        const { state, item, base } = await findItem(context, args.workItem);
        await assertBinding(context, item, base);
        await assertCurrentFiles(context, base, item.workspace);
        const root = await resolveWorkspace(context.repoDir, item.workspace);
        for (
          const other of state.items.filter((entry) =>
            entry.active && entry.workItem !== item.workItem
          )
        ) {
          const otherRoot = await resolveWorkspace(
            context.repoDir,
            other.workspace,
          );
          if (
            root === otherRoot || root.startsWith(`${otherRoot}/`) ||
            otherRoot.startsWith(`${root}/`)
          ) {
            throw new Error(
              "Another active work item owns an overlapping workspace. Finish it or allocate a separate directory/worktree inside this repository.",
            );
          }
        }
        return emit(context, "registry", "registry", {
          ...state,
          items: state.items.map((entry) =>
            entry.workItem === item.workItem
              ? { ...entry, active: true }
              : entry
          ),
        });
      },
    },
    release: {
      description:
        "Release a workspace after its factory reaches a terminal stage; retain all history.",
      kind: "action" as const,
      arguments: WorkItemArgs,
      execute: async (
        args: { workItem: string },
        context: Context,
      ): Promise<Result> => {
        context.logger.info(
          "Checking terminal factory state before workspace release",
        );
        const { state, item } = await findItem(context, args.workItem);
        const factoryState = await readFactoryState(context, item);
        if (factoryState && factoryState.status !== "terminal") {
          throw new Error(
            "Factory is not terminal. Resume it or explicitly approve its abort transition first.",
          );
        }
        return emit(context, "registry", "registry", {
          ...state,
          items: state.items.map((entry) =>
            entry.workItem === item.workItem
              ? { ...entry, active: false }
              : entry
          ),
        });
      },
    },
    context: {
      description:
        "Return the pinned context for one reserved item, never the latest baseline.",
      kind: "read" as const,
      arguments: WorkItemArgs,
      execute: async (
        args: { workItem: string },
        context: Context,
      ): Promise<Result> => {
        context.logger.info("Reading pinned project context");
        const { item, base } = await findItem(context, args.workItem);
        return emit(context, "context", `context-${item.workItem}`, {
          baselineId: item.baselineId,
          workItem: item.workItem,
          documents: base.documents,
          spec: base.spec,
        });
      },
    },
    source_digest: {
      description:
        "Hash the configured implementation inputs, including new and removed files.",
      kind: "read" as const,
      arguments: WorkItemArgs,
      execute: async (
        args: { workItem: string },
        context: Context,
      ): Promise<Result> => {
        context.logger.info("Hashing work-item source inputs");
        const { item, base } = await findItem(context, args.workItem);
        return emit(context, "digest", `digest-${item.workItem}`, {
          workItem: item.workItem,
          ...await sourceDigest(
            context.repoDir,
            item.workspace,
            base.spec.verification.sourcePaths,
          ),
        });
      },
    },
    begin_verification: {
      description:
        "Check baseline, definitions, workspace and implementation digest before real checks.",
      kind: "read" as const,
      arguments: VerifyArgs,
      execute: async (
        args: z.infer<typeof VerifyArgs>,
        context: Context,
      ): Promise<Result> => {
        context.logger.info("Checking verification input provenance");
        await verifyInputs(context, args);
        return emit(
          context,
          "verification",
          `verification-start-${args.workItem}`,
          {
            workItem: args.workItem,
            baselineId: args.baselineId,
            sourceDigest: args.expectedDigest,
            status: "succeeded",
          },
        );
      },
    },
    seal_verification: {
      description:
        "Verify unchanged inputs after checks; the DAG must then record this seal in its factory.",
      kind: "read" as const,
      arguments: VerifyArgs,
      execute: async (
        args: z.infer<typeof VerifyArgs>,
        context: Context,
      ): Promise<Result> => {
        context.logger.info("Checking verification inputs remained unchanged");
        await verifyInputs(context, args);
        const started = VerificationSchema.parse(
          await context.readResource(`verification-start-${args.workItem}`),
        );
        if (
          started.baselineId !== args.baselineId ||
          started.sourceDigest !== args.expectedDigest
        ) {
          throw new Error(
            "Verification start does not match this implementation and baseline.",
          );
        }
        return emit(
          context,
          "verification",
          `verification-${args.workItem}`,
          started,
        );
      },
    },
    readiness: {
      description:
        "Distinguish accepted configuration from successful execution with correlated workflow evidence.",
      kind: "read" as const,
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<Result> => {
        context.logger.info(
          "Checking project readiness and execution evidence",
        );
        const raw = await context.readResource("registry");
        if (!raw) {
          return emit(context, "readiness", "readiness", {
            configurationReady: false,
            operationallyVerified: false,
            baselineId: null,
            activeItems: 0,
            configuredItems: 0,
            blockers: ["No accepted baseline"],
          });
        }
        const state = RegistrySchema.parse(raw);
        const base = await baseline(context, state.baselineId);
        const blockers: string[] = [];
        try {
          await assertCurrentFiles(context, base);
        } catch (error) {
          blockers.push(error instanceof Error ? error.message : String(error));
        }
        let verified = false;
        for (
          const item of state.items.filter((entry) =>
            entry.binding && entry.baselineId === state.baselineId
          )
        ) {
          const summaryRaw = await context.dataRepository.getContent(
            "workflow",
            item.binding!.workflowId,
            "report-swamp-workflow-summary-json",
          );
          if (!summaryRaw) continue;
          const summary = z.object({
            status: z.string(),
            workflowName: z.string(),
            workflowRunId: z.string(),
          }).parse(JSON.parse(new TextDecoder().decode(summaryRaw)));
          if (
            summary.status !== "succeeded" ||
            summary.workflowName !== item.workflowName
          ) continue;
          if (!context.queryData) continue;
          const evidenceName = `evidence-${item.workItem}-verification-seal`;
          const records = await context.queryData(
            `workflowRunId == ${
              JSON.stringify(summary.workflowRunId)
            } && modelName == ${JSON.stringify(item.factoryName)} && name == ${
              JSON.stringify(evidenceName)
            }`,
          );
          if (records.length !== 1) continue;
          const record = z.object({ version: z.number().int().positive() })
            .parse(records[0]);
          const rawProof = await context.dataRepository.getContent(
            "@swamp/software-factory",
            item.binding!.factoryId,
            evidenceName,
            record.version,
          );
          if (!rawProof) continue;
          const proof = VerificationSchema.parse(
            z.object({ payload: z.unknown() }).parse(
              JSON.parse(new TextDecoder().decode(rawProof)),
            ).payload,
          );
          try {
            await assertBinding(context, item, base);
            await assertCurrentFiles(context, base, item.workspace);
            const current = await sourceDigest(
              context.repoDir,
              item.workspace,
              base.spec.verification.sourcePaths,
            );
            if (
              proof.workItem === item.workItem &&
              proof.baselineId === base.baselineId &&
              proof.sourceDigest === current.sourceDigest
            ) verified = true;
          } catch {
            /* Stale/deleted workspaces do not constitute current operational evidence. */
          }
        }
        return emit(context, "readiness", "readiness", {
          configurationReady: blockers.length === 0,
          operationallyVerified: blockers.length === 0 && verified,
          baselineId: state.baselineId,
          activeItems: state.items.filter((item) => item.active).length,
          configuredItems: state.items.filter((item) => item.binding).length,
          blockers,
        });
      },
    },
  },
};
