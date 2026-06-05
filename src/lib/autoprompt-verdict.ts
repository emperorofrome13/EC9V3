export type AutoPromptVerdict = 'PASS' | 'FAIL' | 'FIXED' | '';

function parseVerdictLine(line: string, allowBareMarker: boolean): AutoPromptVerdict {
  const trimmed = line.trim();
  if (!trimmed) return '';

  const labeled = /^(?:#{1,6}\s*)?(?:\[[^\]\r\n]{1,80}\]\s*)?(?:final\s+)?(?:verdict|result|status)\s*[:\-\u2013\u2014]\s*\*{0,2}(PASS|FAIL|FIXED)\*{0,2}\b/i.exec(trimmed);
  if (labeled?.[1]) return labeled[1].toUpperCase() as AutoPromptVerdict;

  if (!allowBareMarker) return '';

  const bare = /^(?:[^A-Za-z0-9\r\n]{0,16}\s*)?\*{0,2}(PASS|FAIL|FIXED)\*{0,2}\s*(?:[:\-\u2013\u2014]|\b|$)/i.exec(trimmed);
  if (bare?.[1]) return bare[1].toUpperCase() as AutoPromptVerdict;

  return '';
}

function findLastLineIndex(lines: string[], predicate: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (predicate(lines[index])) return index;
  }
  return -1;
}

function isFinalVerdictMarker(line: string): boolean {
  return /\bfinal\s+verdict\b/i.test(line);
}

function isOutputFormatMarker(line: string): boolean {
  return /^\s*#{0,6}\s*output\s+format\b/i.test(line);
}

export function extractAutoPromptVerdictFromLines(content: string): AutoPromptVerdict {
  const lines = content.split(/\r?\n/);

  const finalVerdictIndex = findLastLineIndex(lines, isFinalVerdictMarker);
  if (finalVerdictIndex >= 0) {
    for (const line of lines.slice(finalVerdictIndex, finalVerdictIndex + 10)) {
      const verdict = parseVerdictLine(line, true);
      if (verdict) return verdict;
    }
  }

  for (let index = lines.length - 1; index >= 0; index--) {
    const verdict = parseVerdictLine(lines[index], false);
    if (verdict) return verdict;
  }

  const outputFormatIndex = lines.findIndex(isOutputFormatMarker);
  const candidateLines = outputFormatIndex >= 0 ? lines.slice(0, outputFormatIndex) : lines;

  for (let index = candidateLines.length - 1; index >= 0; index--) {
    const verdict = parseVerdictLine(candidateLines[index], true);
    if (verdict) return verdict;
  }

  return '';
}

export function getAutoPromptVerdictEvidenceWindow(content: string): string {
  const lines = content.split(/\r?\n/);
  const finalVerdictIndex = findLastLineIndex(lines, isFinalVerdictMarker);
  if (finalVerdictIndex >= 0) {
    return lines.slice(finalVerdictIndex).join('\n');
  }

  const labeledLineIndex = findLastLineIndex(lines, (line) => Boolean(parseVerdictLine(line, false)));
  if (labeledLineIndex >= 0) {
    return lines.slice(labeledLineIndex).join('\n');
  }

  return content;
}
