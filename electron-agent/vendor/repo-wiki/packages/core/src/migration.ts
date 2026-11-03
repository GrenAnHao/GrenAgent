/**
 * Explicit offline, copy-first migration. Source files are opened with read-only
 * descriptors, NEVER SQLite: even a readOnly SQLite WAL reader updates -shm.
 * The old service must be stopped/quiescent. Changed source bytes abort the copy.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { WorkspaceError, validate_plan } from "./engine.js";

const DATABASE = "workspace.sqlite3";
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const EXPECTED_COLUMNS: Record<string, string[]> = {
  projects: ["id", "data"],
  revisions: ["id"],
  snapshots: ["project_id", "namespace", "data"],
  pages: ["project_id", "namespace", "slug", "data"],
  generation_cache: ["fingerprint", "data"],
};
type CapturedFile = {
  name: string;
  filename: string;
  fd: number;
  stat: fs.BigIntStats;
  hash: string;
};
export interface MigrationResult {
  version: 1;
  source_directory: string;
  destination_directory: string;
  database: string;
  projects: number;
  pages: number;
  snapshots: number;
  generation_cache_cleared: number;
  watches_paused: number;
  source_hashes: Record<string, string>;
  completed_at: string;
  source_mode: "read-only-files-quiescent-snapshot";
}
const exists = (filename: string) => {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
function noSymlinkComponents(filename: string): void {
  const resolved = path.resolve(filename),
    root = path.parse(resolved).root;
  let cursor = root;
  for (const part of resolved
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!exists(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink())
      throw new WorkspaceError(
        "Migration paths and database files must not contain symbolic links",
      );
  }
}
function metadataEqual(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    (key) => a[key as keyof fs.BigIntStats] === b[key as keyof fs.BigIntStats],
  );
}
function digestFile(
  fd: number,
  expectedBytes: number,
  destination?: number,
): string {
  const digest = createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024);
  let offset = 0;
  while (offset < expectedBytes) {
    const length = fs.readSync(
      fd,
      buffer,
      0,
      Math.min(buffer.length, expectedBytes - offset),
      offset,
    );
    if (!length)
      throw new WorkspaceError(
        "Source database changed while copying; stop the old service and retry",
        409,
      );
    digest.update(buffer.subarray(0, length));
    if (destination !== undefined) {
      let written = 0;
      while (written < length)
        written += fs.writeSync(
          destination,
          buffer,
          written,
          length - written,
          offset + written,
        );
    }
    offset += length;
  }
  if (fs.readSync(fd, buffer, 0, 1, offset))
    throw new WorkspaceError(
      "Source database changed while copying; stop the old service and retry",
      409,
    );
  return digest.digest("hex");
}
function regularSource(filename: string): fs.BigIntStats {
  noSymlinkComponents(filename);
  const stat = fs.lstatSync(filename, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new WorkspaceError(
      "Migration input must contain regular database files",
    );
  return stat;
}
function validateSchema(database: DatabaseSync): void {
  database.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;");
  const tables = database
    .prepare(
      "SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    )
    .all();
  if (
    tables.length !== Object.keys(EXPECTED_COLUMNS).length ||
    tables.some(
      (table) =>
        table.type !== "table" ||
        !Object.hasOwn(EXPECTED_COLUMNS, String(table.name)),
    )
  )
    throw new WorkspaceError(
      "Unrecognized workspace SQLite schema; no migration was installed",
    );
  for (const [name, columns] of Object.entries(EXPECTED_COLUMNS)) {
    const actual = database.prepare(`PRAGMA table_info(${name})`).all();
    if (
      JSON.stringify(actual.map((column) => column.name)) !==
      JSON.stringify(columns)
    )
      throw new WorkspaceError(
        "Unrecognized workspace SQLite columns; no migration was installed",
      );
    if (
      actual.some(
        (column) =>
          String(column.type).toUpperCase() !==
          (name === "revisions" ? "INTEGER" : "TEXT"),
      )
    )
      throw new WorkspaceError(
        "Unrecognized workspace SQLite column types; no migration was installed",
      );
  }
  if (
    !String(tables.find((table) => table.name === "revisions")?.sql)
      .toUpperCase()
      .includes("AUTOINCREMENT")
  )
    throw new WorkspaceError("Workspace revision sequence is not recognized");
  const check = database.prepare("PRAGMA integrity_check").all();
  if (check.length !== 1 || Object.values(check[0])[0] !== "ok")
    throw new WorkspaceError(
      "Workspace database failed SQLite integrity verification",
    );
  const projects = new Set<string>();
  for (const row of database.prepare("SELECT id,data FROM projects").all()) {
    let value: any;
    try {
      value = JSON.parse(String(row.data));
    } catch {
      throw new WorkspaceError("Workspace contains invalid project JSON");
    }
    if (
      !value ||
      typeof value !== "object" ||
      value.id !== row.id ||
      typeof value.path !== "string" ||
      typeof value.language !== "string"
    )
      throw new WorkspaceError(
        "Workspace contains an unrecognized project record",
      );
    validate_plan(value.plan);
    projects.add(String(row.id));
  }
  const maxRevision = Number(
    database
      .prepare("SELECT COALESCE(MAX(id),0) AS revision FROM revisions")
      .get()!.revision,
  );
  for (const row of database
    .prepare("SELECT project_id,namespace,slug,data FROM pages")
    .all()) {
    let value: any;
    try {
      value = JSON.parse(String(row.data));
    } catch {
      throw new WorkspaceError("Workspace contains invalid page JSON");
    }
    if (
      !projects.has(String(row.project_id)) ||
      typeof row.namespace !== "string" ||
      !/^[a-f0-9]{24}$/.test(row.namespace) ||
      !value ||
      value.id !== row.slug ||
      typeof value.markdown !== "string" ||
      typeof value.baseline !== "string" ||
      !["ready", "edited", "conflict", "archived"].includes(value.status) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision <= 0 ||
      value.revision > maxRevision ||
      (value.pending_markdown != null &&
        typeof value.pending_markdown !== "string")
    )
      throw new WorkspaceError(
        "Workspace contains an unrecognized page/revision record",
      );
  }
  for (const row of database
    .prepare("SELECT project_id,namespace,data FROM snapshots")
    .all()) {
    let value: any;
    try {
      value = JSON.parse(String(row.data));
    } catch {
      throw new WorkspaceError("Workspace contains invalid snapshot JSON");
    }
    if (
      !projects.has(String(row.project_id)) ||
      typeof row.namespace !== "string" ||
      !/^[a-f0-9]{24}$/.test(row.namespace) ||
      !value ||
      typeof value.hashes !== "object" ||
      !Array.isArray(value.edges)
    )
      throw new WorkspaceError(
        "Workspace contains an unrecognized source snapshot",
      );
  }
}

/**
 * Creates a NEW destination directory, refuses overwrite, and changes only the
 * copied generation cache and watch flags. No repo or source database writes.
 * This is an offline/quiescent snapshot, not a supported hot-backup mechanism.
 */
