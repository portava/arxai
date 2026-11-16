import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseCapabilities } from "../bridgeCapabilities.js";
import { ingestEaCapabilities } from "../eaCapabilityMapping.js";
import { managementTargetPollSupported, supportsManagementTarget } from "../managementTargetProtocol.js";
test("management protocol requires explicit boolean capability and exact per-request version", () => {
  for (const caps of [null,{},[],{supportsManagementTargetV1:1},{supportsManagementTargetV1:"true"}]) {
    assert.equal(supportsManagementTarget(caps),false);
    assert.equal(managementTargetPollSupported(caps,"1"),false);
  }
  const caps={supportsManagementTargetV1:true};
  for (const header of [undefined,null,1,"true","2",["1"],"1, 1"]) assert.equal(managementTargetPollSupported(caps,header),false);
  assert.equal(managementTargetPollSupported(caps,"1"),true);
  assert.equal(normaliseCapabilities(null).supportsManagementTargetV1,false);
  assert.equal(normaliseCapabilities(caps).supportsManagementTargetV1,true);
  assert.equal(ingestEaCapabilities(caps).legacyCapabilities.supportsManagementTargetV1,true);
});
