import assert from 'node:assert/strict';
import { createAgentWebResearchRuntime } from '../src/agent-web-research-runtime.js';
import { capabilitiesForHumanRole } from '../src/growth-capabilities.js';

const context={workspaceId:'public-search-acceptance',actorId:'synthetic-actor',teamId:'public-search-acceptance',
  kind:'personal' as const,role:'admin' as const,capabilities:capabilitiesForHumanRole('admin'),capabilityRegistryVersion:'growth-capabilities.v1' as const};
const store={providerConnections:[],providerCatalog:[],providerRequestLogs:[],async persist(){}};
const runtime=createAgentWebResearchRuntime(store as never);
const connections=await runtime.connections(context);
assert.equal(connections.length,1);
const evidence=await runtime.retrieve(context,{query:'中国 企业 现金流 管理 公开 指引',role:'cashflow',connectionId:connections[0].id});
assert.ok(evidence.sources.length>0);
console.log(JSON.stringify(evidence,null,2));
