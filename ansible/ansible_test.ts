/**
 * Unit tests for the @jamesakeech/ansible model.
 *
 * The pure parts — recap parsing, status derivation, argv construction — are
 * tested directly. The execute paths are exercised against a fake
 * `ansible-playbook` (a shell script emitting canned PLAY RECAP output), so the
 * tests cover real subprocess handling, temp-file lifecycle and secret placement
 * without needing managed hosts.
 *
 * @module
 */
import { createModelTestContext } from "@swamp-club/swamp-testing";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  buildArgs,
  deriveStatus,
  GlobalArgsSchema,
  type HostRecap,
  model,
  parseRecap,
} from "./ansible.ts";

// deno-lint-ignore no-explicit-any
const methods = model.methods as any;
// deno-lint-ignore no-explicit-any
function dataOf(written: { data: unknown }): any {
  return written.data;
}

const RECAP = `
PLAY [Configure Debian VMs] ****************************************************

TASK [Gathering Facts] *********************************************************
ok: [cwa01]

PLAY RECAP *********************************************************************
cwa01                      : ok=12   changed=3    unreachable=0    failed=0    skipped=2    rescued=0    ignored=0
deluge01                   : ok=11   changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0
`;

// ── parseRecap ────────────────────────────────────────────────────────────────

Deno.test("parseRecap: extracts per-host tallies", () => {
  const hosts = parseRecap(RECAP);
  assertEquals(hosts.length, 2);
  assertEquals(hosts[0], {
    host: "cwa01",
    ok: 12,
    changed: 3,
    unreachable: 0,
    failed: 0,
    skipped: 2,
    rescued: 0,
    ignored: 0,
  });
  assertEquals(hosts[1].host, "deluge01");
  assertEquals(hosts[1].changed, 0);
});

Deno.test("parseRecap: ignores recap-shaped text before PLAY RECAP", () => {
  // A task printing something recap-like must not be mistaken for the real one.
  const noisy = `
TASK [debug] *******
ok: [web01] => {
    "msg": "fake01 : ok=99 changed=99 unreachable=0 failed=0"
}

PLAY RECAP ****
web01                      : ok=1    changed=0    unreachable=0    failed=0
`;
  const hosts = parseRecap(noisy);
  assertEquals(hosts.length, 1);
  assertEquals(hosts[0].host, "web01");
  assertEquals(hosts[0].changed, 0);
});

Deno.test("parseRecap: tolerates older cores omitting trailing counters", () => {
  const hosts = parseRecap(
    "PLAY RECAP ***\nweb01 : ok=3 changed=1 unreachable=0 failed=0\n",
  );
  assertEquals(hosts[0].skipped, 0);
  assertEquals(hosts[0].rescued, 0);
  assertEquals(hosts[0].ignored, 0);
});

Deno.test("parseRecap: no recap yields empty, not a throw", () => {
  assertEquals(parseRecap("ERROR! playbook could not be found"), []);
  assertEquals(parseRecap(""), []);
});

// ── deriveStatus ──────────────────────────────────────────────────────────────

function host(over: Partial<HostRecap> = {}): HostRecap {
  return {
    host: "h",
    ok: 1,
    changed: 0,
    unreachable: 0,
    failed: 0,
    skipped: 0,
    rescued: 0,
    ignored: 0,
    ...over,
  };
}

Deno.test("deriveStatus: check mode distinguishes compliant from drift", () => {
  assertEquals(deriveStatus("check", [host()], 0), "compliant");
  assertEquals(deriveStatus("check", [host({ changed: 2 })], 0), "drift");
});

Deno.test("deriveStatus: apply mode distinguishes unchanged from applied", () => {
  assertEquals(deriveStatus("apply", [host()], 0), "unchanged");
  assertEquals(deriveStatus("apply", [host({ changed: 1 })], 0), "applied");
});

Deno.test("deriveStatus: any failure or unreachable host wins outright", () => {
  // A partially-successful run must never read as a pass.
  assertEquals(
    deriveStatus("apply", [host({ changed: 5 }), host({ failed: 1 })], 0),
    "failed",
  );
  assertEquals(
    deriveStatus("check", [host(), host({ unreachable: 1 })], 0),
    "failed",
  );
});

Deno.test("deriveStatus: nonzero exit fails even with a clean recap", () => {
  assertEquals(deriveStatus("apply", [host()], 2), "failed");
});

Deno.test("deriveStatus: empty recap follows the exit code", () => {
  assertEquals(deriveStatus("check", [], 0), "unchanged");
  assertEquals(deriveStatus("check", [], 1), "failed");
});

// ── buildArgs ─────────────────────────────────────────────────────────────────

const G = GlobalArgsSchema.parse({
  workdir: "/repo",
  playbook: "ansible/site.yml",
  remoteUser: "jamesk",
  privateKeyPath: "/keys/id_ed25519",
});

const A = {
  tags: [],
  skipTags: [],
  extraVars: {},
  verbosity: 0,
  timeoutSec: 1800,
};

