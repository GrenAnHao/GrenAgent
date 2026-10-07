#!/usr/bin/env node

import { bootstrapSidecar } from "./bootstrap.js";
import { installCursorProvider } from "./cursor/install.js";

installCursorProvider();

void bootstrapSidecar(() => import("./runtime.js")).catch((error) => {
  console.error(error);
  process.exit(1);
});
