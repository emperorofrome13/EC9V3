import { NextRequest, NextResponse } from 'next/server';
import { listModels } from '@/lib/lmstudio';
import { filterModelsForProviderProtocol, normalizeApiProtocol } from '@/lib/provider-protocol';
import type { ModelApiProtocol } from '@/types/ec9v3';

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl.searchParams.get('url') || 'http://localhost:1234';
    const apiProtocol = normalizeApiProtocol(request.nextUrl.searchParams.get('apiProtocol'));
    const models = filterModelsForProviderProtocol(url, await listModels(url, undefined, apiProtocol), apiProtocol);
    return NextResponse.json({ models });
  } catch (error: unknown) {
    const err = error as { message?: string };
    return NextResponse.json(
      { error: err.message || 'Failed to list models' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { url?: string; apiKey?: string; apiProtocol?: ModelApiProtocol };
    const url = body.url || 'http://localhost:1234';
    const apiProtocol = normalizeApiProtocol(body.apiProtocol);
    const models = filterModelsForProviderProtocol(url, await listModels(url, body.apiKey || undefined, apiProtocol), apiProtocol);
    return NextResponse.json({ models });
  } catch (error: unknown) {
    const err = error as { message?: string };
    return NextResponse.json(
      { error: err.message || 'Failed to list models' },
      { status: 500 }
    );
  }
}
