import { strict as assert } from "node:assert";
import * as path from "node:path";
import { model } from "./bootstrap.ts";
import {
  AssemblySchema,
  BaselineSchema,
  type Context,
  ENGINE_VERSION,
  type Project,
  ProjectSchema,
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
  agent: {
    tool: string;
    instructions: string[];
    skillsDir: string;
  } = {
    tool: "codex",
    instructions: ["AGENTS.md"],
    skillsDir: ".agents/skills",
  },
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "bootstrap-controller-" }),
  );
  const documents: Project["documents"] = [
    ...agent.instructions.map((file) => ({
      role: "instructions" as const,
      path: file,
    })),
    { role: "conventions", path: "docs/conventions.md" },
    { role: "system-context", path: "docs/architecture/L1-system-context.md" },
    { role: "containers", path: "docs/architecture/L2-containers.md" },
    { role: "decision", path: "docs/adr/001-design.md" },
    {
      role: "architecture-skill",
      path: `${agent.skillsDir}/project-architecture/SKILL.md`,
    },
    { role: "review-guidance", path: "docs/review.md" },
  ];
  const spec: Project = {
    schemaVersion: 1,
    projectId: "example-project",
    title: "Example project",
    purpose: "Exercise local bootstrap contracts without external systems.",
    agentTool: agent.tool,
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

Deno.test("custom factory choices are inventoried, previewed, and pinned without migrating existing items", async () => {
  await withProject(async ({ root, spec, context, data, saveSpec }) => {
    await model.methods.check.execute({}, context);
    const original = BaselineSchema.parse(data.get("candidate"));
    assert.equal(Object.hasOwn(original.spec, "factory"), false);
    await model.methods.accept.execute({
      baselineId: original.baselineId,
      ...approval,
    }, context);
    await model.methods.intake.execute({
      reference: "OLD",
      provider: "local",
      workspace: ".",
    }, context);
    const old = RegistrySchema.parse(data.get("registry")).items[0];
    const oldAssembly = structuredClone(data.get(`assembly-${old.workItem}`));
    const skill = "project-security-review";
    const skillPath = `.claude/skills/${skill}/SKILL.md`;
    spec.factory = {
      base: "bootstrap-default",
      stages: [{
        stage: "planning",
        instructions: "Plan account isolation tests.",
      }],
      reviews: [{
        id: "security-review",
        after: "code-review",
        instructions: "Review access control.",
        skills: [skill],
        requireApproval: true,
      }],
    };
    await saveSpec();
    await assert.rejects(
      () => model.methods.check.execute({}, context),
      /Include the selected skill project-security-review/,
    );
    assert.deepEqual(data.get("candidate"), original);
    await Deno.mkdir(path.dirname(path.join(root, skillPath)), {
      recursive: true,
    });
    await Deno.writeTextFile(
      path.join(root, skillPath),
      "---\nname: project-security-review\ndescription: Review access control.\n---\nCheck account isolation without editing source.\n",
    );
    spec.documents.push({ role: "review-guidance", path: skillPath });
    await saveSpec();
    await model.methods.check.execute({}, context);
    const candidate = BaselineSchema.parse(data.get("candidate"));
    assert.notEqual(candidate.baselineId, original.baselineId);
    assert.deepEqual(candidate.spec.factory, spec.factory);
    assert.ok(
      candidate.documents.some((document) => document.path === skillPath),
    );
    await model.methods.preview.execute({ workspace: "." }, context);
    const preview = AssemblySchema.parse(data.get("preview"));
    const reviews = preview.factoryArguments.stages as {
      id: string;
      work?: { skills?: string[] };
    }[];
    assert.ok(
      reviews.find((stage) => stage.id === "security-review")?.work?.skills
        ?.includes(skill),
    );
    assert.equal(
      reviews.find((stage) => stage.id === "planning")?.work?.skills?.includes(
        skill,
      ),
      false,
    );
    spec.factory.reviews![0].instructions =
      "Review account isolation and unsafe input.";
    await saveSpec();
    await assert.rejects(
      () =>
        model.methods.accept.execute({
          baselineId: candidate.baselineId,
          ...approval,
        }, context),
      /Candidate changed/,
    );
    spec.factory = candidate.spec.factory;
    await saveSpec();
    await model.methods.accept.execute({
      baselineId: candidate.baselineId,
      ...approval,
    }, context);
    await model.methods.intake.execute({
      reference: "NEW",
      provider: "local",
      workspace: ".",
    }, context);
    const current = RegistrySchema.parse(data.get("registry")).items[1];
    const assembly = AssemblySchema.parse(
      data.get(`assembly-${current.workItem}`),
    );
    assert.ok(
      (assembly.factoryArguments.stages as { id: string }[]).some((stage) =>
        stage.id === "security-review"
      ),
    );
    assert.equal(current.baselineId, candidate.baselineId);
    await model.methods.context.execute(
      { workItem: current.workItem },
      context,
    );
    assert.deepEqual(
      data.get(`context-${current.workItem}`)?.spec,
      candidate.spec,
    );
    await model.methods.intake.execute({
      reference: "OLD",
      provider: "local",
      workspace: ".",
    }, context);
    assert.deepEqual(data.get(`assembly-${old.workItem}`), oldAssembly);
    await model.methods.context.execute({ workItem: old.workItem }, context);
    assert.deepEqual(data.get(`context-${old.workItem}`)?.spec, original.spec);
  });
});

Deno.test("first-run inspection guides discovery without accepting drafts or hiding file errors", async () => {
  await withProject(async ({ root, context, data, saveSpec }) => {
    const specPath = path.join(root, context.globalArgs.specPath);
    const cases = [
      { text: null, status: "needs-details" },
      { text: "", status: "needs-details" },
      { text: " \n ", status: "needs-details" },
      { text: "{}", status: "needs-details" },
      {
        text: '{"title":"Reading list","purpose":" "}',
        status: "needs-details",
      },
      { text: '{"purpose":"__BOOTSTRAP_DRAFT__"}', status: "needs-details" },
      {
        text: '{"purpose":"Track books for my family."}',
        status: "needs-configuration",
      },
      {
        text: '{"token":"example-secret-value",',
        status: "invalid-configuration",
      },
      { text: "null", status: "invalid-configuration" },
      { text: "[]", status: "invalid-configuration" },
      { text: '"project"', status: "invalid-configuration" },
      {
        text:
          '{"purpose":"Track books","example-secret-key":"example-secret-value"}',
        status: "needs-configuration",
      },
    ];
    for (const entry of cases) {
      data.clear();
      if (entry.text === null) await Deno.remove(specPath);
      else await Deno.writeTextFile(specPath, entry.text);
      await model.methods.inspect.execute({}, context);
      const inspection = data.get("inspection")!;
      assert.equal(inspection.status, entry.status);
      assert.equal(inspection.configured, entry.text !== null);
      assert.equal(inspection.acceptedBaselineId, null);
      assert.equal(inspection.instructionsPresent, false);
      assert.equal(
        inspection.nextQuestion,
        entry.status === "needs-details"
          ? "What would you like to build, and who is it for?"
          : null,
      );
      assert.ok(
        Array.isArray(inspection.issues) && inspection.issues.length > 0,
      );
      assert.equal(
        JSON.stringify(inspection).includes("example-secret"),
        false,
      );
      await assert.rejects(() => model.methods.check.execute({}, context));
      assert.deepEqual([...data.keys()], ["inspection"]);
      if (entry.text === null) {
        await assert.rejects(() => Deno.stat(specPath), Deno.errors.NotFound);
      } else assert.equal(await Deno.readTextFile(specPath), entry.text);
    }

    await saveSpec();
    await model.methods.inspect.execute({}, context);
    assert.equal(data.get("inspection")?.status, "ready-for-check");
    assert.equal(data.get("inspection")?.nextQuestion, null);
    assert.deepEqual(data.get("inspection")?.issues, []);
    assert.equal(data.has("candidate"), false);
    await Deno.remove(path.join(root, "AGENTS.md"));
    await model.methods.inspect.execute({}, context);
    assert.equal(data.get("inspection")?.status, "needs-configuration");
    assert.equal(data.get("inspection")?.nextQuestion, null);

    data.clear();
    const originalPath = context.globalArgs.specPath;
    for (
      const unsafePath of ["../project.json", ".env", ".swamp/project.json"]
    ) {
      context.globalArgs.specPath = unsafePath;
      await assert.rejects(
        () => model.methods.inspect.execute({}, context),
        /path|component/,
      );
      assert.equal(data.size, 0);
    }
    context.globalArgs.specPath = originalPath;
    await Deno.writeTextFile(specPath, "x".repeat(1024 * 1024 + 1));
    await assert.rejects(
      () => model.methods.inspect.execute({}, context),
      /byte limit/,
    );
    assert.equal(data.size, 0);
    await saveSpec();
    const link = path.join(root, "project-link.json");
    await Deno.symlink(specPath, link);
    context.globalArgs.specPath = "project-link.json";
    await assert.rejects(
      () => model.methods.inspect.execute({}, context),
      /symlink/,
    );
    assert.equal(data.size, 0);
  });
});

Deno.test("native agent layouts survive inspect, acceptance, intake, and pinned context", async () => {
  for (
    const agent of [
      {
        tool: "codex",
        instructions: ["AGENTS.md"],
        skillsDir: ".agents/skills",
      },
      {
        tool: "claude",
        instructions: ["CLAUDE.md"],
        skillsDir: ".claude/skills",
      },
      { tool: "pi", instructions: ["AGENTS.md"], skillsDir: ".pi/skills" },
      { tool: "pi", instructions: ["AGENTS.md"], skillsDir: ".agents/skills" },
      {
        tool: "custom-agent",
        instructions: [".custom/instructions.md"],
        skillsDir: ".custom/project-skills",
      },
      {
        tool: "claude",
        instructions: ["CLAUDE.md", "AGENTS.md"],
        skillsDir: ".claude/skills",
      },
    ]
  ) {
    await withProject(async ({ root, spec, context, data, saveSpec }) => {
      for (const tool of ["none", "", "../claude"]) {
        assert.equal(
          ProjectSchema.safeParse({ ...spec, agentTool: tool }).success,
          false,
        );
      }
      await model.methods.inspect.execute({}, context);
      assert.equal(
        data.get("inspection")?.instructionsPresent,
        true,
        agent.tool,
      );
      const missing = path.join(root, agent.instructions.at(-1)!);
      const original = await Deno.readTextFile(missing);
      await Deno.remove(missing);
      await model.methods.inspect.execute({}, context);
      assert.equal(data.get("inspection")?.instructionsPresent, false);
      await assert.rejects(
        () => model.methods.check.execute({}, context),
        Deno.errors.NotFound,
      );
      assert.equal(data.has("candidate"), false);
      await Deno.writeTextFile(missing, original);

      spec.skills = ["missing-skill"];
      await saveSpec();
      await assert.rejects(
        () => model.methods.check.execute({}, context),
        /Include the selected skill/,
      );
      spec.skills = ["project-architecture"];
      await saveSpec();
      await model.methods.check.execute({}, context);
      const candidate = BaselineSchema.parse(data.get("candidate"));
      assert.equal(candidate.spec.agentTool, agent.tool);
      await model.methods.accept.execute({
        baselineId: candidate.baselineId,
        ...approval,
      }, context);
      await model.methods.intake.execute({
        reference: "LOCAL-1",
        provider: "local",
        workspace: ".",
      }, context);
      const item = RegistrySchema.parse(data.get("registry")).items[0];
      await model.methods.context.execute({ workItem: item.workItem }, context);
      assert.deepEqual(
        data.get(`context-${item.workItem}`)?.spec,
        candidate.spec,
      );
      assert.deepEqual(
        data.get(`context-${item.workItem}`)?.documents,
        candidate.documents,
      );

      await Deno.remove(path.join(root, context.globalArgs.specPath));
      await model.methods.inspect.execute({}, context);
      assert.equal(data.get("inspection")?.configured, false);
      assert.equal(data.get("inspection")?.instructionsPresent, false);
      assert.equal(
        data.get("inspection")?.acceptedBaselineId,
        candidate.baselineId,
      );
      assert.equal(data.get("inspection")?.status, "needs-configuration");
      assert.equal(data.get("inspection")?.nextQuestion, null);
      assert.deepEqual(
        data.get(`baseline-${candidate.baselineId}`)?.spec,
        candidate.spec,
      );
    }, agent);
  }
});

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

Deno.test("a custom architecture and its review skill are pinned and passed to interactive factory stages", async () => {
  await withProject(async ({ root, spec, context, data, saveSpec }) => {
    const choice =
      "Use a functional core and imperative shell, not DDD aggregates.";
    const skillName = "project-architecture-review";
    const skillPath = `.agents/skills/${skillName}/SKILL.md`;
    const review =
      `---\nname: ${skillName}\ndescription: Review functional-core boundaries in plans and code.\n---\nDuring review, check pure calculations and isolate I/O in adapters. Report boundary violations without editing source.\n`;
    await Deno.mkdir(path.dirname(path.join(root, skillPath)), {
      recursive: true,
    });
    await Deno.writeTextFile(path.join(root, skillPath), review);
    spec.decisions = [choice];
    spec.skills.push(skillName);
    spec.documents.push({ role: "review-guidance", path: skillPath });
    await saveSpec();
    await model.methods.check.execute({}, context);
    const candidate = BaselineSchema.parse(data.get("candidate"));
    assert.deepEqual(candidate.spec.decisions, [choice]);
    assert.equal(
      candidate.documents.find((doc) => doc.path === skillPath)?.content,
      review,
    );
    await model.methods.accept.execute({
      baselineId: candidate.baselineId,
      ...approval,
    }, context);
    await model.methods.intake.execute({
      reference: "CUSTOM-1",
      provider: "local",
      workspace: ".",
    }, context);
    const item = RegistrySchema.parse(data.get("registry")).items[0];
    const assembly = AssemblySchema.parse(
      data.get(`assembly-${item.workItem}`),
    );
    const stages = assembly.factoryArguments.stages as {
      work?: { mode: string; skills?: string[] };
    }[];
    const interactive = stages.filter((stage) =>
      stage.work?.mode === "interactive"
    );
    assert.ok(interactive.length > 0);
    for (const stage of interactive) {
      assert.deepEqual(stage.work?.skills, [
        "bootstrap-factory",
        ...spec.skills,
      ]);
    }
    await model.methods.context.execute({ workItem: item.workItem }, context);
    assert.deepEqual(
      data.get(`context-${item.workItem}`)?.spec,
      candidate.spec,
    );
    assert.deepEqual(
      data.get(`context-${item.workItem}`)?.documents,
      candidate.documents,
    );
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
