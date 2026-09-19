// Host-independent Content I/O ABI. Wire host objects are validated at runtime.
export type ContentIdentityV1 =
  | Readonly<{ kind: "FILE_SHA256"; sha256: string }>
  | Readonly<{ kind: "INDEX_ENTRY"; projectDigest: string; logicalPath: string }>;

export type ContentReadOriginV1 = "NETWORK" | "MEMORY" | "PERSISTENT";

export type ContentFetchPolicyV1 = Readonly<{
  smallFileThresholdBytes: number;
  networkWindowBytes: number;
}>;

export type ContentSourceV1 = Readonly<{
  identity: ContentIdentityV1;
  sizeBytes: number;
  url: string;
  purpose: "GAME" | "FIRMWARE" | "CORE_ASSET";
  transport: "RANGE_REQUIRED" | "WHOLE_ALLOWED";
  etagPolicy: "EXPECTED_SHA256" | "PIN_STRONG" | "NONE_FULL_SHA256" | "IMMUTABLE_ASSET";
  contentLengthPolicy: "EXACT_IF_PRESENT" | "REQUIRED_EXACT";
}>;

export type ManagedInputPolicyV1 = Readonly<{
  mode: "RANGE" | "EAGER" | "ON_OPEN";
  bridge: "ASYNC" | "SYNC_WORKER" | "POLLING" | "WASMFS" | "VLFS" | "NONE";
  result: "READER" | "BYTES" | "BLOB" | "WORKSPACE_FILE";
  maxFileBytes: number;
  workspace: "NONE" | "OPFS_REQUIRED";
  writes: "DENY" | "SESSION_OVERLAY";
  contentLengthPolicy: "EXACT_IF_PRESENT" | "REQUIRED_EXACT";
}>;

export type ContentInputPolicyV1 = ManagedInputPolicyV1 | Readonly<{
  mode: "BROWSER_NATIVE" | "UPSTREAM_LOADER";
  boundaryId: string;
}>;

