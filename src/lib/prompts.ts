import fs from 'fs/promises';
import path from 'path';

const promptsCache: Record<string, { content: string; mtimeMs: number }> = {};
const isDev = process.env.NODE_ENV !== 'production';

export async function loadPrompt(promptPath: string): Promise<string> {
  try {
    const fullPath = path.join(process.cwd(), 'src', 'prompts', promptPath);

    // In dev, stat the file and bust the cache when it changes on disk so that
    // editing a prompt .md doesn't require restarting the server.
    if (isDev) {
      const stat = await fs.stat(fullPath);
      const cached = promptsCache[promptPath];
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.content;
      }
      const content = await fs.readFile(fullPath, 'utf-8');
      promptsCache[promptPath] = { content, mtimeMs: stat.mtimeMs };
      return content;
    }

    if (promptsCache[promptPath]) {
      return promptsCache[promptPath].content;
    }
    const content = await fs.readFile(fullPath, 'utf-8');
    promptsCache[promptPath] = { content, mtimeMs: 0 };
    return content;
  } catch (error) {
    console.error(`Failed to load prompt: ${promptPath}`, error);
    return '';
  }
}

export function clearPromptCache(): void {
  Object.keys(promptsCache).forEach(key => delete promptsCache[key]);
}