export function migrateWorkspace(from: string, to: string): MigrationResult {
  if (!from || !to)
    throw new WorkspaceError(
      "Both source and destination directories are required",
    );
  const source = path.resolve(from),
    destination = path.resolve(to),
    parent = path.dirname(destination);
  noSymlinkComponents(source);
  noSymlinkComponents(destination);
  if (!exists(source) || !fs.statSync(source).isDirectory())
    throw new WorkspaceError(
      "Source must be an existing workspace data directory",
      404,
    );
  if (source === destination || exists(destination))
    throw new WorkspaceError(
      "Destination must be a new, non-existing directory; migration never overwrites data",
      409,
    );
  if (!exists(parent) || !fs.statSync(parent).isDirectory())
    throw new WorkspaceError("Destination parent directory must already exist");
  const relative = path.relative(source, destination);
  if (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  )
    throw new WorkspaceError(
      "Destination must not be inside the original workspace directory",
    );
  const databaseFile = path.join(source, DATABASE);
  if (!exists(databaseFile))
    throw new WorkspaceError(
      "Source directory does not contain workspace.sqlite3",
      404,
    );
  if (exists(databaseFile + "-journal"))
    throw new WorkspaceError(
      "A rollback journal exists; stop and cleanly close the old application before migration",
      409,
    );
  const names = [DATABASE, DATABASE + "-wal", DATABASE + "-shm"].filter(
    (name) => exists(path.join(source, name)),
  );
  const records: CapturedFile[] = [];
  let staging: string | undefined,
    installed = false,
    reservedStat: fs.BigIntStats | undefined,
    copy: DatabaseSync | undefined;
  try {
    let totalBytes = 0;
    for (const name of names) {
      const filename = path.join(source, name),
        stat = regularSource(filename);
      totalBytes += Number(stat.size);
      if (totalBytes > MAX_SOURCE_BYTES)
        throw new WorkspaceError(
          "Migration input exceeds the 512 MiB safety limit; use an operator-managed SQLite backup",
        );
      const fd = fs.openSync(
        filename,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!metadataEqual(stat, opened)) {
        fs.closeSync(fd);
        throw new WorkspaceError(
          "Source files changed while opening; stop the old service and retry",
          409,
        );
      }
      records.push({ name, filename, fd, stat, hash: "" });
    }
    staging = fs.mkdtempSync(path.join(parent, ".repowiki-migration-"));
    const stagedDatabase = path.join(staging, DATABASE);
    for (const record of records) {
      // SHM is transient coordination state: hash for quiescence, never copy it.
      let output: number | undefined;
      try {
        if (!record.name.endsWith("-shm"))
          output = fs.openSync(path.join(staging, record.name), "wx", 0o600);
        record.hash = digestFile(record.fd, Number(record.stat.size), output);
        if (output !== undefined) fs.fsyncSync(output);
      } finally {
        if (output !== undefined) fs.closeSync(output);
      }
    }
    const verifyUnchanged = () => {
      const currentNames = [
        DATABASE,
        DATABASE + "-wal",
        DATABASE + "-shm",
      ].filter((name) => exists(path.join(source, name)));
      if (
        JSON.stringify(currentNames) !== JSON.stringify(names) ||
        exists(databaseFile + "-journal")
      )
        throw new WorkspaceError(
          "Source database files changed; stop the old service and retry",
          409,
        );
      for (const record of records)
        if (
          !metadataEqual(record.stat, regularSource(record.filename)) ||
          !metadataEqual(
            record.stat,
            fs.fstatSync(record.fd, { bigint: true }),
          ) ||
          record.hash !== digestFile(record.fd, Number(record.stat.size))
        )
          throw new WorkspaceError(
            "Source database changed during migration; no migration was installed",
            409,
          );
    };
    verifyUnchanged();
    // All SQLite reads, WAL recovery, checkpoints and writes affect staging ONLY.
    copy = new DatabaseSync(stagedDatabase);
    validateSchema(copy);
    const count = (table: string) =>
      Number(
        copy!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count,
      );
    const result: MigrationResult = {
      version: 1,
      source_directory: source,
      destination_directory: destination,
      database: DATABASE,
      projects: count("projects"),
      pages: count("pages"),
      snapshots: count("snapshots"),
      generation_cache_cleared: count("generation_cache"),
      watches_paused: 0,
      source_hashes: Object.fromEntries(
        records.map((record) => [record.name, record.hash]),
      ),
      completed_at: new Date().toISOString(),
      source_mode: "read-only-files-quiescent-snapshot",
    };
    copy.exec("BEGIN IMMEDIATE");
    try {
      copy.exec("DELETE FROM generation_cache");
      const update = copy.prepare("UPDATE projects SET data=? WHERE id=?");
      for (const row of copy.prepare("SELECT id,data FROM projects").all()) {
        const value = JSON.parse(String(row.data));
        if (value.watch) {
          value.watch = false;
          result.watches_paused++;
          update.run(JSON.stringify(value), String(row.id));
        }
      }
      copy.exec("COMMIT");
    } catch (error) {
      copy.exec("ROLLBACK");
      throw error;
    }
    copy.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
    validateSchema(copy);
    copy.close();
    copy = undefined;
    verifyUnchanged();
    // mkdir is exclusive: a racing destination creator is never overwritten.
    fs.mkdirSync(destination, { mode: 0o700 });
    reservedStat = fs.lstatSync(destination, { bigint: true });
    fs.writeFileSync(
      path.join(destination, "migration.json"),
      JSON.stringify(result, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    // Same-parent staging guarantees the same filesystem. Hard-link publication
    // exposes the completely validated database atomically, never a partial copy.
    fs.linkSync(stagedDatabase, path.join(destination, DATABASE));
    installed = true;
    return result;
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(
      "Migration failed; original data was not opened for writes. Check paths, permissions, schema, and that the old service is stopped.",
    );
  } finally {
    try {
      copy?.close();
    } catch {
      /* Preserve the original error. */
    }
    for (const record of records) fs.closeSync(record.fd);
    if (!installed && reservedStat && exists(destination)) {
      const current = fs.lstatSync(destination, { bigint: true });
      if (
        current.dev === reservedStat.dev &&
        current.ino === reservedStat.ino &&
        current.isDirectory() &&
        !current.isSymbolicLink()
      )
        fs.rmSync(destination, { recursive: true, force: true });
    }
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}
