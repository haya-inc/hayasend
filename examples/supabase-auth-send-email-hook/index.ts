import { createSupabaseAuthEmailHandler } from "./handler.ts";

function requiredEnvironment(name: string) {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

const handler = createSupabaseAuthEmailHandler({
  hayasendBaseUrl: requiredEnvironment("HAYASEND_BASE_URL"),
  hayasendApiKey: requiredEnvironment("HAYASEND_API_KEY"),
  hayasendFrom: requiredEnvironment("HAYASEND_FROM"),
  emailBrand: requiredEnvironment("HAYASEND_EMAIL_BRAND"),
  supabaseUrl: requiredEnvironment("SUPABASE_URL"),
  sendEmailHookSecret: requiredEnvironment("SEND_EMAIL_HOOK_SECRET"),
});

Deno.serve(handler);
