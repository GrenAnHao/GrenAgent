// Local declaration builds can leave ignored .js siblings next to .ts sources.
// Test the working tree without deleting or replacing those files.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export default {
  plugins: [{
    name: "pi-workspace-typescript-source-first",
    enforce: "pre",
    resolveId(id, importer) {
      if (!importer || importer.includes("/node_modules/") || !id.startsWith(".")) return;
      const base = resolve(dirname(importer), id.endsWith(".js") ? id.slice(0, -3) : id);
      for (const ext of [".ts", ".tsx"]) {
        if (existsSync(base + ext)) return (base + ext).replaceAll("\\", "/");
      }
    },
  }],
};
