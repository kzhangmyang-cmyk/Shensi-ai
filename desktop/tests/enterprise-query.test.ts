import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnterpriseQuery } from '../src/shared/enterprise-browser.ts';

test('structured query preserves exact region and industry, never substitutes a keyword', () => {
  assert.deepEqual(validateEnterpriseQuery({keyword:'', region:['河南省','郑州市'], industry:['制造业','橡胶和塑料制品业']}),
    {keyword:'', region:['河南省','郑州市'], industry:['制造业','橡胶和塑料制品业']});
  assert.throws(()=>validateEnterpriseQuery({keyword:'',region:[],industry:[]}),/条件/);
  assert.throws(()=>validateEnterpriseQuery({keyword:'',region:[],industry:['制造业','橡胶和塑料制品业','塑料制品业']}),/二级/);
  assert.throws(()=>validateEnterpriseQuery({keyword:'银行',region:[],industry:[],url:'https://evil.test'}),/字段/);
  assert.throws(()=>validateEnterpriseQuery({keyword:'银行',region:['香港特别行政区','未知市','区'],industry:[]}),/地区/);
});