Deno.test("buildArgs: check mode always passes --check", () => {
  const args = buildArgs("check", G, A, {});
  assert(args.includes("--check"), "check mode must never omit --check");
  assert(args.includes("--diff"));
  assertEquals(args[0], "ansible/site.yml");
});

Deno.test("buildArgs: apply mode never passes --check", () => {
  const args = buildArgs("apply", G, A, {});
  assert(!args.includes("--check"));
});

Deno.test("buildArgs: threads user, key, inventory and secret files", () => {
  const args = buildArgs("apply", G, A, {
    inventory: "/tmp/x/inventory.yml",
    vaultPasswordFile: "/tmp/x/vault-pass",
    extraVarsFile: "/tmp/x/extra-vars.json",
  }).join(" ");
  assertStringIncludes(args, "-u jamesk");
  assertStringIncludes(args, "--private-key /keys/id_ed25519");
  assertStringIncludes(args, "-i /tmp/x/inventory.yml");
  assertStringIncludes(args, "--vault-password-file /tmp/x/vault-pass");
  assertStringIncludes(args, "-e @/tmp/x/extra-vars.json");
});

Deno.test("buildArgs: secrets are never placed in argv", () => {
  const g = GlobalArgsSchema.parse({
    workdir: "/repo",
    playbook: "p.yml",
    vaultPassword: "vault-secret-value",
    becomePassword: "sudo-secret-value",
  });
  const joined = buildArgs("apply", g, A, {
    vaultPasswordFile: "/tmp/x/vault-pass",
    extraVarsFile: "/tmp/x/extra-vars.json",
  }).join(" ");
  assert(!joined.includes("vault-secret-value"), "vault password leaked to argv");
  assert(!joined.includes("sudo-secret-value"), "become password leaked to argv");
});

Deno.test("buildArgs: tags, skip-tags, limit and verbosity", () => {
  const args = buildArgs("apply", G, {
    ...A,
    limit: "cwa01",
    tags: ["docker", "users"],
    skipTags: ["slow"],
    verbosity: 3,
  }, {}).join(" ");
  assertStringIncludes(args, "--limit cwa01");
  assertStringIncludes(args, "--tags docker,users");
  assertStringIncludes(args, "--skip-tags slow");
  assertStringIncludes(args, "-vvv");
});

// ── execute paths, against a fake ansible-playbook ────────────────────────────

