import { convert } from "html-to-text";

export function plainTextFromHtml(
  html: string,
  maximumInputLength: number,
): string {
  return convert(html, {
    wordwrap: false,
    limits: {
      ellipsis: "…",
      maxBaseElements: 1,
      maxChildNodes: 50_000,
      maxDepth: 100,
      maxInputLength: maximumInputLength,
    },
  });
}
