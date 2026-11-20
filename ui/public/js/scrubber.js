// Horizontal Timeline Scrubber and Replay Engine
export function renderTimelineScrubber(svgEl, events, selectedSeq, onSelectEvent) {
  if (!svgEl) return;

  if (!events || events.length === 0) {
    svgEl.innerHTML = `<text x="400" y="80" text-anchor="middle" fill="#A1A1AA" font-family="Inter" font-size="12">No audit events recorded in SQLite ledger</text>`;
    return;
  }

  const trackYMain = 55;
  const trackYFork = 125;
  const paddingX = 65;
  const width = Math.max(860, events.length * 135);
  const stepX = (width - paddingX * 2) / Math.max(1, events.length - 1);

  svgEl.setAttribute('viewBox', `0 0 ${width} 175`);

  let html = `
    <!-- Track Rails -->
    <line x1="${paddingX - 25}" y1="${trackYMain}" x2="${width - paddingX + 25}" y2="${trackYMain}" stroke="#E4E4E7" stroke-width="2" />
    <text x="${paddingX - 45}" y="${trackYMain + 4}" font-family="JetBrains Mono" font-size="10" fill="#71717A">main</text>

    <line x1="${paddingX - 25}" y1="${trackYFork}" x2="${width - paddingX + 25}" y2="${trackYFork}" stroke="#E4E4E7" stroke-width="2" stroke-dasharray="4, 4" />
    <text x="${paddingX - 45}" y="${trackYFork + 4}" font-family="JetBrains Mono" font-size="10" fill="#71717A">fork</text>
  `;

  // Draw nodes
  events.forEach((ev, idx) => {
    const x = paddingX + idx * stepX;
    const isFork = ev.branch === 'fork';
    const y = isFork ? trackYFork : trackYMain;
    const isSelected = selectedSeq === ev.seq;

    // Branch fork transition line
    if (isFork && idx > 0) {
      const prevX = paddingX + (idx - 1) * stepX;
      html += `
        <path d="M ${prevX} ${trackYMain} C ${prevX + 30} ${trackYMain}, ${x - 30} ${trackYFork}, ${x} ${trackYFork}"
              fill="none" stroke="#D4D4D8" stroke-width="1.5" stroke-dasharray="3, 3" />
      `;
    }

    let nodeShape = '';
    const color = ev.type === 'exec_start'
      ? '#0284C7'
      : (ev.type === 'exec_event' ? '#D97706' : (ev.type === 'checkpoint' ? '#18181B' : '#059669'));

    if (ev.type === 'checkpoint') {
      nodeShape = `
        <rect x="${x - 7.5}" y="${y - 7.5}" width="15" height="15" transform="rotate(45, ${x}, ${y})"
              fill="${isSelected ? '#FFFFFF' : '#18181B'}" stroke="#18181B" stroke-width="2" />
      `;
    } else {
      nodeShape = `
        <circle cx="${x}" cy="${y}" r="${isSelected ? 8 : 6}"
                fill="${isSelected ? '#FFFFFF' : color}" stroke="${color}" stroke-width="${isSelected ? 3 : 2}" />
      `;
    }

    const timeShort = new Date(ev.ts).toISOString().substring(11, 19);

    html += `
      <g class="scrubber-node" data-seq="${ev.seq}" style="cursor: pointer;" transform="translate(0, 0)">
        <!-- Vertical guideline on selection -->
        ${isSelected ? `<line x1="${x}" y1="15" x2="${x}" y2="155" stroke="#18181B" stroke-width="1" stroke-dasharray="2, 2" />` : ''}

        <!-- Interactive node icon -->
        ${nodeShape}

        <!-- Top Sequence Pill -->
        <g transform="translate(${x - 18}, ${y - 32})">
          <rect width="36" height="16" rx="3" fill="#FFFFFF" stroke="${isSelected ? '#18181B' : '#E4E4E7'}" />
          <text x="18" y="11.5" text-anchor="middle" font-family="JetBrains Mono" font-size="8.5" font-weight="600" fill="#18181B">#${ev.seq}</text>
        </g>

        <!-- Bottom Short Label & Time -->
        <text x="${x}" y="${y + 20}" text-anchor="middle" font-family="JetBrains Mono" font-size="9" font-weight="600" fill="#18181B">${ev.short_label}</text>
        <text x="${x}" y="${y + 32}" text-anchor="middle" font-family="JetBrains Mono" font-size="8" fill="#71717A">${timeShort}</text>
      </g>
    `;
  });

  svgEl.innerHTML = html;

  svgEl.querySelectorAll('.scrubber-node').forEach(nodeEl => {
    nodeEl.addEventListener('click', () => {
      const seq = Number(nodeEl.getAttribute('data-seq'));
      if (seq && onSelectEvent) onSelectEvent(seq);
    });
  });
}