/** Write an executable stub standing in for ansible-playbook. */
async function fakeAnsible(body: string): Promise<{ dir: string; bin: string }> {
  const dir = await Deno.makeTempDir({ prefix: "fake-ansible-" });
  const bin = `${dir}/ansible-playbook`;
  await Deno.writeTextFile(bin, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(bin, 0o755);
  await Deno.writeTextFile(`${dir}/site.yml`, "- hosts: all\n");
  return { dir, bin };
}

Deno.test("check: compliant run writes typed data and no changes", async () => {
  const { dir, bin } = await fakeAnsible(
    `cat <<'EOF'
PLAY RECAP ****
cwa01                      : ok=9    changed=0    unreachable=0    failed=0
EOF`,
  );
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GlobalArgsSchema.parse({
        workdir: dir,
        playbook: "site.yml",
        ansibleBin: bin,
      }),
    });
    await methods.check.execute(methods.check.arguments.parse({}), context);
    const d = dataOf(getWrittenResources()[0]);
    assertEquals(d.status, "compliant");
    assertEquals(d.mode, "check");
    assertEquals(d.hostCount, 1);
    assertEquals(d.totals.changed, 0);
    assertEquals(d.exitCode, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("check: drift is reported without failing the step", async () => {
  const { dir, bin } = await fakeAnsible(
    `cat <<'EOF'
PLAY RECAP ****
cwa01                      : ok=9    changed=4    unreachable=0    failed=0
EOF`,
  );
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GlobalArgsSchema.parse({
        workdir: dir,
        playbook: "site.yml",
        ansibleBin: bin,
      }),
    });
    await methods.check.execute(methods.check.arguments.parse({}), context);
    const d = dataOf(getWrittenResources()[0]);
    assertEquals(d.status, "drift");
    assertEquals(d.totals.changed, 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("apply: a failed host throws so the workflow step fails", async () => {
  const { dir, bin } = await fakeAnsible(
    `cat <<'EOF'
PLAY RECAP ****
cwa01                      : ok=3    changed=1    unreachable=0    failed=2
EOF
exit 2`,
  );
  try {
    const { context } = createModelTestContext({
      globalArgs: GlobalArgsSchema.parse({
        workdir: dir,
        playbook: "site.yml",
        ansibleBin: bin,
      }),
    });
    const err = await assertRejects(() =>
      methods.apply.execute(methods.apply.arguments.parse({}), context)
    );
    assertStringIncludes((err as Error).message, "failed");
    assertStringIncludes((err as Error).message, "exit 2");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("check: --check reaches the binary, and inventory content is written", async () => {
  // The stub echoes its own argv and the inventory it was handed.
  const { dir, bin } = await fakeAnsible(
    `echo "ARGV: $@"
for a in "$@"; do
  case "$a" in
    */inventory.yml) echo "INVENTORY: $(cat "$a")" ;;
  esac
done
cat <<'EOF'
PLAY RECAP ****
h1                         : ok=1    changed=0    unreachable=0    failed=0
EOF`,
  );
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GlobalArgsSchema.parse({
        workdir: dir,
        playbook: "site.yml",
        ansibleBin: bin,
      }),
    });
    await methods.check.execute(
      methods.check.arguments.parse({
        inventoryContent: "all:\n  hosts:\n    h1:\n",
      }),
      context,
    );
    const d = dataOf(getWrittenResources()[0]);
    assertStringIncludes(d.stdoutTail, "--check");
    assertStringIncludes(d.stdoutTail, "INVENTORY: all:");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("secrets go to files, not argv, and the temp dir is cleaned up", async () => {
  const { dir, bin } = await fakeAnsible(
    `echo "ARGV: $@"
for a in "$@"; do
  case "$a" in
    @*) echo "EXTRAVARS: $(cat "$(echo "$a" | sed 's/^@//')")" ;;
  esac
done
cat <<'EOF'
PLAY RECAP ****
h1                         : ok=1    changed=0    unreachable=0    failed=0
EOF`,
  );
  const before = [...Deno.readDirSync("/tmp")].filter((e) =>
    e.name.startsWith("swamp-ansible-")
  ).length;
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GlobalArgsSchema.parse({
        workdir: dir,
        playbook: "site.yml",
        ansibleBin: bin,
        becomePassword: "s3cr3t-sudo",
        vaultPassword: "s3cr3t-vault",
      }),
    });
    await methods.check.execute(methods.check.arguments.parse({}), context);
    const d = dataOf(getWrittenResources()[0]);
    // argv must not carry the secret; the extra-vars file must.
    const argvLine = d.stdoutTail.split("\n").find((l: string) =>
      l.startsWith("ARGV:")
    );
    assert(!argvLine.includes("s3cr3t-sudo"), "become password in argv");
    assert(!argvLine.includes("s3cr3t-vault"), "vault password in argv");
    assertStringIncludes(d.stdoutTail, "ansible_become_password");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  const after = [...Deno.readDirSync("/tmp")].filter((e) =>
    e.name.startsWith("swamp-ansible-")
  ).length;
  assertEquals(after, before, "temp dir holding secrets was not cleaned up");
});

// ── integration: against real ansible-playbook when available ─────────────────

/** True when a usable ansible-playbook is on PATH. */
async function haveAnsible(): Promise<boolean> {
  try {
    const { code } = await new Deno.Command("ansible-playbook", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return code === 0;
  } catch {
    return false;
  }
}

const ANSIBLE_PRESENT = await haveAnsible();

Deno.test({
  name: "integration: parses a recap emitted by real ansible-playbook",
  ignore: !ANSIBLE_PRESENT,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "real-ansible-" });
    try {
      await Deno.writeTextFile(
        `${dir}/site.yml`,
        [
          "- name: Integration probe",
          "  hosts: all",
          "  gather_facts: false",
          "  connection: local",
          "  tasks:",
          "    - name: always ok",
          "      ansible.builtin.debug:",
          "        msg: ok",
        ].join("\n") + "\n",
      );
      await Deno.writeTextFile(
        `${dir}/inventory.yml`,
        "all:\n  hosts:\n    probe1:\n    probe2:\n",
      );

      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: GlobalArgsSchema.parse({
          workdir: dir,
          playbook: "site.yml",
          inventoryPath: "inventory.yml",
        }),
      });
      await methods.check.execute(methods.check.arguments.parse({}), context);

      const d = dataOf(getWrittenResources()[0]);
      // Real recap lines carry trailing whitespace after ignored=N; the parser
      // must not depend on end-of-line anchoring.
      assertEquals(d.hostCount, 2, "both hosts should appear in the recap");
      assertEquals(d.status, "compliant");
      assertEquals(d.totals.changed, 0);
      assertEquals(d.hosts.map((h: HostRecap) => h.host).sort(), [
        "probe1",
        "probe2",
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("check: playbook-present check fails for a missing playbook", async () => {
  const { dir, bin } = await fakeAnsible("exit 0");
  try {
    const { context } = createModelTestContext({
      globalArgs: GlobalArgsSchema.parse({
        workdir: dir,
        playbook: "does-not-exist.yml",
        ansibleBin: bin,
      }),
    });
    // deno-lint-ignore no-explicit-any
    const check = (model as any).checks["playbook-present"];
    const result = await check.execute(context);
    assertEquals(result.pass, false);
    assertStringIncludes(result.message, "playbook not found");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("check: playbook-present passes when playbook and binary exist", async () => {
  const { dir, bin } = await fakeAnsible("exit 0");
  try {
    const { context } = createModelTestContext({
      globalArgs: GlobalArgsSchema.parse({
        workdir: dir,
        playbook: "site.yml",
        ansibleBin: bin,
      }),
    });
    // deno-lint-ignore no-explicit-any
    const check = (model as any).checks["playbook-present"];
    assertEquals((await check.execute(context)).pass, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
