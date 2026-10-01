import { AmbiguousTargetError, TargetNotFoundError } from './errors.js';

export interface ReplacementResult {
  newContent: string;
  diffPreview: string;
  matchedLine: number;
}

export function generateDiffPreview(
  filePath: string,
  originalContent: string,
  targetContent: string,
  replacementContent: string
): ReplacementResult {
  // Normalize CRLF to LF for consistent match testing
  const normalizedOriginal = originalContent.replace(/\r\n/g, '\n');
  const normalizedTarget = targetContent.replace(/\r\n/g, '\n');
  const normalizedReplacement = replacementContent.replace(/\r\n/g, '\n');

  const firstIndex = normalizedOriginal.indexOf(normalizedTarget);
  if (firstIndex === -1) {
    throw new TargetNotFoundError(
      `Could not locate targetContent in '${filePath}'. Make sure whitespace and line numbers match exactly.`
    );
  }

  const secondIndex = normalizedOriginal.indexOf(normalizedTarget, firstIndex + normalizedTarget.length);
  if (secondIndex !== -1) {
    throw new AmbiguousTargetError(
      `Target content in '${filePath}' occurs multiple times. Please include more surrounding context lines to make it uniquely identifiable.`
    );
  }

  // Calculate starting line number
  const prefix = normalizedOriginal.slice(0, firstIndex);
  const startLineNumber = prefix.split('\n').length;

  const targetLines = normalizedTarget.split('\n');
  const replacementLines = normalizedReplacement.split('\n');

  // Build unified diff format
  const diffLines: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${startLineNumber},${targetLines.length} +${startLineNumber},${replacementLines.length} @@`,
  ];

  for (const line of targetLines) {
    diffLines.push(`-${line}`);
  }
  for (const line of replacementLines) {
    diffLines.push(`+${line}`);
  }

  // Replace strictly using original line endings if present
  let newContent: string;
  if (originalContent.includes('\r\n')) {
    const crlfReplacement = normalizedReplacement.replace(/\n/g, '\r\n');
    const crlfTarget = originalContent.includes('\r\n') ? targetContent.replace(/\r?\n/g, '\r\n') : targetContent;
    newContent = originalContent.replace(crlfTarget, crlfReplacement);
  } else {
    newContent = normalizedOriginal.replace(normalizedTarget, normalizedReplacement);
  }

  return {
    newContent,
    diffPreview: diffLines.join('\n'),
    matchedLine: startLineNumber,
  };
}
