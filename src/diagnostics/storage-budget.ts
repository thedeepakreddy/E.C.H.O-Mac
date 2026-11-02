/**
 * Bounded diagnostic writes. Existing files are counted, never trimmed or removed.
 * After a stop, quit Echo and manually archive the diagnostic directory elsewhere
 * before restarting. Recovery/checkpoint and user files are not retention targets.
 */
import { lstatSync, opendirSync, statfsSync, openSync, appendFileSync, closeSync, constants } from 'node:fs';
import { dirname, relative, resolve, isAbsolute, join, sep } from 'node:path';

export const MiB = 1024 * 1024;
export const DIAGNOSTIC_BUDGET = Object.freeze({ fileBytes: 8 * MiB, directoryBytes: 512 * MiB, diskReserveBytes: 1024 * MiB });
export const REPLAY_BUDGET = Object.freeze({ eventBytes: 4 * MiB, blobBytes: 64 * MiB, singleBlobBytes: 8 * MiB, eventCount: 20000, terminalReserveBytes: 64 * 1024, terminalEventBytes: 16 * 1024 });
export const INVENTORY_BUDGET = Object.freeze({ entries: 32768, milliseconds: 500, recheckMs: 5 * 60 * 1000 });
export type DiskStat = () => { bavail: number | bigint; bsize: number | bigint };
export interface ScanProgress { reason: 'entries' | 'time' | 'depth'; entries: number; elapsedMs: number; maxEntries: number; maxMs: number }
export class StorageBudgetError extends Error {
  constructor(readonly code: string, readonly scan?: ScanProgress) { super(`Storage recording stopped (${code}${scan ? `: ${scan.reason}, ${scan.entries}/${scan.maxEntries} entries, ${Math.round(scan.elapsedMs)}/${scan.maxMs} ms` : ''}); manually archive diagnostics before restarting. No existing data was deleted.`); this.name = 'StorageBudgetError'; }
}
function entryAt(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export interface ScanOptions { scanEntries?: number; scanMs?: number; recheckMs?: number }
type Reservation = { bytes: number; directoryBytes: number; diskReserveBytes: number };
type Inventory = { bytes: number; files: Map<string, number>; at: number; reservations: Map<symbol, Reservation>; scannedEntries: number; scanMs: number };
const inventories = new Map<string, Inventory>();
function inventory(root: string, options: ScanOptions): Inventory {
  const maxEntries = options.scanEntries ?? INVENTORY_BUDGET.entries, maxMs = options.scanMs ?? INVENTORY_BUDGET.milliseconds;
  const result: Inventory = { bytes: 0, files: new Map(), at: performance.now(), reservations: new Map(), scannedEntries: 0, scanMs: 0 };
  let entries = 0;
  const visit = (path: string, depth: number): void => {
    ++entries;
    const elapsedMs = performance.now() - result.at;
    if (entries > maxEntries || depth > 32 || elapsedMs > maxMs) throw new StorageBudgetError('scan-limit', { reason: entries > maxEntries ? 'entries' : depth > 32 ? 'depth' : 'time', entries, elapsedMs, maxEntries, maxMs });
    const entry = entryAt(path); if (!entry) return;
    if (!entry.isDirectory() || entry.isSymbolicLink()) { result.bytes += entry.size; result.files.set(resolve(path), entry.size); return; }
    const dir = opendirSync(path);
    try { let child; while ((child = dir.readSync())) visit(join(path, child.name), depth + 1); } finally { dir.closeSync(); }
  };
  visit(root, 0);
  result.scannedEntries = entries; result.scanMs = performance.now() - result.at;
  return result;
}
export function directoryBytes(dir: string, options: ScanOptions = {}): number { return inventory(dir, options).bytes; }
function usage(root: string, options: ScanOptions): Inventory {
  const key = resolve(root), old = inventories.get(key);
  if (old && performance.now() - old.at < (options.recheckMs ?? INVENTORY_BUDGET.recheckMs)) return old;
  const current = inventory(key, options); current.reservations = old?.reservations ?? new Map(); inventories.set(key, current); return current;
}
/** Call only after a successful write. All sinks in this process share this count. */
export function accountDiagnosticWrite(root: string, file: string, bytes: number): void {
  const current = inventories.get(resolve(root));
  if (current) { current.bytes += bytes; current.files.set(resolve(file), (current.files.get(resolve(file)) ?? 0) + bytes); }
}
export function validateDiagnosticPath(root: string, file: string): void {
  const base = resolve(root), rel = relative(base, resolve(file));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new StorageBudgetError('unsafe-path');
  let path = resolve(file);
  for (;;) {
    if (entryAt(path)?.isSymbolicLink()) throw new StorageBudgetError('unsafe-path');
    if (path === base) break;
    path = dirname(path);
  }
  // For a not-yet-created root, also validate its nearest existing ancestor.
  path = base;
  while (!entryAt(path) && dirname(path) !== path) path = dirname(path);
  if (entryAt(path)?.isSymbolicLink()) throw new StorageBudgetError('unsafe-path');
}
function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageBudgetError('invalid-limit');
}
export function checkDiskReserve(path: string, incomingBytes: number, options: { reserveBytes?: number; statfs?: DiskStat } = {}): void {
  const reserve = options.reserveBytes ?? DIAGNOSTIC_BUDGET.diskReserveBytes;
  positive(incomingBytes); positive(reserve);
  let existing = resolve(path);
  while (!entryAt(existing) && dirname(existing) !== existing) existing = dirname(existing);
  if (entryAt(existing)?.isSymbolicLink()) throw new StorageBudgetError('unsafe-path');
  let available: number;
  try {
    const stats = options.statfs ? options.statfs() : statfsSync(existing);
    available = Number(stats.bavail) * Number(stats.bsize);
  } catch { throw new StorageBudgetError('disk-space-unknown'); }
  if (!Number.isFinite(available) || available < 0) throw new StorageBudgetError('disk-space-unknown');
  if (available - incomingBytes < reserve) throw new StorageBudgetError('disk-reserve');
}
export interface DiagnosticOptions extends ScanOptions {
  fileBytes?: number; directoryBytes?: number; diskReserveBytes?: number;
  statfs?: DiskStat; warn?: (message: string) => void;
  reservationOwner?: symbol;
}
/** Initial inventory is bounded; subsequent writes use process-shared accounting.
 * External changes are reconciled on the next write after five minutes. This is
 * a soft cross-process policy, not a filesystem quota. Disk reserve is checked
 * on every write; historical files are never excluded as a new baseline.
 */
