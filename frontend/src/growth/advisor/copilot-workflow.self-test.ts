import { strict as assert } from "node:assert";
import {
  createAdvisorCopilotWorkflow,
  type AdvisorCopilotPorts
} from "./copilot-workflow";

let sessionCalls = 0;
let messageCalls = 0;
let taskCalls = 0;
const ports: AdvisorCopilotPorts = {
  async createSession() {
    sessionCalls += 1;
    return { id: "session-1" };
  },
  async postMessage() {
    messageCalls += 1;
    return { messageId: "message-1", taskId: "task-1" };
  },
  async getTask(_taskId) {
    taskCalls += 1;
    if (taskCalls === 1) {
      return { id: "task-1", status: "running" };
    }
    return {
      id: "task-1",
      status: "succeeded",
      result: { explanation: "基于已关账数据，建议先核销成本。" }
    };
  }
};

const workflow = createAdvisorCopilotWorkflow(ports);
const first = await workflow.ask("今天先做什么");
assert.equal(first.aiUnavailable, false);
assert.equal(first.explanation.includes("核销成本"), true);
const second = await workflow.ask("再问一次");
assert.equal(sessionCalls, 1, "one session is reused");
assert.equal(messageCalls, 2);
assert.equal(taskCalls, 3);

let failureTaskCalls = 0;
const failing = createAdvisorCopilotWorkflow({
  async createSession() {
    return { id: "session-fail" };
  },
  async postMessage() {
    return { messageId: "message-fail", taskId: "task-fail" };
  },
  async getTask() {
    failureTaskCalls += 1;
    return { id: "task-fail", status: "failed" };
  }
});
const failed = await failing.ask("今天先做什么");
assert.equal(failed.aiUnavailable, true);
assert.equal(failed.explanation, "");
