#!/usr/bin/env node
import { createCli } from "./commands.js";
import { suppressSqliteExperimentalWarning } from "./node-warnings.js";

suppressSqliteExperimentalWarning();

const program = createCli();

await program.parseAsync(process.argv);
