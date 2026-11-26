import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { model } from "./nix_vm_vuln_scan.ts";

Deno.test("sshTarget check requires a host name", async () => {
  const missing = await model.checks.sshTarget.execute({ globalArgs: {} });
  assertEquals(missing.pass, false);
  assertEquals(missing.errors ?? [], ["host is required"]);

  const ready = await model.checks.sshTarget.execute({
    globalArgs: { host: "192.0.2.10", sshUser: "example" },
  });
  assertEquals(ready.pass, true);
});

Deno.test("scan does not connect when the host is not a host name", async () => {
  let writes = 0;
  await assertRejects(
    () =>
      model.methods.scan.execute({ maxPackages: 500 }, {
        globalArgs: { host: "bad host", sshUser: "example", port: 22, identityFile: "" },
        writeResource: () => {
          writes += 1;
          return Promise.resolve({ name: "scan" });
        },
      }),
    Error,
    "not a host name",
  );
  assertEquals(writes, 0);
});
