#!/usr/bin/env -S npx tsx

import { main } from "../../../packages/elo-engine/src/cli.ts";

process.exitCode = main();