export interface ContentReaderV1 {
  readonly abi: "content-io-v1";
  readonly id: string;
  readonly sizeBytes: number;
  readInto(offset: number, destination: Uint8Array, signal?: AbortSignal): Promise<number>;
  tryReadInto(offset: number, destination: Uint8Array): number | null;
  stream(offset: number, length: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

export type MaterializationReceiptV1 = Readonly<{
  objectKey: string;
  storageGeneration: string;
  sizeBytes: number;
  localSha256: string;
  assurance: "EXPECTED_SHA256" | "TRUSTED_IMMUTABLE_INDEX";
  pinnedEtag: string | null;
}>;

export interface MaterializeSinkV1 {
  write(offset: number, chunk: Uint8Array): Promise<void>;
  commit(receipt: MaterializationReceiptV1): Promise<void>;
  abort(reason: "CANCELLED" | "FAILED" | "RESTART"): Promise<void>;
}

export type MaterializeRequestV1 =
  | Readonly<{kind: "BYTES"; maxBytes: number}>
  | Readonly<{kind: "BLOB"; maxBytes: number}>
  | Readonly<{kind: "SINK"; maxBytes: number; createSink: () => Promise<MaterializeSinkV1>}>;

export type MaterializeResultV1 =
  | Readonly<{kind: "BYTES"; bytes: Uint8Array; receipt: MaterializationReceiptV1}>
  | Readonly<{kind: "BLOB"; blob: Blob; receipt: MaterializationReceiptV1; release: () => Promise<void>}>
  | Readonly<{kind: "SINK"; receipt: MaterializationReceiptV1}>;

export type WorkerBootV1 = Readonly<{
  type: "BOOT";
  v: 1;
  abi: "content-io-v1";
  contractSha256: string;
  sessionId: string;
  managementChannelId: string;
  managementPort: MessagePort;
  storageOrigin: string;
  allowedOrigins: readonly string[];
  l1BudgetBytes: number;
  l2BudgetBytes: number;
  fetchPolicy: ContentFetchPolicyV1;
  diagnostics?: true;
}>;

export type WireBaseV1 = Readonly<{v: 1; sessionId: string; channelId: string; epoch: number; requestId: number}>;
export type ContentDiagnosticCountsV1 = Readonly<{
  networkBytes?: number;
  serverSentBytes?: number;
  rangeRequests?: number;
  wholeRequests?: number;
  headRequests?: number;
  memoryHitBytes?: number;
  persistentHitBytes?: number;
  readyBytes?: number;
  materializedBytes?: number;
  materializedBytesByBytes?: number;
  materializedBytesByBlob?: number;
  materializedBytesBySink?: number;
  cacheBytesL1?: number;
  cacheBytesL2?: number;
  temporaryBytes?: number;
  outputCreditBytes?: number;
  syncBufferBytes?: number;
  inflight?: number;
  queued?: number;
  waiters?: number;
  channels?: number;
  leases?: number;
  retries?: number;
  wholeRestartCount?: number;
  cacheDegrades?: number;
  corruptBlocks?: number;
  firstFrameMs?: number;
  inputReadyMs?: number;
  exitMs?: number;
  peakCacheBytesL1?: number;
  peakCacheBytesL2?: number;
  peakTemporaryBytes?: number;
  peakOutputCreditBytes?: number;
  peakSyncBufferBytes?: number;
  peakInflight?: number;
  peakQueued?: number;
  peakWaiters?: number;
  peakChannels?: number;
  peakLeases?: number;
}>;
export interface WireFieldsV1 {
  OPEN: Readonly<{source: ContentSourceV1; policy: ManagedInputPolicyV1}>;
  OPEN_OK: Readonly<{fileId: string; sizeBytes: number; objectKey: string}>;
  NEW_CHANNEL: Readonly<{consumerChannelId: string; allowedFileIds: readonly (string)[]; mode: "ASYNC" | "SYNC"; port: MessagePort; buffer: SharedArrayBuffer | null}>;
  CHANNEL_OK: Readonly<{consumerChannelId: string; consumerEpoch: 1}>;
  PREPARE: Readonly<{fileId: string; jobId: string; result: "BYTES" | "BLOB" | "STREAM"; maxBytes: number}>;
  JOB_CHUNK: Readonly<{jobId: string; attempt: 0 | 1; chunkIndex: number; offset: number; bytes: ArrayBuffer}>;
  JOB_ACK: Readonly<{jobId: string; attempt: 0 | 1; chunkIndex: number}>;
  JOB_RESTART: Readonly<{jobId: string; attempt: 1}>;
  JOB_RESTART_ACK: Readonly<{jobId: string; attempt: 1}>;
  JOB_PROGRESS: Readonly<{jobId: string; attempt: 0 | 1; readyBytes: number; totalBytes: number; networkBytes: number}>;
  PREPARE_OK: Readonly<{jobId: string; attempt: 0 | 1; kind: "BYTES" | "BLOB" | "STREAM"; bytes: ArrayBuffer | null; blob: Blob | null; receipt: MaterializationReceiptV1; leaseId: string | null}>;
  JOB_CANCEL: Readonly<{jobId: string}>;
  CANCEL_OK: Readonly<{jobId: string}>;
  RELEASE_LEASE: Readonly<{leaseId: string}>;
  RELEASE_OK: Readonly<{leaseId: string}>;
  CLOSE_FILE: Readonly<{fileId: string}>;
  FILE_CLOSED: Readonly<{fileId: string}>;
  CLOSE_SESSION: Readonly<{}>;
  SESSION_CLOSED: Readonly<{}>;
  ERROR: Readonly<{codeNumber: number; scope: "REQUEST" | "OBJECT" | "SESSION"}>;
  BACKEND_READY: Readonly<{backend: "OPFS" | "CACHE_BLOCKS" | "MEMORY"}>;
  OBJECT_REVOKED: Readonly<{objectKey: string; codeNumber: number}>;
  DIAGNOSTIC: Readonly<{codeNumber: number; objectKey: string | null; operation: "CACHE_PROBE" | "CACHE_READ" | "CACHE_WRITE" | "CACHE_GC" | "CACHE_DEGRADE" | "READ" | "MATERIALIZE" | "CLOSE" | "ABI"; counts: ContentDiagnosticCountsV1}>;
  READ: Readonly<{fileId: string; offset: number; length: number; timeoutMs: number}>;
  READ_OK: Readonly<{fileId: string; offset: number; length: number; bytes: ArrayBuffer; origin: ContentReadOriginV1}>;
  READ_ERROR: Readonly<{codeNumber: number; scope: "REQUEST" | "OBJECT" | "SESSION"}>;
  FILE_REVOKED: Readonly<{fileId: string; codeNumber: number}>;
  READ_ACK: Readonly<{ackRequestId: number}>;
  SLOT_FREE: Readonly<{completedRequestId: number}>;
  CANCEL: Readonly<{cancelRequestId: number}>;
  CLOSE_CHANNEL: Readonly<{}>;
  CHANNEL_CLOSED: Readonly<{codeNumber: number}>;
}
export type ContentMessageV1 = {[Kind in keyof WireFieldsV1]: WireBaseV1 & Readonly<{type: Kind}> & WireFieldsV1[Kind]}[keyof WireFieldsV1];
export type ManagementRequestV1 = Extract<ContentMessageV1, {type: "OPEN" | "NEW_CHANNEL" | "PREPARE" | "JOB_ACK" | "JOB_RESTART_ACK" | "JOB_CANCEL" | "RELEASE_LEASE" | "CLOSE_FILE" | "CLOSE_SESSION"}>;
export type ConsumerRequestV1 = Extract<ContentMessageV1, {type: "READ" | "READ_ACK" | "SLOT_FREE" | "CANCEL" | "CLOSE_CHANNEL"}>;
