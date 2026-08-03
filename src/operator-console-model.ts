export const OPERATOR_CONSOLE_NAVIGATION = [
  ["overview", "⌁", "Overview"],
  ["emails", "↗", "Emails"],
  ["received", "↙", "Received"],
  ["templates", "◇", "Templates"],
  ["domains", "◎", "Domains"],
  ["webhooks", "⌘", "Webhooks"],
  ["suppressions", "⊘", "Suppressions"],
  ["api-keys", "⌁", "API keys"],
] as const;

export type OperatorConsoleView =
  | (typeof OPERATOR_CONSOLE_NAVIGATION)[number][0]
  | "operations";
