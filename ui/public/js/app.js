import { api } from './api.js';
import { renderTopologyGraph } from './topology.js';
import { renderTimelineScrubber } from './scrubber.js';
import { renderWorkingMemoryTable, renderEpisodicTree, renderSemanticFactsList } from './memory-view.js';
import { setupOneCliModal } from './onecli.js';

// =========================================================
// AUTH GUARD
// =========================================================
const TOKEN_KEY = 'aln_token';

async function guardAuth() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    window.location.href = '/login';
    return false;
  }

  try {
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      localStorage.removeItem(TOKEN_KEY);
      window.location.href = '/login';
      return false;
    }
    const { user } = await res.json();
    const initial = (user.username || user.email || '?')[0].toUpperCase();
    const avatarEl = document.getElementById('user-avatar');
    const sidebarEl = document.getElementById('sidebar-username');
    const headerEl = document.getElementById('header-username');
    if (avatarEl) avatarEl.textContent = initial;
    if (sidebarEl) sidebarEl.textContent = user.username || user.email;
    if (headerEl) headerEl.textContent = user.username || user.email;
    return true;
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = '/login';
    return false;
  }
}

window.handleLogout = async function () {
  try {
    await api.logout();
  } catch {}
  localStorage.removeItem(TOKEN_KEY);
  window.location.href = '/login';
};

// =========================================================
// APPLICATION STATE
// =========================================================
const state = {
  currentSection: 'overview',
  topoFilter: 'all',
  sandboxFilter: 'all',
  sandboxes: [],
  selectedSandboxId: null,
  ledgerEvents: [],
  selectedSeq: null,
  workingMemory: [],
  episodicMemory: [],
  semanticFacts: [],
  egressGates: [],
  workflowState: null,
  status: null,
  activeDrawerSandboxId: null,
};

// =========================================================
// TOAST NOTIFICATIONS
// =========================================================
function showToast(message, type = 'info') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  const bg = type === 'error' ? 'bg-rose-900 border-rose-700 text-white' : 'bg-[#18181B] border-[#27272A] text-white';
  toast.className = `toast px-4 py-2.5 rounded-[5px] border shadow-lg text-[12px] font-mono flex items-center justify-between gap-3 pointer-events-auto transition-all ${bg}`;
  toast.innerHTML = `<span>${message}</span><button class="text-[#A1A1AA] hover:text-white" onclick="this.parentElement.remove()">✕</button>`;
  root.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 250); }, 3500);
}

// =========================================================
// NAVIGATION
// =========================================================
const NAV_SECTIONS = ['overview', 'sandboxes', 'ledger', 'memory', 'security', 'runner', 'mcp'];
const SECTION_TITLES = {
  overview: 'Overview',
  sandboxes: 'Sandboxes Fleet',
  ledger: 'Audit & Replay',
  memory: 'Memory Core',
  security: 'Security & Perimeter',
  runner: 'Alineo Runner',
  mcp: 'MCP Connector'
};

window.switchSection = function (name) {
  state.currentSection = name;

  NAV_SECTIONS.forEach(s => {
    const btn = document.getElementById(`nav-${s}`);
    const sec = document.getElementById(`section-${s}`);
    if (!btn || !sec) return;

    const isActive = s === name;
    sec.classList.toggle('hidden', !isActive);
    if (s === 'overview') sec.classList.toggle('flex-1', isActive);

    if (isActive) {
      btn.classList.add('nav-active');
      btn.classList.remove('text-[#52525B]', 'hover:text-[#18181B]', 'hover:bg-[#F4F4F5]');
    } else {
      btn.classList.remove('nav-active');
      btn.classList.add('text-[#52525B]', 'hover:text-[#18181B]', 'hover:bg-[#F4F4F5]');
    }
  });

  const title = document.getElementById('header-page-title');
  if (title) title.textContent = SECTION_TITLES[name] || name;

  if (name === 'memory') renderMemorySection();
};

// =========================================================
// ALINEO RUNNER
// =========================================================
window.setAndRunCli = function (cmd) {
  const input = document.getElementById('runner-cli-input');
  if (input) input.value = cmd;
  executeCli(cmd);
};

window.handleRunnerSubmit = function (e) {
  e.preventDefault();
  const input = document.getElementById('runner-cli-input');
  if (!input) return;
  const cmd = input.value.trim();
  if (cmd) executeCli(cmd);
};

async function executeCli(cmd) {
  const outputEl = document.getElementById('runner-terminal-output');
  if (!outputEl) return;

  outputEl.innerHTML += `<div class="pt-2 text-emerald-400 font-bold">$ ${cmd}</div><div class="text-[#71717A] text-[11px]">Running...</div>`;
  outputEl.scrollTop = outputEl.scrollHeight;

  try {
    const res = await api.runCliCommand(cmd);
    outputEl.innerHTML += `
      <div class="p-2.5 rounded-[4px] bg-[#27272A] border border-[#3F3F46] my-1.5 space-y-1">
        <div class="flex items-center justify-between text-[10.5px] text-[#A1A1AA] pb-1 border-b border-[#3F3F46]">
          <span>duration: ${res.durationMs}ms</span>
          <span class="${res.exitCode === 0 ? 'text-emerald-400' : 'text-rose-400'}">exit=${res.exitCode}</span>
        </div>
        <pre class="text-[#F4F4F5] text-[11px] whitespace-pre-wrap leading-relaxed">${res.output}</pre>
      </div>`;
    outputEl.scrollTop = outputEl.scrollHeight;
    await refreshAllData();
  } catch (err) {
    outputEl.innerHTML += `<div class="text-rose-400 py-1">Error: ${err.message}</div>`;
    outputEl.scrollTop = outputEl.scrollHeight;
  }
}

