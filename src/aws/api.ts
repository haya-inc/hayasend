import { handle } from "hono/aws-lambda";
import { createApp } from "../app.js";
import { createAwsRuntime } from "../runtime.js";

const app = createApp(createAwsRuntime());

export const handler = handle(app);
