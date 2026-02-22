const STORAGE_SCHEMA_VERSION_KEY = "storageSchemaVersion";
export const STORAGE_SCHEMA_VERSION = 1;

const MAX_TAB_MANAGER_SLOTS = 4;
const MAX_SESSIONS = 4;

type StorageSnapshot = Record<string, unknown>;

export interface StorageMigrationResult {
  fromVersion: number;
  toVersion: number;
  changed: boolean;
  migratedStorage: StorageSnapshot;
}

function hasKey(storage: StorageSnapshot, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(storage, key);
}

function toNonNegativeNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, numeric);
}

function toPositiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.floor(numeric);
  if (rounded <= 0) return null;
  return rounded;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readSchemaVersion(storage: StorageSnapshot): number {
  const value = toPositiveInteger(storage[STORAGE_SCHEMA_VERSION_KEY]);
  return value || 0;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeTabManagerList(rawValue: unknown): TabManagerEntry[] | null {
  if (!Array.isArray(rawValue)) return null;
  const normalized: TabManagerEntry[] = [];
  for (const rawEntry of rawValue) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    const entry = rawEntry as Partial<TabManagerEntry>;
    const tabId = toPositiveInteger(entry.tabId);
    const url = asString(entry.url);
    if (!tabId || !url) continue;

    const normalizedEntry: TabManagerEntry = {
      tabId,
      url,
      title: asString(entry.title),
      scrollX: toNonNegativeNumber(entry.scrollX, 0),
      scrollY: toNonNegativeNumber(entry.scrollY, 0),
      slot: normalized.length + 1,
    };
    if (entry.closed === true) {
      normalizedEntry.closed = true;
    }
    normalized.push(normalizedEntry);

    if (normalized.length >= MAX_TAB_MANAGER_SLOTS) break;
  }
  return normalized;
}

function normalizeSessions(rawValue: unknown): TabManagerSession[] | null {
  if (!Array.isArray(rawValue)) return null;

  const normalized: TabManagerSession[] = [];
  const seenSessionNames = new Set<string>();

  for (const rawSession of rawValue) {
    if (typeof rawSession !== "object" || rawSession === null) continue;
    const session = rawSession as Partial<TabManagerSession>;

    const name = asString(session.name).trim();
    if (!name) continue;
    const lowerName = name.toLowerCase();
    if (seenSessionNames.has(lowerName)) continue;

    const rawEntries = Array.isArray(session.entries) ? session.entries : [];
    const entries: TabManagerSessionEntry[] = [];
    for (const rawEntry of rawEntries) {
      if (typeof rawEntry !== "object" || rawEntry === null) continue;
      const entry = rawEntry as Partial<TabManagerSessionEntry>;
      const url = asString(entry.url);
      if (!url) continue;
      entries.push({
        url,
        title: asString(entry.title),
        scrollX: toNonNegativeNumber(entry.scrollX, 0),
        scrollY: toNonNegativeNumber(entry.scrollY, 0),
      });
    }
    if (entries.length === 0) continue;

    normalized.push({
      name,
      entries,
      savedAt: toNonNegativeNumber(session.savedAt, 0),
    });
    seenSessionNames.add(lowerName);

    if (normalized.length >= MAX_SESSIONS) break;
  }

  return normalized;
}

function normalizeFrecencyData(rawValue: unknown): FrecencyEntry[] | null {
  if (!Array.isArray(rawValue)) return null;
  const normalized: FrecencyEntry[] = [];

  for (const rawEntry of rawValue) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    const entry = rawEntry as Partial<FrecencyEntry>;
    const tabId = toPositiveInteger(entry.tabId);
    const url = asString(entry.url);
    if (!tabId || !url) continue;
    normalized.push({
      tabId,
      url,
      title: asString(entry.title),
      visitCount: Math.max(0, toNonNegativeNumber(entry.visitCount, 0)),
      lastVisit: toNonNegativeNumber(entry.lastVisit, 0),
      frecencyScore: Math.max(0, toNonNegativeNumber(entry.frecencyScore, 0)),
    });
  }

  return normalized;
}

function normalizeKey<T>(
  storage: StorageSnapshot,
  key: string,
  normalizer: (value: unknown) => T | null,
): boolean {
  if (!hasKey(storage, key)) return false;
  const normalized = normalizer(storage[key]);
  if (normalized === null) return false;
  if (deepEqual(storage[key], normalized)) return false;
  storage[key] = normalized;
  return true;
}

function migrateV0ToV1(storage: StorageSnapshot): boolean {
  let changed = false;
  changed = normalizeKey(storage, "tabManagerList", normalizeTabManagerList) || changed;
  changed = normalizeKey(storage, "tabManagerSessions", normalizeSessions) || changed;
  changed = normalizeKey(storage, "frecencyData", normalizeFrecencyData) || changed;
  return changed;
}

export function migrateStorageSnapshot(input: StorageSnapshot): StorageMigrationResult {
  const migratedStorage: StorageSnapshot = { ...input };
  const fromVersion = readSchemaVersion(input);

  // Forward-compatibility: do not downgrade unknown future schema versions.
  if (fromVersion > STORAGE_SCHEMA_VERSION) {
    return {
      fromVersion,
      toVersion: fromVersion,
      changed: false,
      migratedStorage,
    };
  }

  let changed = false;
  let workingVersion = fromVersion;

  while (workingVersion < STORAGE_SCHEMA_VERSION) {
    if (workingVersion === 0) {
      changed = migrateV0ToV1(migratedStorage) || changed;
      workingVersion = 1;
      continue;
    }
    break;
  }

  if (migratedStorage[STORAGE_SCHEMA_VERSION_KEY] !== workingVersion) {
    migratedStorage[STORAGE_SCHEMA_VERSION_KEY] = workingVersion;
    changed = true;
  }

  return {
    fromVersion,
    toVersion: workingVersion,
    changed,
    migratedStorage,
  };
}
