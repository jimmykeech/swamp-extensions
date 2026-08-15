/**
 * Unit tests for `@jamesakeech/technitium`.
 *
 * The weight here is deliberately lopsided. Most of this extension is thin
 * request-shaping over a documented API, and a test that asserts a URL was
 * built proves little. The rData key mapping is different: it is the fix for
 * two of the three defects this extension exists to correct, and both of those
 * defects were SILENT — one shipped an unrestorable backup that reported
 * success, the other reported failure on a write that had already landed.
 * Silent wrongness is what deserves the tests.
 *
 * So the mapping gets exhaustive treatment, and one property matters above all:
 * a record read back from the server must compare EQUAL to the same record
 * expressed the way the API wants it written. Upstream compared those two
 * shapes directly, they could never match, and every TLSA write "failed".
 *
 * @module
 */
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";

import {
  buildMultipart,
  coerceArray,
  extractSettings,
  joinListUrls,
  namesFrom,
  rDataHash,
  rDataMatches,
  RDATA_WRITE_KEYS,
  recordInstanceName,
  slug,
  toNewWriteParams,
  toReadShape,
  toWriteParams,
  unwrapEnvelope,
} from "./technitium.ts";

// ---------------------------------------------------------------------------
// The read/write asymmetry — the heart of the fixes
// ---------------------------------------------------------------------------

/** The shape /zones/records/get returns for a TLSA record. */
const TLSA_READ = {
  certificateUsage: "DANE-EE",
  selector: "SPKI",
  matchingType: "SHA2-256",
  certificateAssociationData:
    "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
};

/** The same record as /zones/records/add and /update require it. */
const TLSA_WRITE = {
  tlsaCertificateUsage: "DANE-EE",
  tlsaSelector: "SPKI",
  tlsaMatchingType: "SHA2-256",
  tlsaCertificateAssociationData:
    "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
};

Deno.test("TLSA: the read shape and the write shape are the same record", () => {
  // THE regression test. Upstream compared these directly, never matched, and
  // reported "the live record is missing or has different/empty data" over a
  // record that was correct in the zone.
  assert(rDataMatches("TLSA", TLSA_WRITE, TLSA_READ));
  assert(rDataMatches("TLSA", TLSA_READ, TLSA_WRITE));
  assertEquals(toReadShape("TLSA", TLSA_WRITE), TLSA_READ);
  assertEquals(toReadShape("TLSA", TLSA_READ), TLSA_READ);
});

Deno.test("TLSA: writes carry the tlsa* parameter names", () => {
  assertEquals(toWriteParams("TLSA", TLSA_READ), TLSA_WRITE);
  // Idempotent: already-write-shaped input must not be double-prefixed.
  assertEquals(toWriteParams("TLSA", TLSA_WRITE), TLSA_WRITE);
});

Deno.test("TLSA: update parameters are the new* forms of the write names", () => {
  assertEquals(toNewWriteParams("TLSA", TLSA_READ), {
    newTlsaCertificateUsage: "DANE-EE",
    newTlsaSelector: "SPKI",
    newTlsaMatchingType: "SHA2-256",
    newTlsaCertificateAssociationData: TLSA_READ.certificateAssociationData,
  });
});

Deno.test("a differing pin does NOT match — the check still has teeth", () => {
  // Normalisation must not be so eager that it makes everything equal; a repin
  // that silently reported `unchanged` would leave the dead pin published.
  const other = { ...TLSA_READ, certificateAssociationData: "DEADBEEF" };
  assertFalse(rDataMatches("TLSA", other, TLSA_READ));
});

Deno.test("SRV and URI disagree about priority/weight", () => {
  // The reason RDATA_WRITE_KEYS is keyed by type rather than being one global
  // rename. Both read `priority`/`weight`; only URI prefixes them on write.
  assertEquals(toWriteParams("SRV", { priority: 10, weight: 5, port: 443 }), {
    priority: 10,
    weight: 5,
    port: 443,
  });
  assertEquals(toWriteParams("URI", { priority: 10, weight: 5, uri: "x" }), {
    uriPriority: 10,
    uriWeight: 5,
    uri: "x",
  });
});

