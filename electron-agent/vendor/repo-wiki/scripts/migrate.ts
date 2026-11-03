import { migrateWorkspace } from "../packages/core/src/migration.js";
import { WorkspaceError } from "../packages/core/src/engine.js";

const args = process.argv.slice(2);
const help =
  "Usage: node dist/scripts/migrate.js --from OLD_DATA_DIRECTORY --to NEW_DATA_DIRECTORY\nStop the old service first. Originals are never opened by SQLite. Destination must not exist.";
if (args.includes("--help") || args.includes("-h")) console.log(help);
else {
  try {
    if (args.length !== 4 || !args.includes("--from") || !args.includes("--to"))
      throw new WorkspaceError(help);
    const fromIndex = args.indexOf("--from"),
      toIndex = args.indexOf("--to");
    if (
      ![0, 2].includes(fromIndex) ||
      ![0, 2].includes(toIndex) ||
      fromIndex === toIndex ||
      args[fromIndex + 1].startsWith("--") ||
      args[toIndex + 1].startsWith("--")
    )
      throw new WorkspaceError(help);
    console.log(
      JSON.stringify(
        migrateWorkspace(args[fromIndex + 1], args[toIndex + 1]),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      error instanceof WorkspaceError
        ? error.message
        : "Migration failed; no original data was modified.",
    );
    process.exitCode = 1;
  }
}
