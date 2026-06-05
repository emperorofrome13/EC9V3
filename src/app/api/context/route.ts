import { NextRequest, NextResponse } from 'next/server';
import { resolveLoadedModelContextLimit } from '@/lib/context-window';
import { resolveProviderApiProtocol } from '@/lib/provider-protocol';
import type { ModelApiProtocol } from '@/types/ec9v3';

async function resolveContextLimit(
  url: string,
  model: string | undefined,
  fallback: number,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
) {
  const resolution = await resolveLoadedModelContextLimit(url, model, fallback, apiKey, apiProtocol);
  return NextResponse.json({
    contextLimit: resolution.contextLimit,
    source: resolution.source,
    fallback: resolution.source === 'manual_fallback',
  });
}

export async function GET(request: NextRequest) {
  const fallback = Number(request.nextUrl.searchParams.get('fallback') || 30000);
  try {
    const url = request.nextUrl.searchParams.get('url') || 'http://localhost:1234';
    const model = request.nextUrl.searchParams.get('model') || undefined;
    const apiProtocol = resolveProviderApiProtocol(url, request.nextUrl.searchParams.get('apiProtocol'), model);
    return await resolveContextLimit(url, model, fallback, undefined, apiProtocol);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.warn('Failed to resolve context limit, using fallback:', err.message || String(error));
    return NextResponse.json({ contextLimit: Math.max(1024, fallback || 30000), fallback: true });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as {
    url?: string;
    model?: string;
    fallback?: number;
    apiKey?: string;
    apiProtocol?: ModelApiProtocol;
  };
  const fallback = Number(body.fallback || 30000);
  try {
    return await resolveContextLimit(
      body.url || 'http://localhost:1234',
      body.model || undefined,
      fallback,
      body.apiKey || undefined,
      resolveProviderApiProtocol(body.url || 'http://localhost:1234', body.apiProtocol, body.model || undefined),
    );
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.warn('Failed to resolve context limit, using fallback:', err.message || String(error));
    return NextResponse.json({
      contextLimit: Math.max(1024, fallback || 30000),
      source: 'manual_fallback',
      fallback: true,
    });
  }
}
