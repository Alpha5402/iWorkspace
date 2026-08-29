import { createHash } from 'node:crypto';

import { z } from 'zod';

export const ModelFindingSchema = z.object({
  confidence: z.number().min(0).max(1),
  description: z.string().min(1),
  endLine: z.number().int().positive(),
  evidence: z.array(z.string()).max(8),
  path: z.string().min(1),
  ruleId: z.string().min(1),
  severity: z.enum(['BLOCKING', 'MAJOR', 'MINOR', 'INFO']),
  startLine: z.number().int().positive(),
  title: z.string().min(1).max(200),
});

export const ReviewModelOutputSchema = z.object({
  findings: z.array(ModelFindingSchema).max(100),
  summary: z.string().min(1),
});
export type ReviewModelOutput = z.infer<typeof ReviewModelOutputSchema>;

export type ReviewModelRequest = Readonly<{
  category: 'DESIGN' | 'IMPLEMENTATION' | 'DEFECT';
  diff: string;
  promptVersion: string;
  repairInstruction?: string;
  rules: readonly Readonly<{
    evidenceRequirement: string;
    guidance: string;
    id: string;
    severity: 'BLOCKING' | 'MAJOR' | 'MINOR' | 'INFO';
    title: string;
  }>[];
}>;

export type ReviewModelResult = Readonly<{
  inputHash: string;
  latencyMs: number;
  output: ReviewModelOutput;
  providerResponseId?: string;
  usage: Readonly<{ inputTokens?: number; outputTokens?: number }>;
}>;

export interface ReviewModelProvider {
  reviewBatch(request: ReviewModelRequest, signal?: AbortSignal): Promise<ReviewModelResult>;
}

export class ModelProviderError extends Error {
  public constructor(
    public readonly code: 'RATE_LIMITED' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'PROVIDER_FAILURE',
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

const DeepSeekResponseSchema = z.object({
  id: z.string().optional(),
  output: z.array(
    z.object({
      content: z.array(
        z.object({
          text: z.string().optional(),
          type: z.string(),
        }),
      ),
      type: z.string(),
    }),
  ),
  status: z.enum(['completed', 'incomplete', 'failed']).optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

type FetchLike = typeof fetch;

export class DeepSeekResponsesProvider implements ReviewModelProvider {
  public constructor(
    private readonly apiKey: string,
    private readonly model = 'deepseek-v4-flash',
    private readonly endpoint = 'https://api.deepseek.com/responses',
    private readonly fetchImplementation: FetchLike = fetch,
  ) {}

  public async reviewBatch(
    request: ReviewModelRequest,
    signal?: AbortSignal,
  ): Promise<ReviewModelResult> {
    const startedAt = performance.now();
    const input = this.buildInput(request);
    const inputHash = createHash('sha256').update(input).digest('hex');
    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        body: JSON.stringify({
          input,
          model: this.model,
          reasoning: { effort: 'high' },
          text: {
            format: {
              name: 'review_result',
              schema: z.toJSONSchema(ReviewModelOutputSchema),
              strict: true,
              type: 'json_schema',
            },
          },
        }),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw new ModelProviderError('TIMEOUT', 'DeepSeek request was aborted.');
      }
      throw new ModelProviderError(
        'PROVIDER_FAILURE',
        'DeepSeek request failed before a response.',
      );
    }
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      if (response.status === 429) {
        throw new ModelProviderError(
          'RATE_LIMITED',
          'DeepSeek rate limit reached.',
          Number.isFinite(retryAfter) ? retryAfter : undefined,
        );
      }
      throw new ModelProviderError(
        'PROVIDER_FAILURE',
        `DeepSeek returned HTTP ${response.status}.`,
      );
    }
    const parsedResponse = DeepSeekResponseSchema.safeParse(await response.json());
    if (!parsedResponse.success || parsedResponse.data.status !== 'completed') {
      throw new ModelProviderError('INVALID_RESPONSE', 'DeepSeek returned an incomplete response.');
    }
    const outputText = parsedResponse.data.output
      .flatMap((entry) => entry.content)
      .find((content) => content.type === 'output_text')?.text;
    if (outputText === undefined) {
      throw new ModelProviderError(
        'INVALID_RESPONSE',
        'DeepSeek response did not contain output text.',
      );
    }
    let outputJson: unknown;
    try {
      outputJson = JSON.parse(outputText);
    } catch {
      throw new ModelProviderError('INVALID_RESPONSE', 'DeepSeek output was not valid JSON.');
    }
    const output = ReviewModelOutputSchema.safeParse(outputJson);
    if (!output.success) {
      throw new ModelProviderError(
        'INVALID_RESPONSE',
        'DeepSeek output did not match the review schema.',
      );
    }
    return {
      inputHash,
      latencyMs: Math.round(performance.now() - startedAt),
      output: output.data,
      ...(parsedResponse.data.id === undefined
        ? {}
        : { providerResponseId: parsedResponse.data.id }),
      usage: {
        ...(parsedResponse.data.usage?.input_tokens === undefined
          ? {}
          : { inputTokens: parsedResponse.data.usage.input_tokens }),
        ...(parsedResponse.data.usage?.output_tokens === undefined
          ? {}
          : { outputTokens: parsedResponse.data.usage.output_tokens }),
      },
    };
  }

  private buildInput(request: ReviewModelRequest): string {
    return [
      `Prompt-Version: ${request.promptVersion}`,
      `Review-Category: ${request.category}`,
      'Review only the supplied diff. Report a finding only when the evidence is in the diff.',
      ...(request.repairInstruction === undefined
        ? []
        : [
            `Repair the previous invalid structured output. Validation error: ${request.repairInstruction}`,
          ]),
      'Applicable rules:',
      JSON.stringify(request.rules),
      'Diff:',
      request.diff,
    ].join('\n');
  }
}
