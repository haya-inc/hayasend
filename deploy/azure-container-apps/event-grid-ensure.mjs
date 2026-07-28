#!/usr/bin/env node

import { ensureFromEnvironment } from "./event-grid.mjs";

await ensureFromEnvironment();
