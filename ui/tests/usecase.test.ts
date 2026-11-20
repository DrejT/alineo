import { test, expect } from "bun:test";
import { db } from "../server/db";
import { signup, login, validateSession, logout } from "../server/auth";
import {
  listSandboxes,
  getSandbox,
  spawnSandbox,
  forkSandbox,
  checkpointSandbox,
  pauseSandbox,
  resumeSandbox,
  execInSandbox,
} from "../server/sandboxes";
import {
  listWorkingMemory,
  setWorkingMemory,
  deleteWorkingMemory,
  recallSemanticFacts,
  addSemanticFact,
  compactMemory,
} from "../server/memory";
import { listEgressGates, decideEgressGate, createEgressGate } from "../server/security";
import { getWorkflowState, enqueueWorkflowJob, flushWorkflowPipeline } from "../server/workflow";
import { steerAgent } from "../server/steer";
import { executeOneCliCommand } from "../server/cli";

test("Multitenant User Authentication Suite & Test Credentials Validation", () => {
  // 1. Validate hardcoded test credential 1: Test@123
  const loginRes1 = login({ usernameOrEmail: "test", password: "Test@123" });
  expect(loginRes1.token).toBeDefined();
  expect(loginRes1.user.username).toBe("test");
  expect(loginRes1.user.id).toBe("usr_test");

  // Validate session token in SQLite
  const validSession1 = validateSession(loginRes1.token);
  expect(validSession1?.id).toBe("usr_test");

  // 2. Validate hardcoded test credential 2: 122334
  const loginRes2 = login({ usernameOrEmail: "test", password: "122334" });
  expect(loginRes2.token).toBeDefined();
  expect(loginRes2.user.username).toBe("test");

  // 3. Reject invalid password
  expect(() => login({ usernameOrEmail: "test", password: "invalid_password" })).toThrow();

  // 4. Dynamic user registration (stored in SQLite users table)
  const dynamicUsername = "user_" + Math.random().toString(36).substring(2, 7);
  const signupRes = signup({
    username: dynamicUsername,
    email: `${dynamicUsername}@corp.ai`,
    password: "SecurePass@2026",
    displayName: "Security Auditor",
  });
  expect(signupRes.token).toBeDefined();
  expect(signupRes.user.username).toBe(dynamicUsername);
  expect(signupRes.user.id).toStartWith("usr_");

  // 5. Verify multitenant workspace isolation
  const testFleet = listSandboxes("usr_test");
  const newFleet = listSandboxes(signupRes.user.id);

  // usr_test fleet has root reviewer
  expect(testFleet.length).toBeGreaterThanOrEqual(1);

  // New user fleet is isolated
  expect(newFleet.every(sb => sb.userId === signupRes.user.id)).toBe(true);
  expect(testFleet.every(sb => sb.userId === "usr_test")).toBe(true);

  // 6. Test session logout
  logout(loginRes1.token);
  expect(validateSession(loginRes1.token)).toBeNull();
});

test("End-to-End Use Case: PR #418 Automated Code Review & Security Swarm", async () => {
  const userId = "usr_test";

  // 1. Initial State & Fleet check
  const initialFleet = listSandboxes(userId);
  expect(initialFleet.length).toBeGreaterThanOrEqual(1);
  const root = initialFleet.find(s => s.role === 'code-reviewer-root') || await spawnSandbox(userId, {
    role: 'code-reviewer-root',
    cpuLimitMilli: 500,
    memLimitMi: 512,
    mcpTools: ['GitHub', 'Slack'],
  });
  expect(root).toBeDefined();
  expect(root.status).toBe('running');

  // 2. Real Shell Command Exec inside Sandbox
  const execResult = await execInSandbox(userId, root.id, 'git status');
  expect(execResult.exitCode).toBe(0);
  expect(execResult.stdout).toContain('ui-final-google');
  expect(execResult.durationMs).toBeGreaterThanOrEqual(0);

  // 3. CoW Fork Child Sub-Agent
  const secChild = await forkSandbox(userId, root.id, 'reviewer-security');
  expect(secChild.parentId).toBe(root.id);
  expect(secChild.depth).toBe(root.depth + 1);
  expect(secChild.status).toBe('running');

  // 4. Memory Core: Working Memory KV Store
  setWorkingMemory(userId, root.id, 'target_pr', '418', 'swarm');
  setWorkingMemory(userId, secChild.id, 'jwt_algorithm', 'RS256', 'local');

  const rootMemory = listWorkingMemory(userId, root.id);
  expect(rootMemory.some(m => m.key === 'target_pr' && m.value === '418')).toBe(true);

  const secMemory = listWorkingMemory(userId, secChild.id);
  expect(secMemory.some(m => m.key === 'jwt_algorithm' && m.value === 'RS256')).toBe(true);

  // 5. Memory Core: Semantic Facts Recall
  addSemanticFact(userId, {
    subject: 'jwt.middleware',
    predicate: 'enforces_token_expiry',
    object: '900_seconds',
    tags: ['jwt', 'security', 'timeout'],
  });

  const recalled = recallSemanticFacts(userId, 'jwt expiry', 3);
  expect(recalled.length).toBeGreaterThanOrEqual(1);
  expect(recalled[0].subject).toContain('jwt');

  // 6. Security Perimeter: Outbound Egress Gate
  const gate = createEgressGate(userId, {
    sandboxId: secChild.id,
    targetHost: 'api.osv.dev:443',
    protocol: 'HTTPS',
    reason: 'Vulnerability check for PR #418 dependencies',
  });
  expect(gate.status).toBe('pending');
  await pauseSandbox(userId, secChild.id);

  // Operator approves gate
  const decided = await decideEgressGate(userId, gate.gateId, 'allowed', 'security-operator');
  expect(decided?.status).toBe('allowed');

  // Verifies child was automatically unpaused
  const resumedChild = getSandbox(userId, secChild.id);
  expect(resumedChild?.status).toBe('running');

  // 7. Agent Steering: Subtree Directive
  const steerResult = steerAgent(userId, root.id, 'Prioritize token signature validation', 'subtree');
  expect(steerResult.affectedSandboxIds).toContain(root.id);
  expect(steerResult.affectedSandboxIds).toContain(secChild.id);

  // 8. Workflow Concurrency Semaphore: maxConcurrency 4
  const wfBefore = getWorkflowState(userId);
  expect(wfBefore.maxConcurrency).toBe(4);

  const enqueued = enqueueWorkflowJob(userId, 'Security_Vulnerability_Scan', 'Step 2/2');
  expect(enqueued).toBeDefined();

  const flushRes = flushWorkflowPipeline(userId);
  expect(flushRes.flushedCount).toBeGreaterThanOrEqual(0);

  // 9. Immutable Checkpoint committed to SQLite Ledger
  const cpTag = await checkpointSandbox(userId, root.id, 'cp_0145');
  expect(cpTag).toBe('cp_0145');

  // Check ledger record
  const ledgerRows = db.query(`SELECT * FROM ledger WHERE user_id = ? AND sandbox_id = ? AND type = 'checkpoint'`).all(userId, root.id) as any[];
  expect(ledgerRows.length).toBeGreaterThanOrEqual(1);

  // 10. OneCLI Command Execution
  const cliStatus = await executeOneCliCommand(userId, 'alineo status');
  expect(cliStatus.exitCode).toBe(0);
  expect(cliStatus.output).toContain('Alineo Swarm Fleet Status');

  const cliRecall = await executeOneCliCommand(userId, 'alineo memory recall "jwt"');
  expect(cliRecall.exitCode).toBe(0);
  expect(cliRecall.output).toContain('Recall results');
});
