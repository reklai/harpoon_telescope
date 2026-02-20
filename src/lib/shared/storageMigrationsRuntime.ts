import browser from "webextension-polyfill";
import { migrateStorageSnapshot, StorageMigrationResult } from "./storageMigrations";

export async function migrateStorageIfNeeded(): Promise<StorageMigrationResult> {
  const snapshot = (await browser.storage.local.get(null)) as Record<string, unknown>;
  const result = migrateStorageSnapshot(snapshot);
  if (!result.changed) return result;
  await browser.storage.local.set(result.migratedStorage);
  return result;
}

