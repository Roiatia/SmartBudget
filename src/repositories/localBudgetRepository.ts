import { createEmptySnapshot, normalizeSnapshot, storageKeyV1, storageKeyV2 } from "../budgetMath";
import type { BudgetRepository, BudgetSnapshot } from "../types";

export class LocalBudgetRepository implements BudgetRepository {
  mode = "local" as const;

  async load(): Promise<BudgetSnapshot> {
    return readLocalSnapshot();
  }

  async save(snapshot: BudgetSnapshot): Promise<BudgetSnapshot> {
    writeLocalSnapshot(snapshot);
    return snapshot;
  }

  async importSnapshot(snapshot: BudgetSnapshot): Promise<BudgetSnapshot> {
    const normalized = normalizeSnapshot(snapshot);
    writeLocalSnapshot(normalized);
    return normalized;
  }
}

export function readLocalSnapshot(): BudgetSnapshot {
  const v2 = localStorage.getItem(storageKeyV2);
  if (v2) return normalizeSnapshot(JSON.parse(v2));

  const v1 = localStorage.getItem(storageKeyV1);
  if (v1) {
    const migrated = normalizeSnapshot(JSON.parse(v1));
    writeLocalSnapshot(migrated);
    return migrated;
  }

  return createEmptySnapshot();
}

export function writeLocalSnapshot(snapshot: BudgetSnapshot): void {
  localStorage.setItem(storageKeyV2, JSON.stringify(snapshot));
}
