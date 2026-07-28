#!/usr/bin/env node

import { deleteFromEnvironment } from "./event-grid.mjs";

await deleteFromEnvironment();
