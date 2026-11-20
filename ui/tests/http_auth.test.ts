import { test, expect } from "bun:test";
import server from "../server/index";

const BASE_URL = `http://localhost:${server.port}`;

test("HTTP Auth & Multitenant Endpoint Verification", async () => {
  // 1. Unauthenticated request to protected endpoint fails with 401
  const unauthRes = await fetch(`${BASE_URL}/api/status`);
  expect(unauthRes.status).toBe(401);
  const unauthBody = await unauthRes.json();
  expect(unauthBody.error).toContain("Unauthorized");

  // 2. Health check is public
  const healthRes = await fetch(`${BASE_URL}/health`);
  expect(healthRes.status).toBe(200);

  // 3. Login with test / Test@123
  const loginRes1 = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernameOrEmail: "test", password: "Test@123" }),
  });
  expect(loginRes1.status).toBe(200);
  const data1 = await loginRes1.json();
  expect(data1.token).toBeDefined();
  expect(data1.user.username).toBe("test");

  // 4. Authorized request using token succeeds
  const statusRes = await fetch(`${BASE_URL}/api/status`, {
    headers: { Authorization: `Bearer ${data1.token}` },
  });
  expect(statusRes.status).toBe(200);
  const statusBody = await statusRes.json();
  expect(statusBody.user.id).toBe("usr_test");
  expect(statusBody.fleet.total).toBeGreaterThanOrEqual(1);

  // 5. Login with test / 122334
  const loginRes2 = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernameOrEmail: "test", password: "122334" }),
  });
  expect(loginRes2.status).toBe(200);

  // 6. Signup a new user
  const newUsername = "user_" + Math.random().toString(36).substring(2, 7);
  const signupRes = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: newUsername,
      email: `${newUsername}@network.ai`,
      password: "TestPassWord99#",
      displayName: "Network Operator",
    }),
  });
  expect(signupRes.status).toBe(201);
  const signupData = await signupRes.json();
  expect(signupData.token).toBeDefined();
  expect(signupData.user.username).toBe(newUsername);

  // 7. Verify new user starts with a clean blank dashboard (0 sandboxes)
  const newUserSandboxesRes = await fetch(`${BASE_URL}/api/sandboxes`, {
    headers: { Authorization: `Bearer ${signupData.token}` },
  });
  expect(newUserSandboxesRes.status).toBe(200);
  const newUserSandboxes = await newUserSandboxesRes.json();
  expect(newUserSandboxes.length).toBe(0); // Brand new user has blank dashboard

  // New user spawns their own sandbox
  const spawnRes = await fetch(`${BASE_URL}/api/sandboxes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signupData.token}`,
    },
    body: JSON.stringify({ role: "custom-worker", cpuLimitMilli: 250, memLimitMi: 256 }),
  });
  expect(spawnRes.status).toBe(201);
  const spawnedSb = await spawnRes.json();
  expect(spawnedSb.userId).toBe(signupData.user.id);

  const testSandboxesRes = await fetch(`${BASE_URL}/api/sandboxes`, {
    headers: { Authorization: `Bearer ${data1.token}` },
  });
  const testSandboxes = await testSandboxesRes.json();
  expect(testSandboxes.every((s: any) => s.userId === "usr_test")).toBe(true);
  expect(spawnedSb.id).not.toBe(testSandboxes[0].id);

  // 8. Logout
  const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${data1.token}` },
  });
  expect(logoutRes.status).toBe(200);

  // After logout, token is revoked
  const afterLogout = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${data1.token}` },
  });
  expect(afterLogout.status).toBe(401);
});