export function checkDiagnosticWrite(root: string, file: string, bytes: number, options: DiagnosticOptions = {}, protectedBytes = 0): { bytes: number; files: number; scannedEntries: number; scanMs: number } {
  const limits = { ...DIAGNOSTIC_BUDGET, ...options };
  for (const n of [bytes, protectedBytes, limits.fileBytes, limits.directoryBytes, limits.diskReserveBytes]) positive(n);
  validateDiagnosticPath(root, file);
  const current = usage(root, options);
  if (!current.files.has(resolve(file))) {
    const existing = entryAt(file);
    if (existing) { current.files.set(resolve(file), existing.size); current.bytes += existing.size; }
  }
  const used = current.files.get(resolve(file)) ?? 0;
  let otherReservations = 0, directoryLimit = limits.directoryBytes, diskReserve = limits.diskReserveBytes;
  for (const [owner, policy] of current.reservations) {
    if (owner !== options.reservationOwner) otherReservations += policy.bytes;
    directoryLimit = Math.min(directoryLimit, policy.directoryBytes);
    diskReserve = Math.max(diskReserve, policy.diskReserveBytes);
  }
  if (!current.files.has(resolve(file)) && current.files.size >= (options.scanEntries ?? INVENTORY_BUDGET.entries)) throw new StorageBudgetError('scan-limit', { reason: 'entries', entries: current.files.size + 1, elapsedMs: performance.now() - current.at, maxEntries: options.scanEntries ?? INVENTORY_BUDGET.entries, maxMs: options.scanMs ?? INVENTORY_BUDGET.milliseconds });
  if (used + bytes + protectedBytes > limits.fileBytes) throw new StorageBudgetError('file-limit');
  if (current.bytes + bytes + protectedBytes + otherReservations > directoryLimit) throw new StorageBudgetError('directory-limit');
  checkDiskReserve(root, bytes + protectedBytes + otherReservations, { reserveBytes: diskReserve, statfs: options.statfs });
  return { bytes: current.bytes, files: current.files.size, scannedEntries: current.scannedEntries, scanMs: current.scanMs };
}

/** Reserve per-run terminal bytes before admission; every sink respects them. */
export function reserveDiagnosticSpace(root: string, file: string, bytes: number, options: DiagnosticOptions): { owner: symbol; release: () => void } {
  checkDiagnosticWrite(root, file, 0, options, bytes);
  const current = usage(root, options), owner = Symbol('replay terminal reservation');
  current.reservations.set(owner, { bytes, directoryBytes: options.directoryBytes ?? DIAGNOSTIC_BUDGET.directoryBytes, diskReserveBytes: options.diskReserveBytes ?? DIAGNOSTIC_BUDGET.diskReserveBytes });
  return { owner, release: () => { inventories.get(resolve(root))?.reservations.delete(owner); } };
}

export class DiagnosticLog {
  private stopped = false;
  constructor(readonly root: string, readonly file: string, private readonly options: DiagnosticOptions = {}) {}
  append(line: string): boolean {
    if (this.stopped) return false;
    try {
      checkDiagnosticWrite(this.root, this.file, Buffer.byteLength(line), this.options);
      const fd = openSync(this.file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { appendFileSync(fd, line); } finally { closeSync(fd); }
      accountDiagnosticWrite(this.root, this.file, Buffer.byteLength(line));
      return true;
    } catch (error) {
      this.stopped = true;
      (this.options.warn ?? console.warn)(`[storage] Diagnostic log stopped: ${error instanceof StorageBudgetError ? error.message : 'write unavailable; manually archive diagnostics and check disk access.'}`);
      return false;
    }
  }
}