Deno.test("SSHFP prefixes, SVCB does not", () => {
  assertEquals(
    toWriteParams("SSHFP", { algorithm: 1, fingerprintType: 2, fingerprint: "ab" }),
    { sshfpAlgorithm: 1, sshfpFingerprintType: 2, sshfpFingerprint: "ab" },
  );
  assertEquals(
    toWriteParams("HTTPS", { svcPriority: 1, svcTargetName: ".", svcParams: "" }),
    { svcPriority: 1, svcTargetName: ".", svcParams: "" },
  );
});

Deno.test("APP records carry content under recordData, not data", () => {
  // Spreading `data` verbatim sends an unrecognised parameter and Technitium
  // writes the record with EMPTY content, which then SERVFAILs at query time.
  assertEquals(toWriteParams("APP", { data: "{}" }), { recordData: "{}" });
});

Deno.test("symmetric types pass through untouched", () => {
  for (
    const [type, rd] of [
      ["A", { ipAddress: "192.0.2.10" }],
      ["CNAME", { cname: "x.example.com" }],
      ["TXT", { text: "hello" }],
      ["MX", { preference: 10, exchange: "mx.example.com" }],
      ["CAA", { flags: 0, tag: "issue", value: "letsencrypt.org" }],
    ] as const
  ) {
    assertEquals(toWriteParams(type, rd), rd as Record<string, unknown>);
    assertEquals(toReadShape(type, rd), rd as Record<string, unknown>);
  }
});

Deno.test("type matching is case-insensitive", () => {
  assertEquals(toWriteParams("tlsa", TLSA_READ), TLSA_WRITE);
  assert(rDataMatches("tlsa", TLSA_WRITE, TLSA_READ));
});

Deno.test("comparison ignores fields the caller did not specify", () => {
  // A caller asserting only on the pin should not be defeated by extra fields
  // the server volunteers.
  assert(rDataMatches("TLSA", { certificateUsage: "DANE-EE" }, TLSA_READ));
});

Deno.test("comparison is loose about number vs string", () => {
  // Technitium is inconsistent here; a TTL or priority read back as a string
  // must not read as a change.
  assert(rDataMatches("SRV", { priority: 10 }, { priority: "10" }));
});

Deno.test("null and undefined are dropped, not sent as empty", () => {
  assertEquals(
    toWriteParams("A", { ipAddress: "192.0.2.10", ttl: undefined, x: null }),
    { ipAddress: "192.0.2.10" },
  );
});

// ---------------------------------------------------------------------------
// Instance naming — collisions here silently fork a record's history
// ---------------------------------------------------------------------------

Deno.test("the two rData shapes hash to the SAME instance name", () => {
  // If they did not, repinning a TLSA through a differently-shaped call would
  // write a second data instance and the two would never reconcile.
  assertEquals(
    recordInstanceName("dns-cluster.example.com", "_53443._tcp.a.example.com", "TLSA", TLSA_READ),
    recordInstanceName("dns-cluster.example.com", "_53443._tcp.a.example.com", "TLSA", TLSA_WRITE),
  );
});

Deno.test("different values hash differently", () => {
  const a = rDataHash("TLSA", TLSA_READ);
  const b = rDataHash("TLSA", { ...TLSA_READ, certificateAssociationData: "AA" });
  assert(a !== b);
});

Deno.test("slug survives wildcards and underscores without colliding", () => {
  // A wildcard record's name sanitises to something indistinguishable from the
  // apex unless the rest of the instance name carries the difference.
  assertEquals(slug("*.example.com"), "example-com");
  assertEquals(slug("_53443._tcp.a"), "_53443-_tcp-a");
  assertEquals(slug("!!!"), "root");
});

// ---------------------------------------------------------------------------
// Envelope handling — a 200 is not a success
// ---------------------------------------------------------------------------

