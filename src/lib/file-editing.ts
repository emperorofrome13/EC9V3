import path from 'path';

export type EditToolArgs = Record<string, unknown>;

export type EditApplyResult =
  | { success: true; content: string; summary: string }
  | { success: false; error: string };

export type EditLoopState = Map<string, { failedAttempts: number; locked: boolean }>;

export function normalizeProjectPath(workingDir: string, fullPath: string): string {
  return path.relative(path.resolve(workingDir), path.resolve(fullPath)).replace(/\\/g, '/');
}

export function markFileRead(readFiles: Set<string> | undefined, workingDir: string, fullPath: string): void {
  readFiles?.add(normalizeProjectPath(workingDir, fullPath));
}

export function hasReadFile(readFiles: Set<string> | undefined, workingDir: string, fullPath: string): boolean {
  if (!readFiles) return true;
  return readFiles.has(normalizeProjectPath(workingDir, fullPath));
}

export function readBeforeEditError(filePath: string): string {
  return `Read this file first with read_file, then retry the edit: ${filePath}`;
}

export function formatNumberedFileContent(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`).join('\n');
}

export function formatReadFileContent(content: string, args: EditToolArgs): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const requestedStart = parsePositiveInteger(args.start_line);
  const requestedEnd = parsePositiveInteger(args.end_line);
  const startLine = requestedStart ? Math.min(requestedStart, lines.length) : 1;
  const endLine = requestedEnd ? Math.min(Math.max(requestedEnd, startLine), lines.length) : lines.length;
  const selectedLines = lines.slice(startLine - 1, endLine);
  if (!isNumberedReadRequested(args)) {
    return selectedLines.join('\n');
  }
  const width = String(endLine).length;
  return selectedLines
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`)
    .join('\n');
}

export function isNumberedReadRequested(args: EditToolArgs): boolean {
  return args.numbered === true || args.line_numbers === true || args.with_line_numbers === true;
}

export function resetEditLoopForPath(editState: EditLoopState | undefined, workingDir: string, fullPath: string): void {
  editState?.delete(normalizeProjectPath(workingDir, fullPath));
}

export function recordEditLoopOutcome(
  editState: EditLoopState | undefined,
  workingDir: string,
  fullPath: string,
  success: boolean,
): string | undefined {
  if (!editState) return undefined;
  const key = normalizeProjectPath(workingDir, fullPath);
  if (success) {
    editState.delete(key);
    return undefined;
  }

  const current = editState.get(key) || { failedAttempts: 0, locked: false };
  current.failedAttempts += 1;
  if (current.failedAttempts >= 2) current.locked = true;
  editState.set(key, current);

  if (!current.locked) return undefined;
  return [
    `Edit recovery needed for ${key}.`,
    `Read this file again with read_file using {"path":"${key}","numbered":true}, then use edit_file with replace_range/start_line/end_line/new_text.`,
    'Do not delete, recreate, or shell-overwrite this file to recover from a failed edit.',
  ].join(' ');
}

export function lockEditLoopForPath(
  editState: EditLoopState | undefined,
  workingDir: string,
  fullPath: string,
): string | undefined {
  if (!editState) return undefined;
  const key = normalizeProjectPath(workingDir, fullPath);
  editState.set(key, { failedAttempts: 2, locked: true });
  return [
    `Edit recovery needed for ${key}.`,
    `Read this file again with read_file using {"path":"${key}","numbered":true}, then use edit_file with replace_range/start_line/end_line/new_text.`,
    'Do not delete, recreate, or shell-overwrite this file to recover from a failed edit.',
  ].join(' ');
}

export function isEditLoopLocked(editState: EditLoopState | undefined, workingDir: string, fullPath: string): boolean {
  if (!editState) return false;
  const state = editState.get(normalizeProjectPath(workingDir, fullPath));
  return Boolean(state?.locked);
}

export function editLoopRewriteBlockedError(workingDir: string, fullPath: string): string {
  const key = normalizeProjectPath(workingDir, fullPath);
  return [
    `Rewrite blocked during edit recovery for ${key}.`,
    `Read it with read_file {"path":"${key}","numbered":true}, then use edit_file replace_range or a smaller targeted edit.`,
  ].join(' ');
}

