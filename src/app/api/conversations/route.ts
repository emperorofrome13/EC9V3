import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { ConversationStore } from '@/lib/conversation-store';

export const runtime = 'nodejs';

function getWorkingDir(requestedWd?: string | null): string {
  if (!requestedWd) return process.env.WORKING_DIRECTORY || process.cwd();
  return path.isAbsolute(requestedWd) ? requestedWd : path.resolve(process.cwd(), requestedWd);
}

export async function GET(request: NextRequest) {
  const workingDirectory = request.nextUrl.searchParams.get('workingDirectory');
  const limit = Number(request.nextUrl.searchParams.get('limit') || 80);
  const store = new ConversationStore(getWorkingDir(workingDirectory));
  try {
    return NextResponse.json({
      conversations: store.listConversations(Number.isFinite(limit) ? limit : 80),
    });
  } finally {
    store.close();
  }
}