Deno.test("an error envelope throws despite HTTP 200", () => {
  assertThrows(
    () => unwrapEnvelope({ status: "error", errorMessage: "boom" }, "GET /x"),
    Error,
    "boom",
  );
});

Deno.test("an invalid token is named as such, not as a generic failure", () => {
  assertThrows(
    () => unwrapEnvelope({ status: "invalid-token" }, "GET /x"),
    Error,
    "invalid or expired API token",
  );
});

Deno.test("a success envelope yields its response, or an empty object", () => {
  assertEquals(unwrapEnvelope({ status: "ok", response: { a: 1 } }, "GET /x"), { a: 1 });
  assertEquals(unwrapEnvelope({ status: "ok" }, "GET /x"), {});
});

// ---------------------------------------------------------------------------
// Response coercion
// ---------------------------------------------------------------------------

Deno.test("namesFrom accepts strings and objects, and de-duplicates", () => {
  assertEquals(
    namesFrom(
      { zones: ["a.com", { name: "b.com" }], records: [{ domain: "a.com" }] },
      "zones",
      "records",
    ),
    ["a.com", "b.com"],
  );
});

Deno.test("coerceArray returns the first array key present", () => {
  assertEquals(coerceArray({ entries: [{ a: 1 }] }, "entries"), [{ a: 1 }]);
  assertEquals(coerceArray({ entries: "not-an-array" }, "entries"), []);
});

// ---------------------------------------------------------------------------
// Block list URLs
// ---------------------------------------------------------------------------

Deno.test("list URLs join on comma and overlong ones are surfaced", () => {
  const long = "https://example.com/" + "x".repeat(250);
  const { joined, tooLong } = joinListUrls(["https://a.com/l.txt", long]);
  assertEquals(joined, `https://a.com/l.txt,${long}`);
  assertEquals(tooLong, [long]);
});

// ---------------------------------------------------------------------------
// Settings extraction
// ---------------------------------------------------------------------------

Deno.test("extractSettings survives a sparse settings response", () => {
  const s = extractSettings({ enableBlocking: true }, "2026-08-15T00:00:00Z");
  assertEquals(s.enableBlocking, true);
  assertEquals(s.forwarders, []);
  assertEquals(s.dnsServerDomain, null);
  assertEquals(s.clusterInitialized, false);
});

Deno.test("clusterInitialized is strictly boolean, never truthy-coerced", () => {
  // A node that is not in a cluster must never read as one because the field
  // arrived as a non-empty string.
  assertEquals(
    extractSettings({ clusterInitialized: "false" }, "t").clusterInitialized,
    false,
  );
  assertEquals(
    extractSettings({ clusterInitialized: true }, "t").clusterInitialized,
    true,
  );
});

// ---------------------------------------------------------------------------
// Multipart upload
// ---------------------------------------------------------------------------

Deno.test("multipart body wraps the bytes intact between the boundaries", () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // a zip's magic
  const { body, contentType } = buildMultipart("fileToUpload", "backup.zip", bytes);
  const text = new TextDecoder().decode(body);
  const boundary = contentType.split("boundary=")[1];
  assert(contentType.startsWith("multipart/form-data; boundary="));
  assert(text.includes(`name="fileToUpload"; filename="backup.zip"`));
  assert(text.startsWith(`--${boundary}\r\n`));
  assert(text.endsWith(`\r\n--${boundary}--\r\n`));
  // The payload must survive byte-for-byte — a corrupted zip restores nothing.
  const start = body.length - bytes.length - `\r\n--${boundary}--\r\n`.length;
  assertEquals(Array.from(body.slice(start, start + bytes.length)), Array.from(bytes));
});

// ---------------------------------------------------------------------------
// The mapping table itself
// ---------------------------------------------------------------------------

Deno.test("every mapping is invertible — no two read keys share a write key", () => {
  for (const [type, map] of Object.entries(RDATA_WRITE_KEYS)) {
    const writes = Object.values(map);
    assertEquals(
      new Set(writes).size,
      writes.length,
      `${type} maps two read keys onto one write key, which cannot round-trip`,
    );
  }
});