// =========================================================
// MCP CONNECTOR (CONNECT TO CLAUDE)
// =========================================================
const MCP_CONFIGS = {
  windows: {
    path: '%APPDATA%\\Claude\\claude_desktop_config.json',
    code: `{
  "mcpServers": {
    "alineo-control-plane": {
      "command": "bunx",
      "args": ["alineo-cli", "mcp", "--port", "4600"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "<YOUR_TOKEN>"
      }
    }
  }
}`
  },
  macos: {
    path: '~/Library/Application Support/Claude/claude_desktop_config.json',
    code: `{
  "mcpServers": {
    "alineo-control-plane": {
      "command": "bunx",
      "args": ["alineo-cli", "mcp", "--port", "4600"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "<YOUR_TOKEN>"
      }
    }
  }
}`
  },
  claudecode: {
    path: 'Terminal command for Claude Code CLI',
    code: `# Run this single command in your terminal to connect Claude Code to Alineo:
claude mcp add alineo -- bunx alineo-cli mcp --port 4600`
  }
};

window.setMcpOsTab = function (os) {
  ['win', 'mac', 'cli'].forEach(k => {
    const btn = document.getElementById(`mcp-tab-${k}`);
    if (btn) {
      const match = (k === 'win' && os === 'windows') || (k === 'mac' && os === 'macos') || (k === 'cli' && os === 'claudecode');
      btn.className = match ? 'px-2 py-0.5 rounded-[3px] bg-[#18181B] text-white' : 'px-2 py-0.5 rounded-[3px] text-[#71717A] hover:text-[#18181B]';
    }
  });

  const cfg = MCP_CONFIGS[os] || MCP_CONFIGS.windows;
  const pathEl = document.getElementById('mcp-config-path');
  const previewEl = document.getElementById('mcp-json-preview');
  if (pathEl) pathEl.textContent = cfg.path;
  if (previewEl) previewEl.textContent = cfg.code;
};

window.copyMcpConfigSnippet = function () {
  const previewEl = document.getElementById('mcp-json-preview');
  if (!previewEl) return;
  navigator.clipboard.writeText(previewEl.textContent).then(() => {
    showToast('MCP Configuration copied to clipboard!');
  }).catch(() => {
    showToast('Config copied');
  });
};

