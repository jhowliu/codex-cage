#!/usr/bin/env node
import { createCli } from "./commands.js";

const program = createCli();

await program.parseAsync(process.argv);
