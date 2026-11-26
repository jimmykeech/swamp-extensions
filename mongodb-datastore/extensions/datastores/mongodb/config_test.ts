import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { collectionPrefix, ConfigSchema } from "./config.ts";

Deno.test("tenant IDs cannot alias another repository collection prefix", () => {
  const base = { uri: "mongodb://unused", username: "unused" };
  const valid = ConfigSchema.parse({ ...base, tenantId: "a", namespace: "b_r_c" });
  assertEquals(collectionPrefix(valid), "t_a_r_b_r_c");
  assertThrows(
    () => ConfigSchema.parse({ ...base, tenantId: "a_r_b", namespace: "c" }),
    Error,
    "reserved collection separator",
  );
});
