import type { components } from '../generated/system-reference';
export const releaseId = '77777777-7777-4777-8777-777777777777';
export const releaseDetail: components['schemas']['ReleaseDetail'] = {
  release: { id: releaseId, corpusId: '88888888-8888-4888-8888-888888888888', revision: 2, status: 'ready', manifestHash: 'a'.repeat(64) },
  activeReleaseId: null,
  manifest: { corpusId: '88888888-8888-4888-8888-888888888888', sources: [{
    title: '<img>合成参考书', roles: ['cfo','finance'], sourceHash: 'b'.repeat(64), artifactHash: 'c'.repeat(64), parsedHash: 'd'.repeat(64), parserVersion: 'synthetic-v1',
    coverage: { totalPages: 3, extractedPages: 2, missingPages: [3] }, warnings: ['source_incomplete','ocr_table_formula_review_required']
  }] }, sources: [{ sourceHash: 'b'.repeat(64), totalChunks: 4, receivedChunks: 4, complete: true }]
};
