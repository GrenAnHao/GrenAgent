import type { PackageChangelog, PackageSnapshot } from './piPackageMetadata';

/** Configuration intent, installed bytes and loaded resource generation are independent facts. */
export interface PackageTarget {
  source: string;
  version?: string;
  commit?: string;
}
export interface PackageInstallUnit {
  root: string;
  kind: 'npm' | 'git';
  scope: 'user' | 'project';
  workspace?: string;
  packages: PackageSnapshot[];
}
export interface PackageConsumer {
  id: string;
  processId: number;
  kind: 'host' | 'worker';
  workspace?: string;
  sessionPath?: string;
  generation: string;
  busy: boolean;
  canRebuild: boolean;
  reason?: string;
}
export interface PackageConsumerScope {
  unitRoot: string;
  consumers: PackageConsumer[];
  /** Only desktop-owned consumers. External Pi/CLI are covered by explicit user preconditions. */
  enumerated: boolean;
  blockers: string[];
}
export interface PackageLoadedTarget extends PackageTarget {
  key: string;
  state: 'loaded' | 'autoload-off' | 'no-resources' | 'failed';
  resourcePaths: string[];
  error?: string;
}
export interface PackageReloadReceipt {
  operationId: string;
  unitRoot: string;
  consumerId: string;
  expectedGeneration: string;
  actualGeneration?: string;
  targets: PackageLoadedTarget[];
  error?: string;
}
export interface PackageUpdatePreview {
  previewId: string;
  operation: 'upgrade' | 'repair';
  snapshot: PackageSnapshot;
  from: PackageTarget;
  target: PackageTarget;
  unit: PackageInstallUnit;
  consumers: PackageConsumerScope;
  changelog: PackageChangelog;
  externalQuietRequired: true;
  risks: string[];
}
export type PackageOperationPhase = 'preparing' | 'waiting-idle' | 'ready-to-switch' | 'switching' | 'installed' | 'reload-pending' | 'complete' | 'failed-restored' | 'reload-failed' | 'restart-required' | 'recovery-required';
export interface PackageDependencyChange { path: string; from?: string; to?: string }
export interface PackageOperation {
  operationId: string;
  key: string;
  operation: 'upgrade' | 'repair';
  phase: PackageOperationPhase;
  from: PackageTarget;
  target: PackageTarget;
  unit: PackageInstallUnit;
  consumers: PackageConsumerScope;
  receipts: PackageReloadReceipt[];
  dependencies: PackageDependencyChange[];
  changelog?: PackageChangelog;
  canRestore: boolean;
  error?: string;
  /** Empty is meaningful only when consumers.enumerated is true and blockers is empty. */
  nextStartupVerification: boolean;
}
export interface PackageApplyConsent { confirmed: boolean; externalConsumersClosed: boolean }
