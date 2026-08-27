#!/usr/bin/env node

import { bootstrapSidecar } from "./bootstrap.js";

void bootstrapSidecar(() => import("./runtime.js")).catch((error) => {
  console.error(error);
  process.exit(1);
});
