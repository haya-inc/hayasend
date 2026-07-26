export const REDOCLY_CLI_VERSION: string;
export const REDOC_VERSION: string;
export const REDOC_BUNDLE_URL: string;
export const REDOC_BUNDLE_SHA256: string;
export const SITE_OUTPUT_DIRECTORY: string;

export function hardenApiReference(
  generatedHtml: string,
  redocBundle: Uint8Array | string,
  expectedBundleSha256?: string,
): string;

export function markupWithoutScripts(html: string): string;

export function buildSite(): Promise<string>;
