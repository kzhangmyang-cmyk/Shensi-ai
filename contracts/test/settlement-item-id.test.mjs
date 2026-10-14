import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("settlement responses expose server-owned item IDs for refund references",async()=>{
  const schema=JSON.parse(await readFile(new URL("../json-schema/allocation-set.v1.schema.json",import.meta.url),"utf8"));
  const output=schema.$defs.CashSettlementAllocationItem;
  assert.ok(output.required.includes("id"));
  assert.deepEqual(output.properties.id,{$ref:"#/$defs/nonempty"});
  assert.ok(output.required.includes("allocationSetId"));
  assert.equal(schema.$defs.CashSettlementAllocationItemInput.properties.id,undefined);
  assert.equal(schema.$defs.CashSettlementAllocationItemInput.additionalProperties,false);
});
