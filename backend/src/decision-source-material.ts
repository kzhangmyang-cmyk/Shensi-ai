import { z } from 'zod';
import { FinanceDocumentService } from './finance-document-service.js';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';
import { GrowthHttpError } from './growth-command-context.js';

const MAX_BYTES = 5 * 1024 * 1024;
const fileSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.enum(['text/csv', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  contentBase64: z.string().min(4).max(4 * Math.ceil(MAX_BYTES / 3)),
}).strict();
export const decisionSourceInputSchema = z.object({
  dataKind: z.enum(['synthetic', 'user_defined']), files: z.array(fileSchema).min(1).max(10),
}).strict();

/** Read-only reuse of the safe parser, independent of council workers and chat selections. */
export async function inspectDecisionSources(context: ActiveWorkspaceContext, raw: unknown, signal?: AbortSignal) {
  const parsed = decisionSourceInputSchema.safeParse(raw);
  if (!parsed.success) throw new GrowthHttpError(422, 'decision_source_input_invalid');
  const { files, dataKind } = parsed.data;
  let bytes = 0;
  for (const file of files) {
    const content = Buffer.from(file.contentBase64, 'base64');
    if (content.toString('base64') !== file.contentBase64) throw new GrowthHttpError(422, 'decision_source_content_invalid');
    bytes += content.length;
  }
  if (bytes > MAX_BYTES) throw new GrowthHttpError(413, 'decision_source_limit_exceeded');
  // A separate parser instance cannot replace an agent-center selected document.
  const parser = new FinanceDocumentService();
  const parsedFiles = [];
  for (const file of files) {
    signal?.throwIfAborted();
    parsedFiles.push(await parser.inspect(context, { ...file, readWithModel: false }, signal));
  }
  const quota = Math.floor(2000 / files.length);
  const sourceFiles = parsedFiles.map((file, index) => ({ fileName: files[index].fileName,
    fileHash: file.fileHash, prefix: `file:${index + 1}:` }));
  return {
    dataKind, files: sourceFiles,
    cells: parsedFiles.flatMap((file, index) => file.cells.slice(0, quota)
      .map(cell => ({ ...cell, sourceRef: `${sourceFiles[index].prefix}${cell.sourceRef}` }))),
    uncertain: [...new Set([...parsedFiles.flatMap(file => file.uncertain),
      ...(parsedFiles.some(file => file.cells.length > quota) ? ['source_cells_omitted'] : [])])],
    observations: [], modelStatus: 'not_requested' as const,
  };
}