export function shellCommandWouldRewriteLockedFile(
  command: string,
  workingDir: string,
  editState: EditLoopState | undefined,
): string | undefined {
  if (!editState || editState.size === 0) return undefined;
  const writeLikeCommand = /(^|[\s;&|])(?:set-content|add-content|out-file|new-item|remove-item|del|erase|rm)\b/i.test(command) ||
    /(^|[^>])>\s*["']?[^"'\s]+/i.test(command) ||
    /\|\s*(?:set-content|add-content|out-file)\b/i.test(command);
  if (!writeLikeCommand) return undefined;

  const normalizedCommand = command.replace(/\\/g, '/').toLowerCase();
  for (const [relativePath, state] of editState.entries()) {
    if (!state.locked) continue;
    const normalizedRelative = relativePath.toLowerCase();
    const normalizedAbsolute = path.resolve(workingDir, relativePath).replace(/\\/g, '/').toLowerCase();
    if (normalizedCommand.includes(normalizedRelative) || normalizedCommand.includes(normalizedAbsolute)) {
      return editLoopRewriteBlockedError(workingDir, path.resolve(workingDir, relativePath));
    }
  }
  return undefined;
}

export function shellCommandWouldDeleteTrackedSourceFile(
  command: string,
  workingDir: string,
  trackedPaths: Iterable<string> | undefined,
): string | undefined {
  if (!trackedPaths) return undefined;
  const deleteLikeCommand = /(^|[\s;&|])(?:remove-item|del|erase|rm)\b/i.test(command);
  if (!deleteLikeCommand) return undefined;

  const normalizedCommand = command.replace(/\\/g, '/').toLowerCase();
  for (const trackedPath of trackedPaths) {
    if (!trackedPath || !isSourceLikeFilePath(trackedPath)) continue;
    const normalizedRelative = trackedPath.replace(/\\/g, '/').toLowerCase();
    const normalizedAbsolute = path.resolve(workingDir, trackedPath).replace(/\\/g, '/').toLowerCase();
    const fileName = path.basename(trackedPath).toLowerCase();
    if (
      normalizedCommand.includes(normalizedRelative) ||
      normalizedCommand.includes(normalizedAbsolute) ||
      normalizedCommand.includes(fileName)
    ) {
      return [
        `Shell delete blocked for source-like file ${trackedPath}.`,
        'Use read_file plus edit_file or multi_edit for targeted corrections instead of deleting/recreating source files.',
      ].join(' ');
    }
  }
  return undefined;
}

export function shellCommandLooksLikeWholeFileRewrite(command: string): boolean {
  const sourcePath = /(?:^|\s|["'])(?:\.\/)?[\w./\\ -]+\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|html|json|md|py|rs|go|java|cs|cpp|c|h|hpp|yml|yaml)(?:["']|\s|$)/i;
  const writesWithRedirection = /(?:^|[\s;&|])(?:cat|echo|printf|type)\b[\s\S]*>\s*["']?[^"'\s]+/i.test(command);
  const powershellWholeFileWrite = /\b(?:set-content|out-file)\b/i.test(command) || /\bnew-item\b[\s\S]*\b-value\b/i.test(command);
  const heredocWrite = /<<\s*['"]?[A-Z0-9_]+['"]?/i.test(command);
  return sourcePath.test(command) && (writesWithRedirection || powershellWholeFileWrite || heredocWrite);
}

export function isSourceLikeFilePath(filePath: string): boolean {
  return /(?:^|[./\\])[^/\\]+\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|html|json|md|py|rs|go|java|cs|cpp|c|h|hpp|yml|yaml)(?:$|[._-])/i.test(filePath);
}

export function sourceSyntaxExtension(filePath: string): string | undefined {
  const match = filePath.match(/\.(js|mjs|cjs)(?:$|[._-])/i);
  return match ? `.${match[1].toLowerCase()}` : undefined;
}

type MatchResult =
  | { success: true; start: number; end: number; count: number; strategy: string }
  | { success: false; error: string };

function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(needle, index);
    if (found === -1) break;
    count++;
    index = found + Math.max(needle.length, 1);
  }
  return count;
}

function normalizeLineEndingsWithMap(value: string): { text: string; map: number[] } {
  const parts: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\r' && value[i + 1] === '\n') {
      parts.push('\n');
      map.push(i);
      i++;
    } else {
      parts.push(value[i]);
      map.push(i);
    }
  }
  return { text: parts.join(''), map };
}

