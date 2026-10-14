import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';
import { fileURLToPath } from 'node:url';
import { loadSchemaRegistry, loadNamedOpenApiSource } from './helpers.mjs';
const id = '11111111-1111-4111-8111-111111111111';
async function validator(name, definition) {
  const { schemaDocuments } = await loadSchemaRegistry();
  assert.ok(schemaDocuments.has('system-reference'), 'system-reference contract exists');
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  for (const schema of schemaDocuments.values()) ajv.addSchema(schema);
  return ajv.compile({ $ref: `${schemaDocuments.get(name).$id}${definition ? '#/$defs/' + definition : ''}` });
}
const system = { sourceType: 'system', sourceId: 'K1', referenceKey: `system:${id}:${id}`, queryGrantId: id, referenceId: id, corpusId: id, releaseId: id, sourceHash: 'a'.repeat(64), chunkHash: 'b'.repeat(64), excerptRange: { start: 0, end: 5 }, sourceLabel: 'Synthetic system source', locator: { page: 1 }, excerpt: '仅合成文本', warnings: [] };
const privateSource = { sourceId: 'K2', documentId: id, versionId: id, chunkId: id, sourceHash: 'a'.repeat(64), sourceLabel: 'Synthetic private source', locator: {}, excerpt: '私有合成文本', warnings: [] };
test('central query contract accepts only fixed topic IDs and necessary metadata', async () => {
  const validate = await validator('system-reference', 'ReferenceQuery');
  const query = { vocabularyVersion: 'finance-topics.v1', topicIds: ['budget_variance'], role: 'finance', requestId: id };
  assert.equal(validate(query), true, JSON.stringify(validate.errors));
  for (const extra of ['question', 'history', 'company', 'documentId', 'text', 'url']) assert.equal(validate({ ...query, [extra]: 'private' }), false);
  for (const topicIds of [[], ['unknown'], ['cost_driver', 'cost_driver'], ['budget_variance', 'budget_planning', 'cost_driver', 'cost_structure']]) assert.equal(validate({ ...query, topicIds }), false);
});
test('answer union cannot route a system UUID into the private citation shape', async () => {
  const citation = await validator('knowledge', 'Citation');
  const answer = await validator('knowledge', 'Answer');
  assert.equal(citation(privateSource), true); assert.equal(citation(system), false);
  assert.equal(citation({ ...privateSource, sourceType: 'private' }), true);
  assert.equal(citation({ ...privateSource, sourceType: 'system' }), false);
  const value = { status: 'used', detailedText: '合成答案', sources: [privateSource, system], warnings: [] };
  assert.equal(answer(value), true, JSON.stringify(answer.errors));
  assert.equal(answer({ ...value, sources: [{ ...system, documentId: id }] }), false);
  const { sourceType, ...missingType } = system;
  assert.equal(answer({ ...value, sources: [missingType] }), false);
});
test('CFO and session inputs require protocol for explicit topics while legacy stays valid', async () => {
  for (const [name, def, base] of [['cfo-conversation', 'Input', { question: '预算偏差', history: [] }], ['cfo-session', 'Ask', { question: '预算偏差', documentId: null, revision: 1 }]]) {
    const validate = await validator(name, def);
    assert.equal(validate(base), true);
    assert.equal(validate({ ...base, referenceTopicIds: ['budget_variance'] }), false);
    assert.equal(validate({ ...base, referenceProtocol: 'system-v1', referenceTopicIds: ['budget_variance'] }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...base, referenceProtocol: 'system-v1', referenceTopicIds: ['private-company'] }), false);
    const schema = (await loadSchemaRegistry()).schemaDocuments.get(name).$defs[def];
    assert.equal('default' in schema.properties.referenceProtocol, false);
    assert.equal('default' in schema.properties.referenceTopicIds, false);
  }
});
test('safe connection status, manifest pages and library status are bounded closed DTOs', async () => {
  const connection = await validator('system-reference', 'ConnectionStatus');
  assert.equal(connection({ status: 'unbound', generation: 0 }), true);
  assert.equal(connection({ status: 'session_ready', generation: 0 }), true);
  assert.equal(connection({ status: 'embedded_ready', generation: 0 }), true);
  for (const status of ['ready', 'embedded_ready']) for (const key of ['readerToken', 'verifier', 'password', 'url']) assert.equal(connection({ status, generation: 1, [key]: 'secret' }), false);
  assert.equal(connection({ status: 'embedded_unknown', generation: 0 }), false);
  const state = await validator('system-reference', 'LibraryStatus');
  assert.equal(state({ private: 'used', system: 'unavailable' }), true);
  assert.equal(state({ private: 'used', system: 'used' }), false);
  const page = await validator('system-reference', 'SourcePage');
  const chunk = { order: 100, text: '合成片段', locator: { page: 1 }, warnings: [] };
  assert.equal(page({ sourceHash: 'a'.repeat(64), pageIndex: 1, totalChunks: 101, chunks: [chunk] }), true);
  assert.equal(page({ sourceHash: 'a'.repeat(64), pageIndex: 0, totalChunks: 101, chunks: Array.from({ length: 101 }, () => chunk) }), false);
  assert.equal(page({ sourceHash: 'a'.repeat(64), pageIndex: 1, totalChunks: 101, chunks: [{ ...chunk, id }] }), false);
});
test('new surface exposes finite grants and separate owner publishing, no whole-book routes', async () => {
  await validator('system-reference', 'SystemReference');
  const api = await loadNamedOpenApiSource('system-reference.v1.yaml');
  const paths = Object.keys(api.paths);
  for (const path of ['/api/v1/system-reference/query', '/api/v1/system-reference/grants/{id}/check', '/api/v1/system-reference/grants/{id}/references/{referenceId}', '/api/v1/reference-connection']) assert.ok(paths.includes(path));
  assert.ok(paths.every(path => !/(?:download|chunks|original|\/documents)/u.test(path)));
  assert.deepEqual(api.paths['/api/v1/system-reference/query'].post.security, [{ referenceReader: [] }]);
  const publish = api.paths['/api/platform/v1/system-reference/releases/{id}/publish'].post;
  assert.deepEqual(publish.security, [{ cookieAuth: [], platformSession: [], csrfToken: [] }]);
  assert.ok(publish.parameters.some(parameter => parameter.$ref.endsWith('/revision')));
  await SwaggerParser.validate(fileURLToPath(new URL('../openapi/system-reference.v1.yaml', import.meta.url)));
  await SwaggerParser.validate(fileURLToPath(new URL('../openapi/platform-admin.v1.yaml', import.meta.url)));
});
test('local citation bridge uses normal actor authentication, exact identifiers and the same bounded reference DTO', async () => {
  const api = await loadNamedOpenApiSource('system-reference.v1.yaml');
  const entry = api.paths['/api/v1/reference-connection/grants/{id}/references/{referenceId}'];
  assert.ok(entry, 'normal-session backend bridge missing');
  assert.deepEqual(Object.keys(entry), ['get']);
  assert.deepEqual(entry.get.security, [{bearerAuth:[]},{cookieAuth:[]}]);
  assert.deepEqual(entry.get.parameters.map(p=>p.$ref), ['#/components/parameters/workspace','#/components/parameters/id','#/components/parameters/referenceId']);
  assert.equal(entry.get.requestBody, undefined);
  assert.equal(entry.get.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/SystemReference');
  assert.deepEqual(api.paths['/api/v1/system-reference/grants/{id}/references/{referenceId}'].get.security,[{referenceReader:[]}]);
});
test('published Growth 1.0.39 remains byte-for-byte immutable', async () => {
  for (const [file, expected] of [['openapi.json', '1c50bbfcf287d528243f8033861fbf92cb5f2ad9c347868f88283aabd5c3deb4'], ['manifest.json', 'b9ce89b2e820020f51ab28807e4517f62c2672d258d015478dcd159098a3042a']]) {
    const bytes = await readFile(new URL(`../releases/growth-advisor-quote-roi/1.0.39/${file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  }
});

test('Growth 1.0.40 keeps its approved document hash and canonical original manifest', async () => {
  const hash = '1fbe159ccb1009cbc22790f2c7c3b4fa4d67f52b598088ceb4d3189c4e9507a1';
  const base = '../releases/growth-advisor-quote-roi/1.0.40/';
  assert.equal(createHash('sha256').update(await readFile(new URL(base + 'openapi.json', import.meta.url))).digest('hex'), hash);
  const expected = { name: 'growth-advisor-quote-roi', contractVersion: '1.0.40', contractHash: 'sha256:' + hash, openapiVersion: '3.1.0' };
  assert.equal(await readFile(new URL(base + 'manifest.json', import.meta.url), 'utf8'), JSON.stringify(expected, null, 2) + '\n');
});
test('owner metadata reads are closed and bounded without exposing content or command keys', async () => {
  const draft={id,corpusId:id,revision:1,status:'staging',manifestHash:'a'.repeat(64)};
  const list=await validator('system-reference','ReleaseList');
  assert.equal(list({items:[draft],activeReleaseId:null,nextCursor:null}),true);
  assert.equal(list({items:Array(51).fill(draft),activeReleaseId:null,nextCursor:null}),false);
  assert.equal(list({items:[],activeReleaseId:null,nextCursor:null,text:'private'}),false);
  const command=await validator('system-reference','PublicationCommandStatus');
  assert.equal(command({operation:'stage',outcome:'not_observed'}),true);
  assert.equal(command({operation:'stage',outcome:'committed',requestHash:'b'.repeat(64),release:draft}),true);
  assert.equal(command({operation:'stage',outcome:'not_observed',key:'secret'}),false);
  assert.equal(command({operation:'stage',outcome:'committed'}),false);
  const api=await loadNamedOpenApiSource('system-reference.v1.yaml');
  for(const path of ['/api/platform/v1/system-reference/releases','/api/platform/v1/system-reference/releases/{id}','/api/platform/v1/system-reference/commands/status'])assert.deepEqual(api.paths[path].get.security,[{cookieAuth:[],platformSession:[]}]);
});
test('platform administration exposes all owner metadata reads with their canonical bounded responses', async () => {
  const platform = await SwaggerParser.dereference(fileURLToPath(new URL('../openapi/platform-admin.v1.yaml', import.meta.url)));
  for (const [path, operationId, required] of [
    ['/api/platform/v1/system-reference/releases', 'listReferenceReleases', ['items', 'activeReleaseId', 'nextCursor']],
    ['/api/platform/v1/system-reference/releases/{id}', 'inspectReferenceRelease', ['release', 'manifest', 'activeReleaseId', 'sources']],
    ['/api/platform/v1/system-reference/commands/status', 'inspectReferenceCommand', null]
  ]) {
    const operation = platform.paths[path]?.get;
    assert.ok(operation, `platform metadata GET is missing: ${path}`);
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.security, [{ cookieAuth: [], platformSession: [] }]);
    const response = operation.responses['200'].content['application/json'].schema;
    if (required) {
      assert.deepEqual(response.required, required);
      assert.equal(response.additionalProperties, false);
    } else {
      assert.equal(response.oneOf.length, 2);
      assert.ok(response.oneOf.every(branch => branch.additionalProperties === false));
    }
  }
});
