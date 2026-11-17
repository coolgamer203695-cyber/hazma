#!/usr/bin/env node
// HAZMA command line entry point.
import { runCli } from "../dist/src/cli.js";

runCli(process.argv.slice(2));