function normalizeEscapedNewlinesWithMap(value: string): { text: string; map: number[] } {
  const parts: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && value[i + 1] === 'n') {
      parts.push('\n');
      map.push(i);
      i++;
    } else if (value[i] === '\r' && value[i + 1] === '\n') {
      parts.push('\n');
      map.push(i);
      i++;
    } else {
      parts.push(value[i]);
      map.push(i);
    }
  }
  return { text: parts.join(''), map };
}

function lineOffsets(content: string): Array<{ text: string; start: number; end: number }> {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content[i] === '\n') {
      const raw = content.slice(start, i);
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      lines.push({ text, start, end: i });
      start = i + 1;
    }
  }
  return lines;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

function applyReplaceRange(content: string, args: EditToolArgs): EditApplyResult {
  const startLine = parsePositiveInteger(args.start_line);
  const endLine = parsePositiveInteger(args.end_line);
  if (!startLine || !endLine || endLine < startLine) {
    return { success: false, error: 'replace_range requires positive start_line and end_line with end_line >= start_line.' };
  }
  if (args.new_text === undefined || args.new_text === null) {
    return { success: false, error: "replace_range requires 'new_text'." };
  }

  const lines = lineOffsets(content);
  if (startLine > lines.length || endLine > lines.length) {
    return { success: false, error: `replace_range line bounds exceed file length (${lines.length} lines).` };
  }

  const start = lines[startLine - 1].start;
  const selectedEnd = lines[endLine - 1].end;
  const selectedText = content.slice(start, selectedEnd);
  let oldTextMismatch = false;
  if (typeof args.old_text === 'string' && args.old_text.trim().length > 0) {
    const expected = args.old_text.replace(/\r\n/g, '\n').trimEnd();
    const selected = selectedText.replace(/\r\n/g, '\n').trimEnd();
    if (expected !== selected) {
      oldTextMismatch = true;
    }
  }
  let end = selectedEnd;
  let replacement = String(args.new_text);
  if (end < content.length && content[end] === '\n') {
    end += 1;
    if (replacement.length > 0 && !replacement.endsWith('\n')) replacement += '\n';
  }
  return {
    success: true,
    content: replaceAt(content, start, end, replacement),
    summary: `replaced line range ${startLine}-${endLine}${oldTextMismatch ? ' (old_text mismatch ignored because explicit line range was provided)' : ''}`,
  };
}

function applyInsertAtLine(content: string, args: EditToolArgs): EditApplyResult {
  const insertLine = parsePositiveInteger(args.insert_at_line);
  if (!insertLine) {
    return { success: false, error: 'insert_at_line requires a positive 1-based line number.' };
  }
  if (args.new_text === undefined || args.new_text === null) {
    return { success: false, error: "insert_at_line requires 'new_text'." };
  }

  const lines = lineOffsets(content);
  if (insertLine > lines.length + 1) {
    return { success: false, error: `insert_at_line may be at most file length + 1 (${lines.length + 1}).` };
  }
  const index = insertLine === lines.length + 1 ? content.length : lines[insertLine - 1].start;
  let insertion = String(args.new_text);
  if (insertion.length > 0 && !insertion.endsWith('\n')) insertion += '\n';
  return {
    success: true,
    content: replaceAt(content, index, index, insertion),
    summary: `inserted at line ${insertLine}`,
  };
}

