import { api } from './api.js';

export function renderWorkingMemoryTable(containerEl, items, onDeleteKey) {
  if (!containerEl) return;

  if (items.length === 0) {
    containerEl.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-[#A1A1AA] font-mono text-[11px]">No active working memory keys registered</td></tr>`;
    return;
  }

  containerEl.innerHTML = items.map(item => `
    <tr class="hover:bg-[#FAFAFA] transition-colors">
      <td class="py-2.5 px-4 font-mono font-medium text-[#18181B]">${item.sandboxId}</td>
      <td class="py-2.5 px-4 font-mono font-semibold text-[#0284C7]">${item.key}</td>
      <td class="py-2.5 px-4 font-mono text-[#52525B] max-w-xs truncate">${item.value}</td>
      <td class="py-2.5 px-4">
        <span class="px-2 py-0.5 rounded-[3px] font-mono text-[10px] ${item.scope === 'swarm' ? 'bg-purple-50 text-purple-700 border border-purple-200' : 'bg-gray-100 text-[#52525B] border border-gray-200'}">
          ${item.scope}
        </span>
      </td>
      <td class="py-2.5 px-4 text-right">
        <button class="delete-wm-btn px-2 py-1 rounded-[3px] text-rose-600 hover:bg-rose-50 font-mono text-[11px] transition-colors"
                data-sb="${item.sandboxId}" data-key="${item.key}">
          delete
        </button>
      </td>
    </tr>
  `).join('');

  containerEl.querySelectorAll('.delete-wm-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sb = btn.getAttribute('data-sb');
      const key = btn.getAttribute('data-key');
      if (sb && key && onDeleteKey) onDeleteKey(sb, key);
    });
  });
}

export function renderEpisodicTree(containerEl, episodes) {
  if (!containerEl) return;

  if (episodes.length === 0) {
    containerEl.innerHTML = `<div class="p-6 text-center text-[#A1A1AA] font-mono text-[11px]">No episodic memories generated yet</div>`;
    return;
  }

  containerEl.innerHTML = episodes.map((ep, idx) => {
    const isRoot = !ep.parentEpisodeId;
    const timeStr = new Date(ep.ts).toISOString().substring(11, 19);

    const typeBadgeColor = ep.episodeType === 'task_init'
      ? 'bg-sky-50 text-sky-700 border-sky-200'
      : (ep.episodeType === 'analysis' ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200');

    return `
      <div class="relative pl-6 pb-4 border-l ${isRoot ? 'border-[#18181B]' : 'border-[#E4E4E7]'} ml-2">
        <div class="absolute -left-1.5 top-0 w-3 h-3 rounded-full ${isRoot ? 'bg-[#18181B]' : 'bg-[#D4D4D8]'} border-2 border-white"></div>
        <div class="p-3 rounded-[5px] border border-[#E4E4E7] bg-white hover:border-[#18181B] transition-colors space-y-1.5">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="font-mono text-[10.5px] font-semibold text-[#18181B]">${ep.sandboxId}</span>
              <span class="px-2 py-0.5 rounded-[3px] font-mono text-[9px] border ${typeBadgeColor}">${ep.episodeType}</span>
            </div>
            <span class="font-mono text-[10px] text-[#A1A1AA]">${timeStr}</span>
          </div>
          <div class="text-[12px] font-medium text-[#18181B]">${ep.title}</div>
          <p class="text-[11px] text-[#71717A]">${ep.detail}</p>
          ${ep.outcome ? `<div class="pt-1.5 border-t border-[#F4F4F5] font-mono text-[10px] text-emerald-700">Outcome: ${ep.outcome}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

export function renderSemanticFactsList(containerEl, facts) {
  if (!containerEl) return;

  if (facts.length === 0) {
    containerEl.innerHTML = `<div class="p-6 text-center text-[#A1A1AA] font-mono text-[11px]">No semantic facts matched the query</div>`;
    return;
  }

  containerEl.innerHTML = facts.map(fact => `
    <div class="p-3.5 rounded-[5px] border border-[#E4E4E7] bg-white hover:border-[#18181B] transition-all space-y-2">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="font-mono text-[11.5px] font-semibold text-[#18181B]">${fact.subject}</span>
          <span class="font-mono text-[10px] text-[#71717A]">â†’ ${fact.predicate} â†’</span>
          <span class="font-mono text-[11px] font-medium text-[#0284C7]">${fact.object}</span>
        </div>
        ${fact.score !== undefined ? `
          <span class="px-2 py-0.5 rounded-[3px] bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono text-[9.5px]">
            score: ${fact.score}
          </span>
        ` : `
          <span class="font-mono text-[10px] text-[#71717A]">conf: ${(fact.confidence * 100).toFixed(0)}%</span>
        `}
      </div>
      <div class="flex flex-wrap items-center gap-1.5 pt-1 border-t border-[#F4F4F5]">
        <span class="font-mono text-[9.5px] text-[#A1A1AA]">tags:</span>
        ${fact.tags.map(t => `<span class="px-1.5 py-0.5 rounded-[3px] bg-[#F4F4F5] text-[#52525B] font-mono text-[9px]">${t}</span>`).join('')}
      </div>
    </div>
  `).join('');
}
