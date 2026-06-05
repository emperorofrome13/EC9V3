import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { ConversationStore } from '@/lib/conversation-store';
import type { Conversation } from '@/types/ec9v3';

export const runtime = 'nodejs';

interface ImportBody {
  workingDirectory?: string;
  conversations?: Conversation[];
}

function getWorkingDir(requestedWd?: string | null): string {
  if (!requestedWd) return process.env.WORKING_DIRECTORY || process.cwd();
  return path.isAbsolute(requestedWd) ? requestedWd : path.resolve(process.cwd(), requestedWd);
}

function isConversationArray(value: unknown): value is Conversation[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as { id?: unknown; title?: unknown; messages?: unknown };
    return typeof candidate.id === 'string' &&
      typeof candidate.title === 'string' &&
      Array.isArray(candidate.messages);
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json() as ImportBody;
  if (!isConversationArray(body.conversations)) {
    return NextResponse.json({ error: 'conversations array is required' }, { status: 400 });
  }

  const store = new ConversationStore(getWorkingDir(body.workingDirectory));
  try {
    const result = store.importConversations(body.conversations);
    return NextResponse.json({ ok: true, ...result });
  } finally {
    store.close();
  }
}
