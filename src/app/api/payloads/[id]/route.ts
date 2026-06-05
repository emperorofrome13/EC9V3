import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
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
  const store = new ConversationStore(getWorkingDir(workingDirectory));

  try {
    const payload = store.getPayload(params.id);
    if (!payload) {
      return NextResponse.json({ error: 'Payload unavailable' }, { status: 404 });
    }

    const stream = Readable.toWeb(fs.createReadStream(payload.fullPath)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        'Content-Type': payload.mimeType,
        'Content-Length': String(payload.bytes),
        'Cache-Control': 'private, max-age=0, must-revalidate',
      },
    });
  } finally {
    store.close();
  }
}