window.testMcpTool = async function (toolType) {
  try {
    showToast(`Simulating MCP call: alineo_${toolType}...`);
    if (toolType === 'spawn') {
      const res = await api.spawnSandbox({ role: 'mcp-claude-agent', cpuLimitMilli: 250, memLimitMi: 256, mcpTools: ['GitHub'] });
      showToast(`Spawned sandbox ${res.id} from Claude MCP call!`);
    } else if (toolType === 'exec') {
      const firstSb = state.sandboxes[0]?.id;
      if (!firstSb) throw new Error('No sandbox available. Spawn one first!');
      const res = await api.execInSandbox(firstSb, 'echo "Hello from Claude MCP bridge"');
      showToast(`Exec output: ${res.stdout || 'OK'}`);
    } else if (toolType === 'checkpoint') {
      const firstSb = state.sandboxes[0]?.id;
      if (!firstSb) throw new Error('No sandbox available. Spawn one first!');
      const res = await api.checkpointSandbox(firstSb, `mcp_cp_${Date.now().toString(36)}`);
      showToast(`Saved checkpoint: ${res.checkpointId}`);
    } else if (toolType === 'steer') {
      const firstSb = state.sandboxes[0]?.id;
      if (!firstSb) throw new Error('No sandbox available. Spawn one first!');
      await api.steerAgent(firstSb, 'Claude directive: prioritize security audit', 'single');
      showToast('Steer directive sent via MCP');
    } else if (toolType === 'memory') {
      const facts = await api.getSemanticFacts('security', 2);
      showToast(`Recalled ${facts.length} memory facts via MCP`);
    } else if (toolType === 'egress') {
      const gates = await api.listEgressGates();
      showToast(`${gates.length} egress policies verified via MCP`);
    }
    await refreshAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// =========================================================
// DATA REFRESH & DISPATCH
// =========================================================
async function refreshAllData() {
  try {
    const [status, sandboxes, ledger, egress, workflows] = await Promise.all([
      api.getStatus(),
      api.listSandboxes(),
      api.listLedger(),
      api.listEgressGates(),
      api.getWorkflowState(),
    ]);

    state.status = status;
    state.sandboxes = sandboxes;
    state.ledgerEvents = ledger;
    state.egressGates = egress;
    state.workflowState = workflows;

    if (!state.selectedSandboxId && sandboxes.length > 0) {
      state.selectedSandboxId = sandboxes[0].id;
    }
    if (!state.selectedSeq && ledger.length > 0) {
      state.selectedSeq = ledger[ledger.length - 1].seq;
    }

    renderOverview();
    renderSandboxesTable();
    renderLedger();
    renderSecurityView();
    renderWorkflowsView();
    renderVaultCredentials();
    updateNavBadges();
  } catch (err) {
    console.warn('Refresh error:', err);
  }
}

function updateNavBadges() {
  const sbCount = document.getElementById('nav-sb-count');
  const sbBadge = document.getElementById('nav-sb-badge');
  const ledgerCount = document.getElementById('nav-ledger-count');
  const approvalBadge = document.getElementById('nav-approval-badge');

  if (sbCount) sbCount.textContent = state.sandboxes.length > 0 ? state.sandboxes.length : '';
  if (sbBadge) sbBadge.textContent = state.sandboxes.length > 0 ? state.sandboxes.length : '';
  if (ledgerCount) ledgerCount.textContent = state.ledgerEvents.length > 0 ? state.ledgerEvents.length : '';

  const pendingGates = state.egressGates.filter(g => g.status === 'pending').length;
  if (approvalBadge) {
    if (pendingGates > 0) {
      approvalBadge.textContent = pendingGates;
      approvalBadge.classList.remove('hidden');
    } else {
      approvalBadge.classList.add('hidden');
    }
  }
}

// =========================================================
// VIEW 1: OVERVIEW
// =========================================================
function renderOverview() {
  const svgEl = document.getElementById('overview-topology-svg');
  if (svgEl) {
    renderTopologyGraph(svgEl, state.sandboxes, state.selectedSandboxId, (id) => {
      state.selectedSandboxId = id;
      renderOverview();
    }, state.topoFilter);
  }

  const inspectorEl = document.getElementById('overview-node-inspector');
  if (!inspectorEl) return;

  const sb = state.sandboxes.find(s => s.id === state.selectedSandboxId) || state.sandboxes[0];

  if (!sb) {
    inspectorEl.innerHTML = `
      <div class="flex-1 flex items-center justify-center p-8 text-center">
        <div>
          <svg class="w-10 h-10 text-[#E4E4E7] mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <p class="text-[13px] font-medium text-[#71717A]">No sandbox deployed</p>
          <p class="text-[12px] text-[#A1A1AA] mt-1">Spawn a sandbox to start executing agents in isolation.</p>
          <button onclick="openLaunchModal()" class="mt-4 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[5px] bg-[#18181B] hover:bg-[#27272A] text-white text-[12px] font-medium">+ Spawn Sandbox</button>
          <button onclick="openDemoModal()" class="mt-3 block mx-auto text-[11px] text-[#71717A] hover:text-[#18181B] font-mono underline">or run sample PR #418 swarm</button>
        </div>
      </div>`;
    return;
  }

  const isRunning = sb.status === 'running';
  const isPaused = sb.status === 'paused';
  const statusColor = isRunning ? 'bg-emerald-600' : (isPaused ? 'bg-amber-500' : 'bg-gray-400');
  const statusBadge = isRunning
    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
    : (isPaused ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-gray-50 text-gray-600 border border-gray-200');

  const recentExecs = sb.recentExecs || [];
  const execRows = recentExecs.length > 0
    ? recentExecs.map(e => `
        <div class="flex items-start gap-3 py-2 border-b border-[#F4F4F5] last:border-0">
          <span class="font-mono text-[10px] text-[#A1A1AA] shrink-0 pt-0.5">${e.ts}</span>
          <span class="font-mono text-[11px] text-[#18181B] flex-1 truncate">$ ${e.cmd}</span>
          <span class="font-mono text-[10px] ${e.exitCode === 0 ? 'text-emerald-600' : 'text-rose-600'} shrink-0">exit:${e.exitCode}</span>
        </div>`).join('')
    : `<p class="text-[12px] text-[#A1A1AA] font-mono py-4 text-center">No executions yet.</p>`;

  const mcpBadges = (sb.mcpTools || []).map(t =>
    `<span class="px-2 py-0.5 rounded-[3px] bg-white border border-[#E4E4E7] font-mono text-[10px] text-[#18181B] font-medium">${t}</span>`
  ).join('');

  const cpuPct = Math.min(100, Math.round((sb.cpuCurrentMilli / sb.cpuLimitMilli) * 100));
  const memPct = Math.min(100, Math.round((sb.memCurrentMi / sb.memLimitMi) * 100));

  inspectorEl.innerHTML = `
    <div class="p-5 border-b border-[#E4E4E7] space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <span class="w-2.5 h-2.5 rounded-full ${statusColor} status-pulse"></span>
          <h3 class="font-mono font-bold text-[15px] text-[#18181B]">${sb.id}</h3>
          <span class="px-2 py-0.5 rounded-[3px] font-mono text-[10px] ${statusBadge}">${sb.status}</span>
        </div>
        <button id="btn-inspect-attach" onclick="openAttachDrawer('${sb.id}')"
          class="px-3 py-1.5 rounded-[4px] bg-[#18181B] hover:bg-[#27272A] text-white font-mono text-[11px] font-medium">
          Attach →
        </button>
      </div>

      <div class="p-3.5 rounded-[5px] bg-[#FAFAFA] border border-[#E4E4E7] space-y-1.5">
        <div class="text-[11px] font-semibold text-[#18181B] uppercase tracking-wider font-mono">Assigned Mission</div>
        <p class="text-[12.5px] text-[#27272A] leading-relaxed">${sb.summary || 'No mission description.'}</p>
        <div class="pt-2 flex items-center gap-4 text-[11px] font-mono text-[#71717A] flex-wrap">
          <span>Uptime: <strong class="text-[#18181B]">${sb.uptime}</strong></span>
          <span>Policy: <strong class="text-emerald-700">${sb.egressPolicy}</strong></span>
          <span>Model: <strong class="text-indigo-600 font-medium">${sb.modelProvider || 'claude-3-5-sonnet'}</strong></span>
        </div>
      </div>

      <div class="space-y-2 font-mono text-[11px]">
        <div class="flex items-center justify-between text-[#71717A]">
          <span>CPU: ${sb.cpuCurrentMilli}m / ${sb.cpuLimitMilli}m</span><span>${cpuPct}%</span>
        </div>
        <div class="w-full h-1.5 rounded-full bg-[#F4F4F5] overflow-hidden">
          <div class="h-full bg-emerald-600" style="width:${cpuPct}%"></div>
        </div>
        <div class="flex items-center justify-between text-[#71717A] pt-1">
          <span>Memory: ${sb.memCurrentMi}Mi / ${sb.memLimitMi}Mi</span><span>${memPct}%</span>
        </div>
        <div class="w-full h-1.5 rounded-full bg-[#F4F4F5] overflow-hidden">
          <div class="h-full bg-sky-600" style="width:${memPct}%"></div>
        </div>
      </div>

      ${mcpBadges ? `<div class="flex items-center gap-2 flex-wrap">
        <span class="font-mono text-[10.5px] text-[#71717A]">MCP Tools:</span>${mcpBadges}
      </div>` : ''}
    </div>

    <div class="p-5 flex-1 overflow-y-auto space-y-3">
      <div class="flex items-center justify-between">
        <span class="font-mono text-[11px] font-semibold text-[#18181B]">Exec Ledger</span>
        <span class="font-mono text-[10px] text-[#A1A1AA]">${recentExecs.length} executions</span>
      </div>
      <div class="space-y-0">${execRows}</div>
    </div>

    <div class="p-4 border-t border-[#E4E4E7] flex flex-wrap gap-2">
      <button onclick="pauseResumeAction('${sb.id}', '${sb.status}')"
        class="flex-1 py-1.5 rounded-[4px] border border-[#E4E4E7] hover:border-[#D4D4D8] text-[#18181B] font-mono text-[11px] font-medium">
        ${isRunning ? 'Pause' : 'Resume'}
      </button>
      <button onclick="terminateSandboxAction('${sb.id}')"
        class="px-3 py-1.5 rounded-[4px] border border-rose-200 text-rose-700 hover:bg-rose-50 font-mono text-[11px] font-medium">
        Terminate
      </button>
    </div>`;

  // Egress banner
  const banner = document.getElementById('overview-egress-banner');
  if (banner) {
    const pending = state.egressGates.filter(g => g.status === 'pending');
    if (pending.length > 0) {
      banner.classList.remove('hidden');
      banner.innerHTML = `
        <div class="flex items-center gap-3">
          <span class="w-2 h-2 rounded-full bg-amber-500 status-pulse shrink-0"></span>
          <span class="text-[12.5px] font-medium text-[#18181B]">${pending.length} pending egress approval${pending.length > 1 ? 's' : ''}</span>
        </div>
        <div class="flex gap-2">
          ${pending.slice(0, 2).map(g => `
            <div class="flex items-center gap-2 font-mono text-[11px]">
              <span class="text-[#71717A]">${g.targetHost}</span>
              <button onclick="decideEgress('${g.gateId}','allowed')" class="px-2 py-0.5 rounded-[3px] bg-emerald-600 text-white font-medium">Allow</button>
              <button onclick="decideEgress('${g.gateId}','denied')" class="px-2 py-0.5 rounded-[3px] bg-rose-600 text-white font-medium">Deny</button>
            </div>`).join('')}
          <button onclick="switchSection('security')" class="text-[11px] font-mono text-[#71717A] hover:text-[#18181B]">View all →</button>
        </div>`;
    } else {
      banner.classList.add('hidden');
    }
  }
}

// =========================================================
// VIEW 2: SANDBOXES TABLE
// =========================================================
function renderSandboxesTable() {
  const tbody = document.getElementById('full-sandboxes-tbody');
  if (!tbody) return;

  const filtered = state.sandboxFilter === 'all'
    ? state.sandboxes
    : state.sandboxes.filter(s => s.status === state.sandboxFilter);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-16 text-center">
      <div class="flex flex-col items-center gap-3">
        <svg class="w-8 h-8 text-[#E4E4E7]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
        <p class="text-[13px] font-medium text-[#71717A]">${state.sandboxFilter !== 'all' ? 'No ' + state.sandboxFilter + ' sandboxes' : 'No sandboxes yet'}</p>
        ${state.sandboxFilter === 'all' ? `<button onclick="openLaunchModal()" class="mt-1 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[5px] bg-[#18181B] hover:bg-[#27272A] text-white text-[12px] font-medium">+ Spawn Sandbox</button>` : ''}
      </div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(sb => {
    const statusColor = sb.status === 'running' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : (sb.status === 'paused' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-50 text-gray-600 border-gray-200');
    const cpuPct = Math.min(100, Math.round((sb.cpuCurrentMilli / sb.cpuLimitMilli) * 100));
    const memPct = Math.min(100, Math.round((sb.memCurrentMi / sb.memLimitMi) * 100));
    return `<tr class="hover:bg-[#FAFAFA] transition-colors cursor-pointer" onclick="state.selectedSandboxId='${sb.id}'; switchSection('overview'); renderOverview();">
      <td class="py-3.5 px-5">
        <div class="font-mono text-[12px] font-semibold text-[#18181B]">${sb.id}</div>
        <div class="text-[11px] text-[#71717A] mt-0.5 truncate max-w-[240px] flex items-center gap-1.5">
          <span>${sb.role}</span>
          <span class="px-1.5 py-0.2 rounded bg-slate-100 text-slate-700 font-mono text-[9.5px] border border-slate-200">${sb.modelProvider || 'claude-3-5-sonnet'}</span>
        </div>
      </td>
      <td class="py-3.5 px-4">
        <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] border font-mono text-[10.5px] ${statusColor}">
          <span class="w-1.5 h-1.5 rounded-full ${sb.status === 'running' ? 'bg-emerald-600' : (sb.status === 'paused' ? 'bg-amber-500' : 'bg-gray-400')}"></span>
          ${sb.status}
        </span>
      </td>
      <td class="py-3.5 px-4">
        <div class="font-mono text-[11px] text-[#52525B]">CPU ${cpuPct}% · Mem ${memPct}%</div>
        <div class="font-mono text-[10.5px] text-[#A1A1AA]">${sb.cpuLimitMilli}m · ${sb.memLimitMi}Mi</div>
      </td>
      <td class="py-3.5 px-4">
        <div class="flex flex-wrap gap-1">${(sb.mcpTools || []).map(t => `<span class="px-1.5 py-0.5 bg-[#F4F4F5] border border-[#E4E4E7] rounded-[3px] font-mono text-[10px]">${t}</span>`).join('')}</div>
      </td>
      <td class="py-3.5 px-5 text-right">
        <div class="flex items-center justify-end gap-1.5" onclick="event.stopPropagation()">
          <button onclick="pauseResumeAction('${sb.id}','${sb.status}')" class="px-2 py-1 rounded-[3px] bg-white hover:bg-[#FAFAFA] border border-[#E4E4E7] font-mono text-[10.5px]">${sb.status === 'running' ? 'Pause' : 'Resume'}</button>
          <button onclick="openAttachDrawer('${sb.id}')" class="px-2 py-1 rounded-[3px] bg-white hover:bg-[#FAFAFA] border border-[#E4E4E7] font-mono text-[10.5px]">Attach</button>
          <button onclick="terminateSandboxAction('${sb.id}')" class="px-2 py-1 rounded-[3px] border border-rose-200 text-rose-700 hover:bg-rose-50 font-mono text-[10.5px]">×</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// =========================================================
// VIEW 3: LEDGER
// =========================================================
function renderLedger() {
  const tbody = document.getElementById('full-ledger-tbody');
  if (!tbody) return;

  const filter = document.getElementById('ledger-type-filter')?.value || 'all';
  const events = filter === 'all' ? state.ledgerEvents : state.ledgerEvents.filter(e => e.type === filter);

  if (events.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-12 text-center text-[12px] text-[#A1A1AA] font-mono">No audit events yet.</td></tr>`;
    renderTimelineScrubber(document.getElementById('timeline-scrubber-svg'), [], null, () => {});
    return;
  }

  renderTimelineScrubber(document.getElementById('timeline-scrubber-svg'), events, state.selectedSeq, (seq) => {
    state.selectedSeq = seq;
    updateTimelineInspector(seq);
  });

  tbody.innerHTML = events.slice().reverse().slice(0, 50).map(e => {
    const typeColor = e.type === 'exec_start' ? 'text-sky-700 bg-sky-50 border-sky-200'
      : e.type === 'exec_complete' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : e.type === 'checkpoint' ? 'text-[#52525B] bg-[#F4F4F5] border-[#E4E4E7]'
      : 'text-amber-700 bg-amber-50 border-amber-200';
    return `<tr class="hover:bg-[#FAFAFA]">
      <td class="py-3 px-5 font-mono text-[11px] text-[#52525B]">${new Date(e.ts).toLocaleTimeString()}</td>
      <td class="py-3 px-4"><span class="px-2 py-0.5 rounded-[4px] border font-mono text-[10px] ${typeColor}">${e.type}</span></td>
      <td class="py-3 px-4 font-mono text-[11px] text-[#52525B]">${e.sandboxId || '—'}</td>
      <td class="py-3 px-4 text-[12px] text-[#52525B] truncate max-w-[260px]">${e.summary || e.payload || '—'}</td>
      <td class="py-3 px-5 text-right">
        <button onclick="replayFromSeq(${e.seq})" class="font-mono text-[10.5px] text-[#71717A] hover:text-[#18181B]">Replay</button>
      </td>
    </tr>`;
  }).join('');
}

function updateTimelineInspector(seq) {
  const el = document.getElementById('timeline-node-inspector');
  if (!el) return;
  const event = state.ledgerEvents.find(e => e.seq === seq);
  if (!event) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="font-mono text-[11px] space-y-1">
    <div class="flex gap-4">
      <span class="text-[#71717A]">seq:</span><span class="text-[#18181B] font-semibold">${event.seq}</span>
      <span class="text-[#71717A]">type:</span><span class="text-[#18181B]">${event.type}</span>
      <span class="text-[#71717A]">sandbox:</span><span class="text-[#18181B]">${event.sandboxId || '—'}</span>
    </div>
    <div class="text-[#52525B]">${event.summary || event.payload || ''}</div>
  </div>`;
}

// =========================================================
// VIEW 4: MEMORY CORE
// =========================================================
async function renderMemorySection() {
  try {
    const [wm, ep, sf] = await Promise.all([
      api.getWorkingMemory(),
      api.getEpisodicMemory(),
      api.getSemanticFacts(),
    ]);
    state.workingMemory = wm;
    state.episodicMemory = ep;
    state.semanticFacts = sf;

    const wmEl = document.getElementById('working-memory-container');
    const epEl = document.getElementById('episodic-memory-container');
    const sfEl = document.getElementById('semantic-facts-container');
    const wmCount = document.getElementById('wm-count');
    const epCount = document.getElementById('ep-count');
    const sfCount = document.getElementById('sf-count');

    if (wmCount) wmCount.textContent = `${wm.length} entries`;
    if (epCount) epCount.textContent = `${ep.length} entries`;
    if (sfCount) sfCount.textContent = `${sf.length} facts`;

    if (wmEl) {
      if (wm.length === 0) {
        wmEl.innerHTML = `<p class="text-[12px] text-[#A1A1AA] font-mono text-center">Empty. Activate sandboxes to populate working memory.</p>`;
      } else {
        renderWorkingMemoryTable(wmEl, wm);
      }
    }
    if (epEl) {
      if (ep.length === 0) {
        epEl.innerHTML = `<p class="text-[12px] text-[#A1A1AA] font-mono text-center">No episodes recorded yet.</p>`;
      } else {
        renderEpisodicTree(epEl, ep);
      }
    }
    if (sfEl) {
      if (sf.length === 0) {
        sfEl.innerHTML = `<p class="text-[12px] text-[#A1A1AA] font-mono text-center">No semantic facts stored.</p>`;
      } else {
        renderSemanticFactsList(sfEl, sf);
      }
    }
  } catch (err) {
    console.warn('Memory render error:', err);
  }
}

window.searchSemanticFacts = async function () {
  const query = document.getElementById('semantic-query-input')?.value?.trim();
  if (!query) return;
  try {
    const facts = await api.searchSemanticFacts(query);
    const sfEl = document.getElementById('semantic-facts-container');
    if (sfEl) {
      if (facts.length === 0) {
        sfEl.innerHTML = `<p class="text-[12px] text-[#A1A1AA] font-mono text-center">No results for "${query}"</p>`;
      } else {
        renderSemanticFactsList(sfEl, facts);
      }
    }
  } catch (err) {
    showToast('Search failed: ' + err.message, 'error');
  }
};

window.compactMemoryAction = async function () {
  try {
    await api.compactMemory();
    showToast('Memory compacted');
    if (state.currentSection === 'memory') renderMemorySection();
  } catch (err) {
    showToast('Compact failed: ' + err.message, 'error');
  }
};

// =========================================================
// VIEW 5: SECURITY
// =========================================================
function renderSecurityView() {
  renderVaultCredentials();
  const listEl = document.getElementById('full-egress-list');
  if (!listEl) return;

  if (state.egressGates.length === 0) {
    listEl.innerHTML = `<div class="col-span-3 py-10 text-center text-[12px] text-[#A1A1AA] font-mono">No egress gates configured.</div>`;
  } else {
    listEl.innerHTML = state.egressGates.map(g => {
      const badgeColor = g.status === 'allowed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
        : g.status === 'pending' ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-rose-50 text-rose-700 border-rose-200';
      return `<div class="p-5 space-y-3">
        <div class="flex items-center justify-between">
          <span class="font-mono text-[11px] font-semibold text-[#18181B]">${g.targetHost}</span>
          <span class="px-2 py-0.5 rounded-[4px] border font-mono text-[10px] ${badgeColor}">${g.status}</span>
        </div>
        <div class="font-mono text-[10.5px] text-[#71717A] space-y-1">
          <div>Protocol: <span class="text-[#18181B]">${g.protocol}</span></div>
          <div class="truncate">Sandbox: <span class="text-[#18181B]">${g.sandboxId}</span></div>
          ${g.reason ? `<div class="text-[10px] text-[#A1A1AA] truncate">${g.reason}</div>` : ''}
        </div>
        ${g.status === 'pending' ? `<div class="flex gap-2">
          <button onclick="decideEgress('${g.gateId}','allowed')" class="flex-1 py-1 rounded-[4px] bg-emerald-600 hover:bg-emerald-700 text-white font-mono text-[10.5px] font-medium">Allow</button>
          <button onclick="decideEgress('${g.gateId}','denied')" class="flex-1 py-1 rounded-[4px] bg-rose-600 hover:bg-rose-700 text-white font-mono text-[10.5px] font-medium">Deny</button>
        </div>` : ''}
      </div>`;
    }).join('');
  }
}

function renderWorkflowsView() {
  const slotsEl = document.getElementById('wf-semaphore-slots');
  const statusEl = document.getElementById('workflow-flush-status');
  if (!slotsEl || !state.workflowState) return;

  const wf = state.workflowState;
  const maxConcurrency = 4;
  const slots = Array.from({ length: maxConcurrency }, (_, i) => {
    const job = (wf.activeJobs || [])[i];
    if (job) {
      return `<div class="p-3 rounded-[4px] border border-sky-200 bg-sky-50">
        <div class="font-mono text-[10px] text-sky-600 font-semibold">ACTIVE</div>
        <div class="font-mono text-[11px] text-[#18181B] mt-1 truncate">${job.name || 'job_' + i}</div>
      </div>`;
    } else {
      return `<div class="p-3 rounded-[4px] border border-dashed border-[#E4E4E7] bg-white">
        <div class="font-mono text-[10px] text-[#A1A1AA]">open slot</div>
      </div>`;
    }
  });
  slotsEl.innerHTML = slots.join('');

  if (statusEl) {
    const active = wf.activeCount || 0;
    const queued = wf.queuedCount || 0;
    const open = Math.max(0, maxConcurrency - active);
    statusEl.textContent = `${active} active · ${queued} queued · ${open} open slot${open !== 1 ? 's' : ''}`;
  }
}

// =========================================================
// SANDBOX ACTIONS
// =========================================================
window.pauseResumeAction = async function (id, status) {
  try {
    if (status === 'running') {
      await api.pauseSandbox(id);
      showToast(`Paused ${id}`);
    } else {
      await api.resumeSandbox(id);
      showToast(`Resumed ${id}`);
    }
    await refreshAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.terminateSandboxAction = async function (id) {
  if (!confirm(`Terminate ${id}? This cannot be undone.`)) return;
  try {
    await api.terminateSandbox(id);
    if (state.selectedSandboxId === id) state.selectedSandboxId = null;
    showToast(`Terminated ${id}`);
    await refreshAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.forkSandbox = async function (id) {
  if (!id) { showToast('Select a sandbox first', 'error'); return; }
  try {
    const child = await api.forkSandbox(id);
    showToast(`Forked → ${child.id}`);
    await refreshAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.checkpointSandboxAction = async function (id) {
  if (!id) { showToast('Select a sandbox first', 'error'); return; }
  try {
    const tag = `cp_${Date.now().toString(36)}`;
    await api.checkpointSandbox(id, tag);
    showToast(`Checkpoint ${tag} saved`);
    await refreshAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// =========================================================
// EGRESS DECISIONS
// =========================================================
window.decideEgress = async function (gateId, decision) {
  try {
    await api.decideEgressGate(gateId, decision);
    showToast(`Egress ${decision}`);
    await refreshAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// =========================================================
// ATTACH DRAWER
// =========================================================
window.openAttachDrawer = function (id) {
  state.activeDrawerSandboxId = id;
  const sb = state.sandboxes.find(s => s.id === id);
  const drawer = document.getElementById('attach-drawer');
  const title = document.getElementById('drawer-sandbox-title');
  const metaSpecs = document.getElementById('drawer-meta-specs');
  const statusPill = document.getElementById('drawer-status-pill');
  const log = document.getElementById('drawer-terminal-log');

  if (!drawer) return;
  drawer.classList.remove('hidden');
  drawer.classList.add('flex');

  if (sb) {
    if (title) title.textContent = sb.id;
    if (metaSpecs) metaSpecs.textContent = `cpu: ${sb.cpuLimitMilli}m · mem: ${sb.memLimitMi}Mi · ${sb.checkpointId || 'no checkpoint'}`;
    if (statusPill) {
      statusPill.textContent = sb.status;
      statusPill.className = `px-1.5 py-0.5 rounded-[4px] font-mono text-[10px] border ${sb.status === 'running' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`;
    }
  }
  if (log) {
    const execs = sb?.recentExecs || [];
    log.innerHTML = execs.length > 0
      ? execs.map(e => `<div class="flex items-start gap-2"><span class="text-[#71717A] shrink-0">${e.ts}</span><span class="text-emerald-600 shrink-0">$</span><span>${e.cmd}</span><span class="ml-auto text-[#71717A]">exit:${e.exitCode}</span></div>`).join('')
      : `<div class="text-[#A1A1AA]">No executions recorded for this sandbox.</div>`;
  }
};

window.closeAttachDrawer = function () {
  const drawer = document.getElementById('attach-drawer');
  if (drawer) { drawer.classList.add('hidden'); drawer.classList.remove('flex'); }
  state.activeDrawerSandboxId = null;
};

window.switchDrawerTab = function (tab) {
  const shellBtn = document.getElementById('drawer-tab-shell');
  const browserBtn = document.getElementById('drawer-tab-browser');
  const shellView = document.getElementById('drawer-shell-view');
  const browserView = document.getElementById('drawer-browser-view');

  if (tab === 'shell') {
    if (shellBtn) shellBtn.className = 'px-3 py-1 text-[11px] font-medium rounded-[4px] bg-white border border-[#E4E4E7] text-[#18181B] shadow-[0_1px_2px_rgba(0,0,0,0.04)]';
    if (browserBtn) browserBtn.className = 'px-3 py-1 text-[11px] font-medium rounded-[4px] text-[#71717A] hover:text-[#18181B]';
    if (shellView) shellView.classList.remove('hidden');
    if (browserView) browserView.classList.add('hidden');
  } else {
    if (browserBtn) browserBtn.className = 'px-3 py-1 text-[11px] font-medium rounded-[4px] bg-white border border-[#E4E4E7] text-[#18181B] shadow-[0_1px_2px_rgba(0,0,0,0.04)]';
    if (shellBtn) shellBtn.className = 'px-3 py-1 text-[11px] font-medium rounded-[4px] text-[#71717A] hover:text-[#18181B]';
    if (browserView) browserView.classList.remove('hidden');
    if (shellView) shellView.classList.add('hidden');
  }
};

window.navigateScreencast = function (action) {
  const streamLog = document.getElementById('cdp-stream-log');
  const urlBar = document.getElementById('browser-screencast-url');
  const url = urlBar ? urlBar.value : 'https://github.com/pulls/418';
  if (!streamLog) return;
  const now = new Date().toLocaleTimeString();
  if (action === 'go' || action === 'reload') {
    streamLog.innerHTML += `<div class="text-emerald-400">[CDP ${now}] Page.navigate &rarr; "${url}" (HTTP 200)</div>`;
    streamLog.innerHTML += `<div class="text-sky-400">[CDP ${now}] ScreencastFrame received (1280x720, 60fps)</div>`;
  } else if (action === 'back') {
    streamLog.innerHTML += `<div class="text-[#A1A1AA]">[CDP ${now}] Page.navigateHistory &rarr; Step -1</div>`;
  } else if (action === 'forward') {
    streamLog.innerHTML += `<div class="text-[#A1A1AA]">[CDP ${now}] Page.navigateHistory &rarr; Step +1</div>`;
  }
  streamLog.scrollTop = streamLog.scrollHeight;
};

window.submitDrawerSteer = async function (e) {
  e.preventDefault();
  const id = state.activeDrawerSandboxId;
  const directive = document.getElementById('drawer-steer-input')?.value?.trim();
  const scope = document.getElementById('drawer-steer-scope')?.value || 'single';
  if (!id || !directive) return;
  try {
    await api.steerAgent(id, directive, scope);
    showToast('Directive sent');
    document.getElementById('drawer-steer-input').value = '';
    const log = document.getElementById('drawer-terminal-log');
    if (log) log.innerHTML += `<div class="text-sky-600">↳ steer [${scope}]: ${directive}</div>`;
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.submitDrawerCommand = async function (e) {
  e.preventDefault();
  const id = state.activeDrawerSandboxId;
  const cmd = document.getElementById('drawer-cmd-input')?.value?.trim();
  if (!id || !cmd) return;
  try {
    const res = await api.execInSandbox(id, cmd);
    document.getElementById('drawer-cmd-input').value = '';
    const log = document.getElementById('drawer-terminal-log');
    if (log) {
      log.innerHTML += `<div><span class="text-[#71717A]">$ </span>${cmd}</div>`;
      if (res.stdout) log.innerHTML += `<div class="text-emerald-600 whitespace-pre-wrap">${res.stdout}</div>`;
      if (res.stderr) log.innerHTML += `<div class="text-rose-500 whitespace-pre-wrap">${res.stderr}</div>`;
      log.scrollTop = log.scrollHeight;
    }
    await refreshAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.checkpointFromDrawer = async function () {
  const id = state.activeDrawerSandboxId;
  if (!id) return;
  await window.checkpointSandboxAction(id);
};

window.forkFromDrawer = async function () {
  const id = state.activeDrawerSandboxId;
  if (!id) return;
  await window.forkSandbox(id);
};

// =========================================================
// LAUNCH MODAL
// =========================================================
window.openLaunchModal = function () {
  const modal = document.getElementById('launch-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  const parentSelect = document.getElementById('spawn-parent-select');
  if (parentSelect) {
    parentSelect.innerHTML = `<option value="">None (top-level root)</option>` +
      state.sandboxes.map(s => `<option value="${s.id}">${s.id} (${s.role})</option>`).join('');
  }
};

window.closeLaunchModal = function () {
  const modal = document.getElementById('launch-modal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
};

window.applySpawnPreset = function (role, cpu, mem, btn) {
  document.getElementById('spawn-role-input').value = role;
  const cpuVal = parseInt(cpu);
  document.getElementById('spawn-cpu-select').value = cpuVal;
  const memVal = parseInt(mem);
  document.getElementById('spawn-mem-select').value = memVal;
  document.querySelectorAll('.preset-btn').forEach(b => {
    b.classList.toggle('border-[#18181B]', b === btn);
    b.classList.toggle('bg-[#FAFAFA]', b === btn);
    b.classList.toggle('border-[#E4E4E7]', b !== btn);
    b.classList.toggle('bg-white', b !== btn);
  });
};

window.submitSpawnSandbox = async function (e) {
  e.preventDefault();
  const role = document.getElementById('spawn-role-input').value.trim();
  const cpu = Number(document.getElementById('spawn-cpu-select').value);
  const mem = Number(document.getElementById('spawn-mem-select').value);
  const parentId = document.getElementById('spawn-parent-select').value || undefined;
  const mcpTools = Array.from(document.querySelectorAll('.spawn-mcp-cb:checked')).map(cb => cb.value);
  const modelProvider = document.getElementById('spawn-model-select')?.value || 'claude-3-5-sonnet';

  try {
    await api.spawnSandbox({ role, cpuLimitMilli: cpu, memLimitMi: mem, parentId, mcpTools, modelProvider });
    showToast(`Sandbox "${role}" spawned (${modelProvider})`);
    closeLaunchModal();
    await refreshAllData();
    switchSection('overview');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// =========================================================
// VAULT MODAL & INJECTED SECRETS
// =========================================================
window.openVaultModal = function () {
  const m = document.getElementById('vault-modal');
  if (m) { m.classList.remove('hidden'); m.classList.add('flex'); }
};

window.closeVaultModal = function () {
  const m = document.getElementById('vault-modal');
  if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
};

window.submitAddVaultCredential = async function (e) {
  e.preventDefault();
  const key = document.getElementById('vault-key-input')?.value?.trim();
  const value = document.getElementById('vault-value-input')?.value?.trim();
  const hostScope = document.getElementById('vault-scope-select')?.value || 'api.github.com';
  const injectionMethod = document.getElementById('vault-method-select')?.value || 'header';

  if (!key || !value) return;
  try {
    await api.addVaultCredential({ key, value, hostScope, injectionMethod });
    showToast(`Stored vault credential: ${key}`);
    closeVaultModal();
    document.getElementById('vault-key-input').value = '';
    document.getElementById('vault-value-input').value = '';
    await renderVaultCredentials();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.deleteVaultCredentialAction = async function (id) {
  try {
    await api.deleteVaultCredential(id);
    showToast('Secret removed from vault');
    await renderVaultCredentials();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.renderVaultCredentials = async function () {
  const tbody = document.getElementById('vault-credentials-tbody');
  if (!tbody) return;
  try {
    const creds = await api.listVaultCredentials();
    if (!creds || creds.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-[#A1A1AA] font-mono text-[11.5px]">No credentials registered in vault. Add a secret to inject into micro-sandboxes.</td></tr>`;
      return;
    }
    tbody.innerHTML = creds.map(c => `
      <tr class="hover:bg-[#FAFAFA] transition-colors">
        <td class="py-3 px-6 font-mono text-[12px] font-semibold text-[#18181B] flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-[#71717A]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
          ${c.key}
        </td>
        <td class="py-3 px-4 font-mono text-[11px] text-[#52525B]">
          <span class="px-1.5 py-0.5 rounded bg-[#F4F4F5] border border-[#E4E4E7]">${c.hostScope}</span>
        </td>
        <td class="py-3 px-4 font-mono text-[11px] text-[#71717A]">
          <span class="capitalize">${c.injectionMethod}</span>
        </td>
        <td class="py-3 px-4 font-mono text-[11.5px] text-[#71717A]">
          ${c.maskedValue}
        </td>
        <td class="py-3 px-6 text-right">
          <button onclick="deleteVaultCredentialAction('${c.id}')" class="font-mono text-[11px] text-rose-600 hover:text-rose-800">
            Revoke
          </button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.warn('Failed to load vault credentials:', err);
  }
};

// =========================================================
// DEMO MODAL
// =========================================================
window.openDemoModal = function () {
  const m = document.getElementById('demo-modal');
  if (m) { m.classList.remove('hidden'); m.classList.add('flex'); }
};

window.closeDemoModal = function () {
  const m = document.getElementById('demo-modal');
  if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
};

window.confirmRunDemo = async function () {
  closeDemoModal();
  try {
    showToast('Launching PR #418 review swarm…');
    await api.runDemoUseCase();
    showToast('PR #418 swarm executed successfully!');
    await refreshAllData();
    switchSection('overview');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// =========================================================
// LEDGER ACTIONS
// =========================================================
window.replayFromSeq = async function (seq) {
  try {
    const res = await api.replayLedger(seq);
    const banner = document.getElementById('replay-banner');
    const output = document.getElementById('replay-stream-output');
    if (banner) banner.classList.remove('hidden');
    if (output && res.replayedEvents) {
      output.innerHTML = res.replayedEvents.map(e =>
        `<div><span class="text-[#71717A]">[${e.type}]</span> ${e.summary || e.payload || ''}</div>`
      ).join('');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.replayFromSelectedTimelineNode = function () {
  if (state.selectedSeq) replayFromSeq(state.selectedSeq);
};

// =========================================================
// FILTERS
// =========================================================
window.setTopoFilter = function (f) {
  state.topoFilter = f;
  ['all', 'running'].forEach(id => {
    const btn = document.getElementById(`topo-filter-${id}`);
    if (!btn) return;
    if (id === f) {
      btn.className = 'px-2.5 py-0.5 rounded-[4px] bg-white text-[#18181B] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.04)]';
    } else {
      btn.className = 'px-2.5 py-0.5 rounded-[4px] text-[#71717A] hover:text-[#18181B]';
    }
  });
  renderOverview();
};

window.setSandboxFilter = function (f) {
  state.sandboxFilter = f;
  ['all', 'running', 'paused'].forEach(id => {
    const btn = document.getElementById(`sb-filter-${id}`);
    if (!btn) return;
    if (id === f) {
      btn.className = 'px-2.5 py-0.5 rounded-[3px] bg-white text-[#18181B] border border-[#E4E4E7]';
    } else {
      btn.className = 'px-2.5 py-0.5 rounded-[3px] text-[#71717A] hover:text-[#18181B]';
    }
  });
  renderSandboxesTable();
};

// =========================================================
// WORKFLOW ACTIONS
// =========================================================
window.enqueueWorkflowJob = async function () {
  try {
    const name = `job_${Date.now().toString(36)}`;
    await api.enqueueWorkflowJob(name, 1);
    showToast(`Enqueued ${name}`);
    await refreshAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.flushWorkflowPipeline = async function () {
  try {
    const res = await api.flushWorkflowPipeline();
    showToast(`Flushed: ${res.flushed || 0} jobs processed`);
    await refreshAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// =========================================================
// STORAGE ADAPTER
// =========================================================
window.setStorageAdapter = async function (adapter) {
  try {
    await api.setStorageAdapter(adapter);
    showToast(`Switched to ${adapter}`);
    ['sqlite', 'postgres'].forEach(id => {
      const btn = document.getElementById(`btn-adapter-${id}`);
      if (btn) {
        const isActive = (id === 'sqlite' && adapter === 'SQLiteAdapter') || (id === 'postgres' && adapter === 'PostgresAdapter');
        btn.className = `p-3 rounded-[4px] text-left transition-all ${isActive ? 'border border-[#18181B] bg-[#FAFAFA]' : 'border border-[#E4E4E7] hover:border-[#D4D4D8] bg-white'}`;
      }
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// =========================================================
// BOOTSTRAP
// =========================================================
window.addEventListener('load', async () => {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken);
  }

  const ok = await guardAuth();
  if (!ok) return;

  await refreshAllData();
  setInterval(refreshAllData, 8000);

  const initialView = params.get('view');
  if (initialView) {
    window.switchSection(initialView);
  }
  if (params.get('drawer') === 'true' && state.sandboxes.length > 0) {
    window.openAttachDrawer(state.sandboxes[0].id);
    if (params.get('drawerTab') === 'browser') {
      window.switchDrawerTab('browser');
    }
  }
  if (params.get('spawnModal') === 'true') {
    window.openLaunchModal();
  }
  if (params.get('vaultModal') === 'true') {
    window.openVaultModal();
  }
});
