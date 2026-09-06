import { strict as assert } from "node:assert";
import * as path from "node:path";
import { model } from "./bootstrap.ts";
import {
  AssemblySchema,
  BaselineSchema,
  type Context,
  ENGINE_VERSION,
  type Project,
  RegistrySchema,
  VERSION,
} from "./schema.ts";

interface Fixture {
  root: string;
  spec: Project;
  context: Context;
  data: Map<string, Record<string, unknown>>;
  saveSpec(): Promise<void>;
}

async function withProject(
  test: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "bootstrap-controller-" }),
  );
  const documents: Project["documents"] = [
    { role: "instructions", path: "AGENTS.md" },
    { role: "conventions", path: "docs/conventions.md" },
    { role: "system-context", path: "docs/architecture/L1-system-context.md" },
    { role: "containers", path: "docs/architecture/L2-containers.md" },
    { role: "decision", path: "docs/adr/001-design.md" },
    {
      role: "architecture-skill",
      path: ".agents/skills/project-architecture/SKILL.md",
    },
    { role: "review-guidance", path: "docs/review.md" },
  ];
  const spec: Project = {
    schemaVersion: 1,
    projectId: "example-project",
    title: "Example project",
    purpose: "Exercise local bootstrap contracts without external systems.",
    agentTool: "codex",
    documents,
    decisions: ["Use one project repository."],
    skills: ["project-architecture"],
    dependencies: [
      { name: "@jamesakeech/bootstrap", version: VERSION },
      { name: "@swamp/software-factory", version: ENGINE_VERSION },
      { name: "@example/project-check", version: "2026.09.06.1" },
    ],
    issueIntegration: { provider: "local", scope: "example-project" },
    policy: {
      materialDecisions: "explicit-approval",
      externalActions: "explicit-approval",
      requirePlanApproval: false,
      requireDeliveryApproval: true,
      maxCycles: 3,
    },
    verification: {
      // This valid root deliberately does not exist until the first implementation.
      sourcePaths: ["src"],
      checks: [{
        name: "test",
        modelType: "@example/project-check",
        methodName: "test",
        globalArgs: {},
        inputs: {},
        command: "Run the project's focused tests.",
      }],
    },
  };
  const data = new Map<string, Record<string, unknown>>();
  const context: Context = {
    repoDir: root,
    globalArgs: { specPath: "docs/bootstrap/project.json" },
    definition: { name: "project-bootstrap", id: crypto.randomUUID() },
    logger: { info() {} },
    readResource: (name) =>
      Promise.resolve(structuredClone(data.get(name) ?? null)),
    writeResource: (_spec, name, value) => {
      data.set(name, structuredClone(value));
      return Promise.resolve({ name });
    },
    dataRepository: {
      getContent: () =>
        Promise.reject(
          new Error("Unexpected cross-model lookup in controller fixture."),
        ),
    },
  };
  const saveSpec = async (): Promise<void> => {
    const target = path.join(root, context.globalArgs.specPath);
    await Deno.mkdir(path.dirname(target), { recursive: true });
    await Deno.writeTextFile(target, JSON.stringify(spec, null, 2));
  };
  try {
    for (const document of documents) {
      const target = path.join(root, document.path);
      await Deno.mkdir(path.dirname(target), { recursive: true });
      await Deno.writeTextFile(
        target,
        `# ${document.role}\n\nAccepted example guidance.\n`,
      );
    }
    await saveSpec();
    await test({ root, spec, context, data, saveSpec });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const approval = {
  actor: "example-reviewer",
  reference: "local-review-record",
  validation: "local-template-validation-record",
};

Deno.test("accepted baseline is exact, intake is idempotent, and existing context stays pinned", async () => {
  await withProject(async ({ root, context, data }) => {
    await model.methods.check.execute({}, context);
    const candidate = BaselineSchema.parse(data.get("candidate"));
    const conventions = path.join(root, "docs/conventions.md");
    const original = await Deno.readTextFile(conventions);
    await Deno.writeTextFile(conventions, `${original}Unreviewed change.\n`);
    await assert.rejects(
      () =>
        model.methods.accept.execute({
          baselineId: candidate.baselineId,
          ...approval,
        }, context),
      /Candidate changed/,
    );
    assert.equal(data.has("registry"), false);
    await Deno.writeTextFile(conventions, original);
    await model.methods.accept.execute({
      baselineId: candidate.baselineId,
      ...approval,
    }, context);
    const firstAcceptance = structuredClone(
      data.get(`baseline-${candidate.baselineId}`),
    );
    await model.methods.accept.execute({
      baselineId: candidate.baselineId,
      ...approval,
    }, context);
    assert.deepEqual(
      data.get(`baseline-${candidate.baselineId}`),
      firstAcceptance,
    );

    const intake = { reference: "LOCAL-1", provider: "local", workspace: "." };
    await model.methods.intake.execute(intake, context);
    const first = RegistrySchema.parse(data.get("registry")).items[0];
    assert.ok(
      first.workItem.length <= 48,
      "The factory engine must preserve this work-item slug.",
    );
    const originalAssembly = AssemblySchema.parse(
      data.get(`assembly-${first.workItem}`),
    );
    await model.methods.intake.execute(intake, context);
    assert.equal(RegistrySchema.parse(data.get("registry")).items.length, 1);
    assert.deepEqual(
      AssemblySchema.parse(data.get(`assembly-${first.workItem}`)),
      originalAssembly,
    );
    await model.methods.intake.execute(
      { ...intake, reference: "LOCAL-2" },
      context,
    );
    const second = RegistrySchema.parse(data.get("registry")).items[1];
    assert.notEqual(second.workItem, first.workItem);
    assert.notEqual(second.factoryName, first.factoryName);
    assert.notEqual(second.workflowName, first.workflowName);

    await Deno.writeTextFile(
      conventions,
      `${original}New accepted guidance.\n`,
    );
    await model.methods.check.execute({}, context);
    const next = BaselineSchema.parse(data.get("candidate"));
    assert.notEqual(next.baselineId, candidate.baselineId);
    await model.methods.accept.execute({
      baselineId: next.baselineId,
      ...approval,
    }, context);
    await model.methods.intake.execute(
      { ...intake, reference: "LOCAL-3" },
      context,
    );
    const state = RegistrySchema.parse(data.get("registry"));
    assert.equal(state.baselineId, next.baselineId);
    assert.equal(state.items[0].baselineId, candidate.baselineId);
    assert.equal(state.items[2].baselineId, next.baselineId);
    await model.methods.context.execute({ workItem: first.workItem }, context);
    const pinned = data.get(`context-${first.workItem}`);
    assert.equal(pinned?.baselineId, candidate.baselineId);
    assert.deepEqual(pinned?.documents, candidate.documents);
  });
});

Deno.test("configuration rejects invalid roots before acceptance and strips merged global arguments", async () => {
  await withProject(async ({ spec, context, data, saveSpec }) => {
    const merged = { specPath: context.globalArgs.specPath };
    assert.deepEqual(model.methods.check.arguments.parse(merged), {});
    assert.deepEqual(model.methods.inspect.arguments.parse(merged), {});
    assert.deepEqual(
      model.methods.intake.arguments.parse({ ...merged, reference: "LOCAL-1" }),
      { reference: "LOCAL-1", provider: "local", workspace: "." },
    );
    for (
      const sourcePath of [
        ".",
        "../src",
        "/etc",
        "node_modules",
        "src/.env.local",
      ]
    ) {
      spec.verification.sourcePaths = [sourcePath];
      await saveSpec();
      await assert.rejects(
        () => model.methods.check.execute({}, context),
        /path|component/,
      );
      assert.equal(data.has("candidate"), false);
    }
    spec.verification.sourcePaths = ["src"];
    await saveSpec();
    await model.methods.check.execute(
      model.methods.check.arguments.parse(merged),
      context,
    );
    assert.ok(
      data.has("candidate"),
      "Missing but valid source roots are allowed before implementation.",
    );
  });
});

Deno.test("vault expressions cannot enter snapshots through escaped JSON or document text", async () => {
  await withProject(async ({ root, spec, context, data, saveSpec }) => {
    const originalTitle = spec.title;
    spec.title = '${{ vault.get("example-provider", "example-key") }}';
    const escaped = JSON.stringify(spec).replaceAll("vault", "\\u0076ault");
    assert.equal(escaped.includes("vault"), false);
    await Deno.writeTextFile(
      path.join(root, context.globalArgs.specPath),
      escaped,
    );
    await assert.rejects(
      () => model.methods.check.execute({}, context),
      /Executable vault expressions/,
    );
    assert.equal(data.has("candidate"), false);

    spec.title = originalTitle;
    await saveSpec();
    const conventions = path.join(root, "docs/conventions.md");
    const original = await Deno.readTextFile(conventions);
    await Deno.writeTextFile(
      conventions,
      `${original}\n\u0024{{ vault.get("example-provider", "example-key") }}\n`,
    );
    await assert.rejects(
      () => model.methods.check.execute({}, context),
      /Executable vault expressions/,
    );
    assert.equal(data.has("candidate"), false);

    await Deno.writeTextFile(conventions, original);
    await model.methods.check.execute({}, context);
    assert.ok(data.has("candidate"));
  });
});