function findTrimmedBlock(content: string, needle: string): MatchResult {
  const target = needle.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim());
  if (target.length === 0 || target.every((line) => line.length === 0)) {
    return { success: false, error: 'No unique match found; the search text is empty after trimming.' };
  }

  const lines = lineOffsets(content);
  const matches: Array<{ start: number; end: number }> = [];
  for (let i = 0; i <= lines.length - target.length; i++) {
    let matched = true;
    for (let j = 0; j < target.length; j++) {
      if (lines[i + j].text.trim() !== target[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push({ start: lines[i].start, end: lines[i + target.length - 1].end });
      if (matches.length > 1) break;
    }
  }

  if (matches.length !== 1) {
    return {
      success: false,
      error: matches.length === 0
        ? 'No unique match found. Read the file again and use a smaller exact snippet from the current content.'
        : 'Ambiguous edit: trimmed-line matching found multiple possible locations. Use a more specific snippet.',
    };
  }

  return { success: true, start: matches[0].start, end: matches[0].end, count: 1, strategy: 'trimmed-line block' };
}

function findUniqueMatch(content: string, needle: string, label: string): MatchResult {
  if (!needle) return { success: false, error: `${label} cannot be empty.` };

  const exactCount = countOccurrences(content, needle);
  if (exactCount === 1) {
    const start = content.indexOf(needle);
    return { success: true, start, end: start + needle.length, count: 1, strategy: 'exact' };
  }
  if (exactCount > 1) {
    return { success: false, error: `Ambiguous edit: ${label} appears ${exactCount} times. Use a more specific snippet or replace_all.` };
  }

  const contentNorm = normalizeLineEndingsWithMap(content);
  const needleNorm = needle.replace(/\r\n/g, '\n');
  const normCount = countOccurrences(contentNorm.text, needleNorm);
  if (normCount === 1) {
    const normStart = contentNorm.text.indexOf(needleNorm);
    const normEnd = normStart + needleNorm.length;
    const start = contentNorm.map[normStart];
    const end = normEnd >= contentNorm.map.length ? content.length : contentNorm.map[normEnd];
    return { success: true, start, end, count: 1, strategy: 'line-ending normalized' };
  }
  if (normCount > 1) {
    return { success: false, error: `Ambiguous edit: ${label} has ${normCount} line-ending-normalized matches. Use a more specific snippet.` };
  }

  const escapedNorm = normalizeEscapedNewlinesWithMap(content);
  const escapedNeedle = needle.replace(/\r\n/g, '\n').replace(/\\n/g, '\n');
  const escapedCount = countOccurrences(escapedNorm.text, escapedNeedle);
  if (escapedCount === 1) {
    const normStart = escapedNorm.text.indexOf(escapedNeedle);
    const normEnd = normStart + escapedNeedle.length;
    const start = escapedNorm.map[normStart];
    const end = normEnd >= escapedNorm.map.length ? content.length : escapedNorm.map[normEnd];
    return { success: true, start, end, count: 1, strategy: 'escaped-newline normalized' };
  }
  if (escapedCount > 1) {
    return { success: false, error: `Ambiguous edit: ${label} has ${escapedCount} escaped-newline-normalized matches. Use a more specific snippet or replace_range.` };
  }

  return findTrimmedBlock(content, needle);
}

function replaceAt(content: string, start: number, end: number, replacement: string): string {
  return `${content.slice(0, start)}${replacement}${content.slice(end)}`;
}

function leadingWhitespace(value: string): string {
  return value.match(/^[\t ]*/)?.[0] || '';
}

function leadingIndentMarker(value: string): string {
  return value.match(/^(?:(?:\\t)|[\t ])*/)?.[0] || '';
}

function preserveSingleLineIndentForTrimmedMatch(
  content: string,
  match: Extract<MatchResult, { success: true }>,
  replacement: string,
): string {
  if (replacement.includes('\n') || replacement.includes('\r')) return replacement;
  const matched = content.slice(match.start, match.end);
  if (matched.includes('\n') || matched.includes('\r')) return replacement;
  const existingIndent = leadingWhitespace(matched);
  const replacementIndent = leadingIndentMarker(replacement);
  if (!existingIndent || !replacementIndent) return replacement;
  return `${existingIndent}${replacement.slice(replacementIndent.length)}`;
}

export function applyEditFileArgs(content: string, args: EditToolArgs): EditApplyResult {
  if (args.replace_entire_file === true) {
    if (args.new_text === undefined || args.new_text === null) {
      return { success: false, error: "replace_entire_file requires 'new_text'." };
    }
    return {
      success: true,
      content: String(args.new_text),
      summary: 'replaced entire file content',
    };
  }

  if (args.replace_range === true || args.mode === 'replace_range' || args.start_line !== undefined || args.end_line !== undefined) {
    return applyReplaceRange(content, args);
  }

  if (args.insert_at_line !== undefined || args.mode === 'insert_at_line') {
    return applyInsertAtLine(content, args);
  }

  if (typeof args.append === 'string') {
    return {
      success: true,
      content: `${content}${args.append}`,
      summary: `appended ${Buffer.byteLength(args.append, 'utf-8')} byte(s)`,
    };
  }

  if (typeof args.insert_before === 'string') {
    if (args.new_text === undefined || args.new_text === null) {
      return { success: false, error: "edit_file with insert_before requires 'new_text'." };
    }
    const match = findUniqueMatch(content, args.insert_before, 'insert_before');
    if (!match.success) return match;
    return {
      success: true,
      content: replaceAt(content, match.start, match.start, String(args.new_text)),
      summary: `inserted before one ${match.strategy} match`,
    };
  }

  if (typeof args.insert_after === 'string') {
    if (args.new_text === undefined || args.new_text === null) {
      return { success: false, error: "edit_file with insert_after requires 'new_text'." };
    }
    const match = findUniqueMatch(content, args.insert_after, 'insert_after');
    if (!match.success) return match;
    return {
      success: true,
      content: replaceAt(content, match.end, match.end, String(args.new_text)),
      summary: `inserted after one ${match.strategy} match`,
    };
  }

  if (typeof args.old_text !== 'string' || args.new_text === undefined || args.new_text === null) {
    return {
      success: false,
      error: "edit_file requires either old_text/new_text, insert_before/new_text, insert_after/new_text, or append.",
    };
  }

  const oldText = args.old_text;
  const newText = String(args.new_text);
  if (args.replace_all === true) {
    const exactCount = countOccurrences(content, oldText);
    if (exactCount === 0) {
      return { success: false, error: 'replace_all requires an exact old_text match. Read the file again and retry with current text.' };
    }
    return {
      success: true,
      content: content.split(oldText).join(newText),
      summary: `replaced ${exactCount} exact occurrence(s)`,
    };
  }

  const match = findUniqueMatch(content, oldText, 'old_text');
  if (!match.success) return match;
  const replacement = preserveSingleLineIndentForTrimmedMatch(content, match, newText);
  return {
    success: true,
    content: replaceAt(content, match.start, match.end, replacement),
    summary: `replaced one ${match.strategy} match`,
  };
}

export function applyMultiEditArgs(content: string, edits: Array<Record<string, unknown>>): EditApplyResult {
  let next = content;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (typeof edit.old_string !== 'string' || edit.new_string === undefined || edit.new_string === null) {
      return { success: false, error: `multi_edit edit #${i + 1} requires old_string and new_string.` };
    }
    if (edit.replace_all === true) {
      const result = applyEditFileArgs(next, {
        old_text: edit.old_string,
        new_text: edit.new_string,
        replace_all: true,
      });
      if (!result.success) {
        return { success: false, error: `multi_edit edit #${i + 1} failed: ${result.error}` };
      }
      next = result.content;
      continue;
    }

    if (next.includes(edit.old_string)) {
      next = next.replace(edit.old_string, String(edit.new_string));
      continue;
    }

    const result = applyEditFileArgs(next, {
      old_text: edit.old_string,
      new_text: edit.new_string,
    });
    if (!result.success) {
      return { success: false, error: `multi_edit edit #${i + 1} failed: ${result.error}` };
    }
    next = result.content;
  }
  return { success: true, content: next, summary: `applied ${edits.length} edit(s)` };
}
