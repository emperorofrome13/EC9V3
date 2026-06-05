import { NextRequest, NextResponse } from 'next/server';
import { chatCompletion } from '@/lib/lmstudio';
import { loadPrompt } from '@/lib/prompts';
import { extractAutoPromptVerdictFromLines } from '@/lib/autoprompt-verdict';
import { resolveProviderApiProtocol } from '@/lib/provider-protocol';
import type { AutoPromptStageResult } from '@/types/ec9v3';

const AUTOPROMPT_STAGE_NAMES: Record<string, string> = {
  review: 'Code Review',
  placeholder_cleanup: 'Placeholder Cleanup',
  run_fix: 'Run & Fix',
  senior_review: 'Senior Review',
  completeness: 'Completeness',
  task_verify: 'Completeness',
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      model,
      lmstudioUrl,
      temperature,
      maxTokens,
      apiProtocol,
      apiKey,
      stages,
      context,
      requirements,
    } = body;

    const baseUrl = lmstudioUrl || 'http://localhost:1234';
    const results: AutoPromptStageResult[] = [];
    if (stages !== undefined && !Array.isArray(stages)) {
      return NextResponse.json(
        { error: '`stages` must be an array of stage IDs' },
        { status: 400 },
      );
    }
    const enabledStages: string[] = Array.isArray(stages) && stages.length > 0
      ? stages.filter((s: unknown): s is string => typeof s === 'string')
      : ['review'];

    for (const stageId of enabledStages) {
      const canonicalStageId = stageId === 'task_verify' ? 'completeness' : stageId;
      const stageName = AUTOPROMPT_STAGE_NAMES[canonicalStageId] || canonicalStageId;
      
      // Load prompt from .md file
      let promptTemplate: string;
      try {
        promptTemplate = await loadPrompt(`autoprompt/${canonicalStageId}.md`);
        if (!promptTemplate) {
          throw new Error(`Prompt file not found for stage: ${stageId}`);
        }
      } catch (error) {
        console.error(`Failed to load autoprompt stage ${stageId}:`, error);
        results.push({
          stage: canonicalStageId as AutoPromptStageResult['stage'],
          passed: false,
          summary: `${stageName}: Error - Failed to load prompt configuration`,
          details: String(error),
        });
        continue;
      }

      const startTime = Date.now();
      const prompt = promptTemplate
        .replace(/{context}/g, context || 'No context provided')
        .replace(/{requirements}/g, requirements || 'No requirements provided')
        .replace(/{errors}/g, '');

      try {
        const chatOpts: Record<string, unknown> = {
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: 'Please review and return the required structured JSON result.' },
          ],
          temperature: temperature ?? 0.3,
          maxTokens: maxTokens ?? 30000,
          topP: 0.9,
          repeatPenalty: 1.1,
          apiProtocol: resolveProviderApiProtocol(baseUrl, apiProtocol, model),
          apiKey: typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined,
        };
        if (model) chatOpts.model = model;
        
        const response = await chatCompletion(baseUrl, chatOpts as any);

        const content = response.content || '';
        const verdict = extractAutoPromptVerdictFromLines(content);
        const passed = verdict === 'PASS' || verdict === 'FIXED';

        results.push({
          stage: canonicalStageId as AutoPromptStageResult['stage'],
          passed,
          verdict: verdict === 'FIXED' ? 'fixed' : verdict === 'PASS' ? 'pass' : 'fail',
          summary: passed ? `${stageName}: Passed` : `${stageName}: Remaining issues`,
          details: content,
          duration: Date.now() - startTime,
        });
      } catch (error: unknown) {
        const err = error as { message?: string };
        results.push({
          stage: canonicalStageId as AutoPromptStageResult['stage'],
          passed: false,
          summary: `${stageName}: Error - ${err.message}`,
          duration: Date.now() - startTime,
        });
      }
    }

    return NextResponse.json({ results });
  } catch (error: unknown) {
    const err = error as { message?: string };
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
