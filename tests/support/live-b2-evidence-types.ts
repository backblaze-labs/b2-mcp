import { createRequire } from "module";

export interface LiveResourceLike {
  type?: string;
  label?: string;
  name?: string;
  bucketName?: string;
  key?: string;
  id?: string;
  bucketId?: string;
  fileId?: string;
}

export interface LiveResourceEvidenceEntry {
  schemaVersion: number;
  recordedAt: string;
  type: string;
  label?: string;
  runPrefix: string;
  matchesRunPrefix: boolean;
  nameFingerprint?: string;
  idFingerprint?: string;
}

export interface LiveB2EvidenceModule {
  LIVE_RESOURCE_LEDGER_ENV: string;
  liveResourceEvidenceEntry(
    resource: LiveResourceLike,
    options?: { prefix?: string; env?: NodeJS.ProcessEnv },
  ): LiveResourceEvidenceEntry;
  liveResourceLedgerPath(env?: NodeJS.ProcessEnv): string;
  recordLiveResource(
    resource: LiveResourceLike,
    options?: { ledgerPath?: string; prefix?: string; env?: NodeJS.ProcessEnv },
  ): LiveResourceEvidenceEntry | null;
}

const nodeRequire = createRequire(__filename);

export const liveB2Evidence = nodeRequire(
  "../../scripts/lib/live-b2-evidence.cjs",
) as LiveB2EvidenceModule;
