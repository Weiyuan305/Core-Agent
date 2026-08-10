#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { runBuildCli } from "./build-hermes-source-image.mjs";

export {
  buildProductImageArgs,
  buildSourceImageArgs,
  deriveSourceImageTag,
  runBuild,
} from "./build-hermes-source-image.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBuildCli();
}
