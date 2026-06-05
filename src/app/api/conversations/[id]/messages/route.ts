import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { ConversationStore } from '@/lib/conversation-store';

export const runtime = 'nodejs';

function getWorkingDir(requestedWd?: string | null): string {
  if (!requestedWd) return process.env.WORKING_DIRECTORY || process.cwd();
  return path.isAbsolute(requestedWd) ? requestedWd : path.resolve(process.cwd(), requestedWd);
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const workingDirectory = request.nextUrl.searchParams.get('workingDirectory');
  const limit = Number(request.nextUrl.searchParams.get('limit') || 80);
  const beforeParam = request.nextUrl.searchParams.get('before');
  const before = beforeParam === null ? undefined : Number(beforeParam);
  const store = new ConversationStore(getWorkingDir(workingDirectory));

  try {
    const messages = store.getMessages(params.id, {
      limit: Number.isFinite(limit) ? limit : 80,
      before: before !== undefined && Number.isFinite(before) ? before : undefined,
    });
    return NextResponse.json({
      messages,
      nextBefore: messages[0]?.serverOrdinal,
    });
  } finally {
    store.close();
  }
}
