/** Real-engine lifecycle check. Opt in with BOOTSTRAP_SMOKE_REPO set to an isolated fixture repo. @module */
import { strict as assert } from "node:assert";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "npm:yaml@2.8.3";
import {
  AssemblySchema,
  BaselineSchema,
  type Item,
  ProjectSchema,
} from "./schema.ts";

const source = dirname(fileURLToPath(import.meta.url));
const smokeRepo = Deno.env.get("BOOTSTRAP_SMOKE_REPO");
type Json = Record<string, unknown>;

async function cli(args: string[], expectedFailure = false): Promise<Json> {
  const result = await new Deno.Command("swamp", {
    cwd: smokeRepo,
    args: [...args, "--json"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    if (args[0] === "model" && args[1] === "method" && args[2] === "run") {
      await cli(["report", "get", "@swamp/method-summary", "--model", args[3]]);
    } else if (args[0] === "workflow" && args[1] === "run") {
      await cli([
        "report",
        "get",
        "@swamp/workflow-summary",
        "--workflow",
        args[2],
      ]);
    }
    if (expectedFailure) return { expectedFailure: true, stderr };
    throw new Error(
      `swamp ${args.slice(0, 5).join(" ")} failed\n${stderr}\n${
        stdout.slice(0, 16000)
      }`,
    );
  }
  assert.equal(
    expectedFailure,
    false,
    "Expected the command to reject this operation",
  );
  return JSON.parse(stdout) as Json;
}

async function method(
  name: string,
  action: string,
  input: Json = {},
  expectedFailure = false,
): Promise<Json> {
  return await cli([
    "model",
    "method",
    "run",
    name,
    action,
    "--input",
    JSON.stringify(input),
  ], expectedFailure);
}

function output(result: Json, prefix?: string): Json {
  const artifacts = result.dataArtifacts as {
    name: string;
    attributes: Json;
  }[];
  const artifact = artifacts.find((entry) =>
    !prefix || entry.name.startsWith(prefix)
  );
  assert.ok(artifact, `Missing output ${prefix}`);
  return artifact.attributes;
}

async function write(path: string, value: string): Promise<void> {
  const full = resolve(smokeRepo!, path);
  assert.ok(
    full.startsWith(`${smokeRepo}/`),
    "Fixture writes must stay in the isolated repository",
  );
  await Deno.mkdir(dirname(full), { recursive: true });
  await Deno.writeTextFile(full, value);
}

async function configure(
  assembly: ReturnType<typeof AssemblySchema.parse>,
): Promise<Item> {
  const factory = await cli([
    "model",
    "create",
    "@swamp/software-factory",
    assembly.item.factoryName,
  ]);
  const factoryPath = String(factory.path);
  const definition = parse(await Deno.readTextFile(factoryPath)) as Json;
  await write(
    relative(smokeRepo!, factoryPath),
    stringify({ ...definition, globalArguments: assembly.factoryArguments }),
  );
  await cli(["workflow", "schema", "get"]);
  const workflow = await cli([
    "workflow",
    "create",
    assembly.item.workflowName,
  ]);
  const workflowPath = String(workflow.path);
  await write(
    relative(smokeRepo!, workflowPath),
    stringify({ id: workflow.id, ...assembly.workflow }),
  );
  await method(assembly.item.factoryName, "validate");
  const validated = await cli([
    "workflow",
    "validate",
    assembly.item.workflowName,
  ]);
  assert.equal(validated.passed, true);
  return {
    ...assembly.item,
    binding: {
      factoryId: String(factory.id),
      factoryPath: relative(smokeRepo!, factoryPath),
      workflowId: String(workflow.id),
      workflowPath: relative(smokeRepo!, workflowPath),
    },
  };
}

async function prepareToVerify(item: Item): Promise<string> {
  const key = { workItem: item.workItem };
  await method("project-bootstrap", "bind", { ...key, binding: item.binding });
  await method("project-bootstrap", "activate", key);
  await method(item.factoryName, "start", key);
  const dispatch = (): Promise<Json> =>
    method(item.factoryName, "record_dispatch", key);
  const record = (name: string, payload: Json): Promise<Json> =>
    method(item.factoryName, "record_artifact", { ...key, name, payload });
  const advance = (transition: string): Promise<Json> =>
    method(item.factoryName, "advance", { ...key, transition });
  await dispatch();
  const context = output(await method("project-bootstrap", "context", key));
  await record("project-context", context);
  await advance("begin");
  await dispatch();
  const plan = {
    summary: "Implement pure addition",
    steps: [{
      description: "Implement sum and a focused test",
      files: ["src/sum.ts", "tests/sum_test.ts"],
    }],
    testingStrategy:
      "Run the accepted Deno test through the dedicated workflow",
  };
  await record("plan", plan);
  await advance("submit");
  await dispatch();
  await record("plan-review", { findings: [] });
  await advance("accept");
  await dispatch();
  if (item.reference === "local-a") {
    await record("risk-review", {
      findings: [{
        id: "risk-1",
        severity: "high",
        description: "The plan must explicitly cover negative operands.",
      }],
    });
    await method(
      item.factoryName,
      "advance",
      { ...key, transition: "accept" },
      true,
    );
    await advance("rework");
    await dispatch();
    await record("plan", {
      ...plan,
      testingStrategy:
        "Verify positive and negative operands with the dedicated Deno workflow.",
    });
    await advance("submit");
    await dispatch();
    await record("plan-review", { findings: [] });
    await advance("accept");
    await dispatch();
    // The old custom findings cannot satisfy the new review cycle.
    await method(
      item.factoryName,
      "advance",
      { ...key, transition: "accept" },
      true,
    );
  }
  await record("risk-review", { findings: [] });
  await method(
    item.factoryName,
    "advance",
    { ...key, transition: "accept" },
    true,
  );
  await method(item.factoryName, "approve", {
    ...key,
    gateId: "plan-approval",
    actor: "integration-test",
  });
  await advance("accept");
  await dispatch();
  await write(
    `${item.workspace}/src/sum.ts`,
    "export function sum(a: number, b: number): number { return a + b; }\n",
  );
  await write(
    `${item.workspace}/tests/sum_test.ts`,
    'import { sum } from "../src/sum.ts";\nDeno.test("sum supports positive and negative operands", () => { if (sum(2, 3) !== 5 || sum(-2, 3) !== 1) throw new Error("incorrect sum"); });\n',
  );
  await write(`${item.workspace}/deno.json`, JSON.stringify({ lock: false }));
  const digest = String(
    output(await method("project-bootstrap", "source_digest", key))
      .sourceDigest,
  );
  await record("change-summary", {
    summary: "Implemented typed pure addition",
    sourceDigest: digest,
  });
  await advance("submit");
  await dispatch();
  return digest;
}

Deno.test({
  name:
    "real Swamp engine: custom reviews, rework, approval, isolated factories, and provenance",
  ignore: !smokeRepo,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assert.ok(
      smokeRepo && /bootstrap-(build|smoke)[.-]/.test(smokeRepo),
      "Use a dedicated bootstrap smoke fixture repository",
    );
    console.log(`Smoke repository: ${smokeRepo}`);
    const guide = await Deno.readTextFile(
      `${source}/.agents/skills/bootstrap/references/project-spec.md`,
    );
    const match = guide.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(match);
    const spec = ProjectSchema.parse(JSON.parse(match[1]));
    spec.factory = {
      base: "bootstrap-default",
      stages: [{
        stage: "planning",
        instructions: "Plan focused pure-function tests.",
      }],
      reviews: [
        {
          id: "risk-review",
          after: "plan-review",
          instructions: "Review arithmetic edge cases in the plan.",
        },
        {
          id: "boundary-review",
          after: "code-review",
          instructions:
            "Review pure-function boundaries without editing source.",
          skills: ["project-architecture-review"],
          requireApproval: true,
        },
      ],
    };
    spec.policy.requirePlanApproval = true;
    spec.policy.requireDeliveryApproval = true;
    // Fixtures are representative project-owned documents, not passing test substitutes.
    for (const doc of spec.documents) {
      if (doc.path === "AGENTS.md") continue;
      const content = doc.role === "architecture-skill"
        ? "---\nname: project-architecture\ndescription: Keep the arithmetic module pure.\n---\nUse typed pure functions. Keep I/O outside src/sum.ts.\n"
        : doc.path.endsWith("/project-architecture-review/SKILL.md")
        ? "---\nname: project-architecture-review\ndescription: Review arithmetic plans and code for pure-function boundaries.\n---\nDuring review, check that src/sum.ts has no I/O and tests cover positive and negative operands. Do not edit source during review.\n"
        : `# ${doc.role}\n\nKeep a single typed arithmetic module. Users call sum in-process. No network, storage, or deployment is required. Verify positive and negative operands using Deno tests.\n`;
      await write(doc.path, content);
    }
    await write("docs/bootstrap/project.json", JSON.stringify(spec, null, 2));
    const candidate = BaselineSchema.parse(
      output(await method("project-bootstrap", "check")),
    );
    const preview = AssemblySchema.parse(
      output(await method("project-bootstrap", "preview")),
    );
    await configure(preview);
    await method("project-bootstrap", "accept", {
      baselineId: candidate.baselineId,
      actor: "integration-test",
      reference: "isolated-fixture-approval",
      validation:
        "Real factory validate and workflow validate succeeded in this test",
    });
    assert.equal(
      output(await method("project-bootstrap", "readiness"))
        .operationallyVerified,
      false,
    );
    for (const workspace of ["workspaces/a", "workspaces/b"]) {
      for (const doc of candidate.documents) {
        await write(`${workspace}/${doc.path}`, doc.content);
      }
    }
    console.log("Validated and accepted baseline. Checking duplicate intake.");
    const [first, duplicate] = await Promise.all([
      method("project-bootstrap", "intake", {
        reference: "local-a",
        workspace: "workspaces/a",
      }),
      method("project-bootstrap", "intake", {
        reference: "local-a",
        workspace: "workspaces/a",
      }),
    ]);
    const aAssembly = AssemblySchema.parse(output(first, "assembly-"));
    assert.deepEqual(output(duplicate, "assembly-"), aAssembly);
    const bAssembly = AssemblySchema.parse(
      output(
        await method("project-bootstrap", "intake", {
          reference: "local-b",
          workspace: "workspaces/b",
        }),
        "assembly-",
      ),
    );
    const a = await configure(aAssembly);
    const b = await configure(bAssembly);
    assert.notEqual(a.binding!.factoryId, b.binding!.factoryId);
    assert.notEqual(a.binding!.workflowId, b.binding!.workflowId);
    const aDigest = await prepareToVerify(a);
    const bDigest = await prepareToVerify(b);
    console.log(
      "Both factories reached verification with distinct definitions and workspaces.",
    );
    for (const [item, digest] of [[a, aDigest], [b, bDigest]] as const) {
      const run = await cli([
        "workflow",
        "run",
        item.workflowName,
        "--input",
        JSON.stringify({
          workItem: item.workItem,
          baselineId: item.baselineId,
          expectedDigest: digest,
        }),
      ]);
      assert.equal(run.status, "succeeded");
      await method(item.factoryName, "record_evidence", {
        workItem: item.workItem,
        name: "verification-run",
        payload: { status: "succeeded", runId: String(run.id) },
      });
      console.log(`Verified ${item.reference}: ${String(run.id)}`);
    }
    // B completed AFTER A. A must still pass its own workflow gate.
    for (const item of [a, b]) {
      const key = { workItem: item.workItem };
      await method(item.factoryName, "advance", { ...key, transition: "pass" });
      await method(item.factoryName, "record_dispatch", key);
      await method(item.factoryName, "record_artifact", {
        ...key,
        name: "code-review",
        payload: { findings: [] },
      });
      await method(item.factoryName, "advance", {
        ...key,
        transition: "accept",
      });
      const status = output(await method(item.factoryName, "status", key));
      assert.ok(JSON.stringify(status).includes("boundary-review"));
      await method(item.factoryName, "record_dispatch", key);
      await method(item.factoryName, "record_artifact", {
        ...key,
        name: "boundary-review",
        payload: { findings: [] },
      });
      await method(item.factoryName, "advance", {
        ...key,
        transition: "accept",
      }, true);
      await method(item.factoryName, "approve", {
        ...key,
        gateId: "review-boundary-review-approval",
        actor: "integration-test",
      });
      await method(item.factoryName, "advance", {
        ...key,
        transition: "accept",
      }, true);
      await method(item.factoryName, "approve", {
        ...key,
        gateId: "delivery-approval",
        actor: "integration-test",
      });
      await method(item.factoryName, "advance", {
        ...key,
        transition: "accept",
      });
      await method("project-bootstrap", "release", key);
    }
    const ready = output(await method("project-bootstrap", "readiness"));
    assert.equal(ready.configurationReady, true);
    assert.equal(ready.operationallyVerified, true);
    assert.equal(ready.activeItems, 0);
    // An edited acceptance subject must fail without replacing the old baseline.
    await write(
      "docs/conventions.md",
      "# Conventions\n\nKeep addition pure. Add a dedicated subtraction module for the next item.\n",
    );
    await method("project-bootstrap", "accept", {
      baselineId: candidate.baselineId,
      actor: "integration-test",
      reference: "stale-approval",
      validation: "previous validation",
    }, true);
    const oldContext = output(
      await method("project-bootstrap", "context", { workItem: a.workItem }),
    );
    assert.equal(oldContext.baselineId, candidate.baselineId);
    assert.deepEqual(oldContext.documents, candidate.documents);
    const stale = output(await method("project-bootstrap", "readiness"));
    assert.equal(stale.configurationReady, false);
    console.log(
      "Passed: exact evidence isolation, full lifecycle, resume identity, pinned context, and stale approval rejection.",
    );
  },
});
