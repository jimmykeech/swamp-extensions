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
  redactSecrets,
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

Deno.test("buildArgs: materialised key beats privateKeyPath", () => {
  const g = GlobalArgsSchema.parse({
    workdir: "/repo",
    playbook: "p.yml",
    privateKeyPath: "/stale/on/disk",
  });
  const args = buildArgs("apply", g, A, { privateKeyFile: "/tmp/x/id_key" })
    .join(" ");
  assertStringIncludes(args, "--private-key /tmp/x/id_key");
  assert(!args.includes("/stale/on/disk"), "path should be superseded");
});

Deno.test("buildArgs: privateKey material never appears in argv", () => {
  const g = GlobalArgsSchema.parse({
    workdir: "/repo",
    playbook: "p.yml",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYBYTES\n",
  });
  const joined = buildArgs("apply", g, A, { privateKeyFile: "/tmp/x/id_key" })
    .join(" ");
  assert(!joined.includes("SECRETKEYBYTES"), "key material leaked to argv");
  assert(!joined.includes("BEGIN OPENSSH"), "key material leaked to argv");
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

// ── redactSecrets ─────────────────────────────────────────────────────────────

Deno.test("redactSecrets: removes secret values from captured output", () => {
  const out = redactSecrets(
    'ansible_become_password: "sup3r-s3cret-pw"\nvault: my-vault-pass',
    ["sup3r-s3cret-pw", "my-vault-pass"],
  );
  assert(!out.includes("sup3r-s3cret-pw"));
  assert(!out.includes("my-vault-pass"));
  assertStringIncludes(out, "***REDACTED***");
});

Deno.test("redactSecrets: replaces every occurrence, not just the first", () => {
  const out = redactSecrets("a longsecret b longsecret c", ["longsecret"]);
  assertEquals(out, "a ***REDACTED*** b ***REDACTED*** c");
});

Deno.test("redactSecrets: skips undefined and very short values", () => {
  // Redacting a 3-char value globally would mangle unrelated output.
  assertEquals(redactSecrets("the cat sat", [undefined, "cat"]), "the cat sat");
  assertEquals(redactSecrets("unchanged", []), "unchanged");
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

Deno.test("privateKey is materialised 0600 and removed after the run", async () => {
  // The stub reports the mode of the key file it was handed, and its content
  // length, so we can assert permissions without leaking the key.
  const { dir, bin } = await fakeAnsible(
    `prev=""
for a in "$@"; do
  if [ "$prev" = "--private-key" ]; then
    echo "KEYMODE: $(stat -f '%Lp' "$a" 2>/dev/null || stat -c '%a' "$a")"
    echo "KEYPATH: $a"
    echo "KEYLEN: $(wc -c < "$a" | tr -d ' ')"
  fi
  prev="$a"
done
cat <<'EOF'
PLAY RECAP ****
h1                         : ok=1    changed=0    unreachable=0    failed=0
EOF`,
  );
  const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYBYTES\n";
  let keyPath = "";
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GlobalArgsSchema.parse({
        workdir: dir,
        playbook: "site.yml",
        ansibleBin: bin,
        privateKey: KEY,
      }),
    });
    await methods.check.execute(methods.check.arguments.parse({}), context);
    const d = dataOf(getWrittenResources()[0]);
    assertStringIncludes(d.stdoutTail, "KEYMODE: 600");
    assertStringIncludes(d.stdoutTail, `KEYLEN: ${KEY.length}`);
    // The key must not be echoed anywhere in captured output.
    assert(
      !d.stdoutTail.includes("SECRETKEYBYTES"),
      "key material appeared in captured output",
    );
    keyPath =
      (d.stdoutTail.split("\n").find((l: string) => l.startsWith("KEYPATH: ")) ??
        "").replace("KEYPATH: ", "").trim();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  assert(keyPath.length > 0, "stub did not report the key path");
  let stillThere = true;
  try {
    await Deno.stat(keyPath);
  } catch {
    stillThere = false;
  }
  assert(!stillThere, `key file survived the run: ${keyPath}`);
});

Deno.test("a playbook echoing extra-vars cannot leak secrets into stored data", async () => {
  // Ansible dumps extra-vars at high verbosity. This stub simulates that by
  // printing the extra-vars file, which is exactly the leak path into the
  // datastore that redaction must close.
  const { dir, bin } = await fakeAnsible(
    `for a in "$@"; do
  case "$a" in
    @*) cat "$(echo "$a" | sed 's/^@//')" ;;
  esac
done
echo ""
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
        becomePassword: "sudo-p4ssw0rd-value",
        vaultPassword: "vault-p4ssw0rd-value",
      }),
    });
    await methods.check.execute(methods.check.arguments.parse({}), context);
    const d = dataOf(getWrittenResources()[0]);
    // The var *name* may legitimately appear; the value must not.
    assertStringIncludes(d.stdoutTail, "ansible_become_password");
    assert(
      !d.stdoutTail.includes("sudo-p4ssw0rd-value"),
      "become password reached persisted data",
    );
    assert(
      !d.stdoutTail.includes("vault-p4ssw0rd-value"),
      "vault password reached persisted data",
    );
    assertStringIncludes(d.stdoutTail, "***REDACTED***");
    // Redaction must not disturb recap parsing.
    assertEquals(d.status, "compliant");
    assertEquals(d.hostCount, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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
