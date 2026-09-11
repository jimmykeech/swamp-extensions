import { Binary, MongoServerError } from "npm:mongodb@6.17.0";
import type { ClientHandle } from "./client.ts";
import { collectionPrefix, type MongoDatastoreConfig } from "./config.ts";

interface ControlRecord {
  _id: string;
  namespace: string | null;
  key: string;
  data: Binary;
}

/** Direct remote coordination records; deliberately bypasses cache and sync. */
export function createControlPlaneStore(
  cfg: MongoDatastoreConfig,
  getClient: (repoDir: string) => Promise<ClientHandle>,
  repoDir: string,
  namespace?: string,
) {
  // Null is the unnamespaced root. Tuple encoding prevents separator collisions.
  const scope = namespace ?? null;
  const id = (key: string) => JSON.stringify([scope, key]);
  const collection = async () => {
    const { client } = await getClient(repoDir);
    return client.db(cfg.database).collection<ControlRecord>(
      `${collectionPrefix(cfg)}_control`,
      {
        writeConcern: { w: "majority" },
        readConcern: { level: "majority" },
        readPreference: "primary",
      },
    );
  };

  return {
    async put(key: string, data: Uint8Array): Promise<void> {
      const records = await collection();
      await records.updateOne(
        { _id: id(key) },
        { $set: { namespace: scope, key, data: new Binary(data) } },
        { upsert: true },
      );
    },

    async putIfAbsent(key: string, data: Uint8Array): Promise<boolean> {
      const records = await collection();
      try {
        await records.insertOne({
          _id: id(key),
          namespace: scope,
          key,
          data: new Binary(data),
        });
        return true;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) {
          return false;
        }
        throw error;
      }
    },

    async get(key: string): Promise<Uint8Array | null> {
      const records = await collection();
      const record = await records.findOne({ _id: id(key) });
      return record ? new Uint8Array(record.data.buffer) : null;
    },

    async delete(key: string): Promise<void> {
      const records = await collection();
      await records.deleteOne({ _id: id(key) });
    },

    async list(prefix: string): Promise<string[]> {
      const records = await collection();
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = await records.find(
        { namespace: scope, key: { $regex: `^${escaped}` } },
        { projection: { key: 1 } },
      ).toArray();
      return matches.map((record) => record.key).sort();
    },
  };
}
