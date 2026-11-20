import { api } from './api.js';

export function setupOneCliModal(modalEl, inputEl, outputEl, onCommandExecuted, getContext) {
  if (!modalEl || !inputEl || !outputEl) return;

  function renderChips() {
    const ctx = getContext ? getContext() : {};
    const firstSb = (ctx.sandboxes && ctx.sandboxes[0]) ? ctx.sandboxes[0].id : 'sbx_8F4K2M';
    const pendingGate = (ctx.egressGates && ctx.egressGates.find(g => g.status === 'pending')) ? ctx.egressGates.find(g => g.status === 'pending').gateId : 'gate_91';

    const quickSnippets = [
      { label: 'Fleet Status', cmd: 'alineo status' },
      { label: 'Spawn Reviewer', cmd: 'alineo spawn --role reviewer-auth --cpu 500 --mem 512' },
      { label: 'Fork Security', cmd: `alineo fork ${firstSb} --role reviewer-sec` },
      { label: 'Save Checkpoint', cmd: `alineo checkpoint ${firstSb} --tag cp_0145` },
      { label: 'Steer Subtree', cmd: `alineo steer ${firstSb} "Enforce strict token verification" --scope subtree` },
      { label: 'Memory Recall', cmd: 'alineo memory recall "jwt auth"' },
      { label: 'Approve Egress', cmd: `alineo egress approve ${pendingGate}` },
      { label: 'Flush Workflow', cmd: 'alineo workflow flush' },
      { label: 'Memory Compact', cmd: 'alineo memory compact' },
    ];

    const chipsContainer = document.getElementById('onecli-quick-chips');
    if (chipsContainer) {
      chipsContainer.innerHTML = quickSnippets.map(s => `
        <button class="onecli-chip px-2 py-1 rounded-[4px] bg-[#F4F4F5] hover:bg-[#E4E4E7] text-[#18181B] font-mono text-[10px] transition-colors"
                data-cmd="${s.cmd}">
          ${s.label}
        </button>
      `).join('');

      chipsContainer.querySelectorAll('.onecli-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const cmd = btn.getAttribute('data-cmd');
          if (cmd) {
            inputEl.value = cmd;
            executeCli(cmd);
          }
        });
      });
    }
  }

  // Initial render of chips
  renderChips();

  async function executeCli(cmd) {
    if (!cmd || cmd.trim() === '') return;
    outputEl.innerHTML = `<span class="text-[#71717A]">Executing: ${cmd}...</span>`;

    try {
      const res = await api.runCliCommand(cmd);
      outputEl.innerHTML = `
        <div class="flex items-center justify-between pb-1.5 border-b border-[#27272A] text-[10.5px]">
          <span class="text-emerald-400 font-semibold">$ ${res.command}</span>
          <span class="text-[#A1A1AA]">${res.durationMs}ms · exit=${res.exitCode}</span>
        </div>
        <pre class="pt-2 text-[11px] leading-relaxed whitespace-pre-wrap">${res.output}</pre>
      `;

      if (onCommandExecuted) onCommandExecuted(res);
    } catch (err) {
      outputEl.innerHTML = `<div class="text-rose-400">Error executing command: ${err.message}</div>`;
    }
  }

  // Submit on enter
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeCli(inputEl.value);
    }
  });

  // Global hotkey Ctrl+K / Cmd+K
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      modalEl.classList.toggle('hidden');
      modalEl.classList.toggle('flex');
      if (!modalEl.classList.contains('hidden')) {
        setTimeout(() => inputEl.focus(), 50);
      }
    }
  });
}
