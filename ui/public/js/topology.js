// Interactive SVG Topology Renderer — High-Fidelity Architectural Design
export function renderTopologyGraph(svgEl, sandboxes, selectedId, onSelectNode, filter = 'all') {
  if (!svgEl) return;

  const filtered = filter === 'running'
    ? sandboxes.filter(s => s.status === 'running')
    : sandboxes;

  if (filtered.length === 0) {
    svgEl.innerHTML = `
      <defs>
        <pattern id="topo-dot-grid" width="16" height="16" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="0.8" fill="#D4D4D8" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#topo-dot-grid)" />
      <g transform="translate(340, 190)">
        <circle cx="0" cy="0" r="24" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="1" />
        <path d="M-8 -4 L0 -12 L8 -4 M-8 4 L0 12 L8 4" stroke="#71717A" stroke-width="1.5" fill="none" stroke-linecap="round" />
        <text x="0" y="42" text-anchor="middle" fill="#18181B" font-size="12.5" font-family="Inter" font-weight="600">No agents deployed</text>
        <text x="0" y="58" text-anchor="middle" fill="#71717A" font-size="11" font-family="JetBrains Mono">Spawn a sandbox to view live orchestration topology</text>
      </g>
    `;
    return;
  }

  // Calculate layout positions
  const nodeWidth = 224;
  const nodeHeight = 84;
  const positions = new Map();

  const roots = filtered.filter(s => !s.parentId || !filtered.some(f => f.id === s.parentId));
  const children = filtered.filter(s => s.parentId && filtered.some(f => f.id === s.parentId));

  // Roots on left column (x: 60)
  roots.forEach((root, idx) => {
    const y = roots.length === 1 ? 160 : 70 + idx * 170;
    positions.set(root.id, { x: 60, y, sb: root });
  });

  // Level 1 children (x: 380)
  const groupedByParent = new Map();
  children.forEach(child => {
    const list = groupedByParent.get(child.parentId) || [];
    list.push(child);
    groupedByParent.set(child.parentId, list);
  });

  groupedByParent.forEach((kidList, parentId) => {
    const parentPos = positions.get(parentId) || { x: 60, y: 160 };
    const totalHeight = (kidList.length - 1) * 120;
    const startY = Math.max(45, parentPos.y - totalHeight / 2);

    kidList.forEach((child, idx) => {
      const x = 380;
      const y = startY + idx * 120;
      positions.set(child.id, { x, y, sb: child });
    });
  });

  let svgHtml = `
    <defs>
      <!-- Subtle dot matrix architectural grid -->
      <pattern id="topo-dot-grid" width="16" height="16" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="0.8" fill="#D4D4D8" />
      </pattern>
      <!-- Soft card drop shadows -->
      <filter id="card-shadow" x="-8%" y="-8%" width="120%" height="125%" filterUnits="userSpaceOnUse">
        <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#09090B" flood-opacity="0.04" />
      </filter>
      <filter id="card-shadow-active" x="-8%" y="-8%" width="120%" height="125%" filterUnits="userSpaceOnUse">
        <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#09090B" flood-opacity="0.08" />
      </filter>
      <filter id="pill-shadow" x="-10%" y="-10%" width="125%" height="130%" filterUnits="userSpaceOnUse">
        <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.04" />
      </filter>
    </defs>
    <!-- Background grid -->
    <rect width="100%" height="100%" fill="url(#topo-dot-grid)" />
  `;

  // 1. Draw Links (Smooth Cubic Bézier curves)
  positions.forEach((pos, id) => {
    if (pos.sb.parentId && positions.has(pos.sb.parentId)) {
      const parentPos = positions.get(pos.sb.parentId);
      const x1 = parentPos.x + nodeWidth;
      const y1 = parentPos.y + nodeHeight / 2;
      const x2 = pos.x;
      const y2 = pos.y + nodeHeight / 2;
      const cx1 = x1 + (x2 - x1) * 0.52;
      const cx2 = x2 - (x2 - x1) * 0.52;

      const isForkSelected = selectedId === id || selectedId === pos.sb.parentId;
      const strokeColor = isForkSelected ? '#18181B' : '#A1A1AA';
      const strokeWidth = isForkSelected ? 1.75 : 1.25;

      svgHtml += `
        <path d="M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}"
              fill="none"
              stroke="${strokeColor}"
              stroke-width="${strokeWidth}"
              stroke-linecap="round" />
      `;

      // CoW fork label pill
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      svgHtml += `
        <g transform="translate(${midX - 25}, ${midY - 10})" filter="url(#pill-shadow)">
          <rect width="50" height="20" rx="5" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="1" />
          <text x="25" y="13.5" text-anchor="middle" font-family="JetBrains Mono" font-size="9.5" font-weight="500" fill="#27272A">CoW fork</text>
        </g>
      `;
    }
  });

  // 2. Draw Nodes
  positions.forEach((pos, id) => {
    const sb = pos.sb;
    const isSelected = selectedId === id;
    const isRunning = sb.status === 'running';
    const isPaused = sb.status === 'paused';

    const statusBg = isRunning ? '#ECFDF5' : (isPaused ? '#FFFBEB' : '#F4F4F5');
    const statusDot = isRunning ? '#059669' : (isPaused ? '#D97706' : '#71717A');
    const statusBorder = isRunning ? '#A7F3D0' : (isPaused ? '#FDE68A' : '#E4E4E7');
    const statusText = isRunning ? 'running' : (isPaused ? 'paused' : 'halted');

    const cpuPct = Math.min(100, Math.round((sb.cpuCurrentMilli / sb.cpuLimitMilli) * 100)) || 0;
    const memPct = Math.min(100, Math.round((sb.memCurrentMi / sb.memLimitMi) * 100)) || 0;

    const modelName = sb.modelProvider
      ? (sb.modelProvider.includes('thinking') ? 'gemini-think' : (sb.modelProvider.includes('gemini-2') ? 'gemini-2.0' : (sb.modelProvider.includes('gemini-1.5') ? 'gemini-1.5' : (sb.modelProvider.includes('claude') ? 'claude-3.5' : (sb.modelProvider.includes('groq') ? 'groq-llama3' : 'custom-llm')))))
      : 'gemini-2.0';

    svgHtml += `
      <g class="topo-node ${isSelected ? 'selected' : ''}" data-id="${id}" transform="translate(${pos.x}, ${pos.y})" style="cursor: pointer;">
        <!-- Card base shadow and background -->
        <rect width="${nodeWidth}" height="${nodeHeight}" rx="8"
              fill="#FFFFFF"
              stroke="${isSelected ? '#18181B' : '#E4E4E7'}"
              stroke-width="${isSelected ? '2' : '1'}"
              filter="url(${isSelected ? '#card-shadow-active' : '#card-shadow'})" />

        <!-- Status Dot (with animated pulse ring when running) -->
        <circle cx="18" cy="20" r="4.5" fill="${statusDot}" />
        ${isRunning ? `<circle cx="18" cy="20" r="7.5" fill="none" stroke="${statusDot}" stroke-width="1" opacity="0.4" />` : ''}

        <!-- Sandbox ID -->
        <text x="32" y="24" font-family="JetBrains Mono" font-weight="600" font-size="12" fill="#18181B">${sb.id}</text>

        <!-- Status Badge Pill -->
        <rect x="${nodeWidth - 68}" y="11" width="56" height="18" rx="4" fill="${statusBg}" stroke="${statusBorder}" stroke-width="0.8" />
        <text x="${nodeWidth - 40}" y="23.5" text-anchor="middle" font-family="JetBrains Mono" font-size="10" font-weight="500" fill="${statusDot}">${statusText}</text>

        <!-- Role Title & Model Badge -->
        <text x="16" y="45" font-family="Inter" font-weight="600" font-size="11.5" fill="#18181B">${sb.role}</text>
        <rect x="${nodeWidth - 76}" y="34" width="64" height="15" rx="3" fill="#F4F4F5" />
        <text x="${nodeWidth - 44}" y="45" text-anchor="middle" font-family="JetBrains Mono" font-size="8.5" fill="#71717A">${modelName}</text>

        <!-- Compute Mini Progress Meters -->
        <g transform="translate(16, 56)">
          <!-- CPU Meter -->
          <text x="0" y="8" font-family="JetBrains Mono" font-size="9" font-weight="500" fill="#71717A">cpu ${sb.cpuCurrentMilli || 0}m</text>
          <rect x="52" y="1" width="42" height="7" rx="3" fill="#F4F4F5" />
          <rect x="52" y="1" width="${Math.max(4, Math.round(42 * (cpuPct / 100)))}" height="7" rx="3" fill="${isRunning ? '#059669' : '#D97706'}" />

          <!-- Memory Meter -->
          <text x="106" y="8" font-family="JetBrains Mono" font-size="9" font-weight="500" fill="#71717A">mem ${sb.memCurrentMi || 0}M</text>
          <rect x="154" y="1" width="38" height="7" rx="3" fill="#F4F4F5" />
          <rect x="154" y="1" width="${Math.max(4, Math.round(38 * (memPct / 100)))}" height="7" rx="3" fill="#0284C7" />
        </g>

        <!-- Checkpoint Badge Tag (bottom footer) -->
        ${sb.checkpointId ? `
          <g transform="translate(16, 73)">
            <text x="0" y="5" font-family="JetBrains Mono" font-size="8.5" fill="#A1A1AA">cp: ${sb.checkpointId}</text>
          </g>
        ` : ''}
      </g>
    `;
  });

  svgEl.innerHTML = svgHtml;

  // Bind click handlers
  svgEl.querySelectorAll('.topo-node').forEach(nodeEl => {
    nodeEl.addEventListener('click', (e) => {
      const id = nodeEl.getAttribute('data-id');
      if (id && onSelectNode) onSelectNode(id);
    });
  });
}
