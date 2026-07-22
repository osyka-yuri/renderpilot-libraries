#!/usr/bin/env node

import { createR2Client } from "./lib/r2-client.mjs";
import {
  parsePublicationArgs,
  printPublicationHelp,
  publishCatalog,
} from "./lib/r2-publication.mjs";
import { runCliMain } from "./lib/cli-main.mjs";

runCliMain({
  parse: parsePublicationArgs,
  help: printPublicationHelp,
  main: (options) =>
    publishCatalog(options.dryRun ? null : createR2Client(process.env), options),
});
