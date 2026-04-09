// ─────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────

let model        = null;
let namedRunners = null;

// ─────────────────────────────────────────────
//  Time utilities
// ─────────────────────────────────────────────

const RACE_START_MIN = 8 * 60; // minutes from midnight

function minToClockStr(minutesFromStart) {
  const total     = RACE_START_MIN + Math.round(minutesFromStart);
  const dayOffset = Math.floor(total / 1440);
  const h24       = Math.floor(total / 60) % 24;
  const m         = total % 60;
  const ampm      = h24 >= 12 ? 'PM' : 'AM';
  const h12       = h24 % 12 === 0 ? 12 : h24 % 12;
  const day       = dayOffset === 0 ? 'Fri' : dayOffset === 1 ? 'Sat' : 'Sun';
  return `${h12}:${String(m).padStart(2,'0')} ${ampm} ${day}`;
}

function minToElapsed(t) {
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${h}:${String(m).padStart(2,'0')}`;
}

function elapsedToTimeOfDay(h) {
  const totalMin = RACE_START_MIN + h * 60;
  const h24  = Math.floor(totalMin / 60) % 24;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12  = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12} ${ampm}`;
}

// ─────────────────────────────────────────────
//  Stat cards
// ─────────────────────────────────────────────

function computeStats() {
  const { stations, stationStats, runners } = model;
  const total     = runners.length;
  const finishers = stationStats[13].count;

  // Hardest segment: highest median minutes-per-mile (skip Sonju index 6, data artifact)
  let hardestIdx = -1, hardestMinPerMile = 0;
  for (let k = 1; k < stations.length; k++) {
    if (k === 6) continue; // Sonju timing mat artifact
    const segMin  = stationStats[k].p50 - stationStats[k-1].p50;
    const segMile = stations[k].distance - stations[k-1].distance;
    const mpm     = segMin / segMile;
    if (mpm > hardestMinPerMile) { hardestMinPerMile = mpm; hardestIdx = k; }
  }

  // Station with biggest absolute dropout (skip Sonju)
  let mostDropIdx = -1, mostDrop = 0;
  for (let k = 1; k < stations.length; k++) {
    if (k === 6) continue;
    const drop = stationStats[k-1].count - stationStats[k].count;
    if (drop > mostDrop) { mostDrop = drop; mostDropIdx = k; }
  }

  // Midnight station: first checkpoint where median runner passes midnight (960 min from start)
  const midnightStation = stations.find((_, k) => stationStats[k].p50 >= 960);

  return [
    {
      value: `${Math.round(finishers / total * 100)}%`,
      label: 'Finish Rate',
      sub: `${finishers.toLocaleString()} of ${total.toLocaleString()} runners`,
    },
    {
      value: minToElapsed(stationStats[13].p50),
      label: 'Median Finish',
      sub: `arrives ${minToClockStr(stationStats[13].p50)}`,
    },
    {
      value: minToElapsed(stationStats[13].min),
      label: 'Fastest Recorded',
      sub: `p10 cutoff: ${minToElapsed(stationStats[13].p10)}`,
    },
  ];
}

function renderStats() {
  const stats = computeStats();
  document.getElementById('stat-grid').innerHTML = stats.map(s => `
    <div class="stat-card">
      <div class="stat-value">${s.value}</div>
      <div class="stat-label">${s.label}</div>
      ${s.sub ? `<div class="stat-sub">${s.sub}</div>` : ''}
    </div>
  `).join('');
}

// ─────────────────────────────────────────────
//  Top 10 finishes table
// ─────────────────────────────────────────────

function renderTopTen() {
  const finishers = namedRunners
    .filter(r => r.splits[13] != null)
    .sort((a, b) => a.splits[13] - b.splits[13])
    .slice(0, 10);

  document.getElementById('top10-tbody').innerHTML = finishers.map(r => `
    <tr>
      <td style="text-align:left">${r.name}</td>
      <td>${r.year}</td>
      <td>${minToElapsed(r.splits[13])}</td>
    </tr>
  `).join('');
}

// ─────────────────────────────────────────────
//  Finish time histogram
// ─────────────────────────────────────────────

function renderFinishHistogram() {
  const CUTOFF_MIN = 2280; // 10 PM Saturday
  const times = namedRunners
    .filter(r => r.splits[13] != null && r.splits[13] <= CUTOFF_MIN)
    .map(r => r.splits[13]); // elapsed minutes at finish

  const BIN_MIN  = 60; // 1-hour bins
  const binStart = Math.floor(Math.min(...times) / BIN_MIN) * BIN_MIN;
  const binEnd   = Math.ceil(Math.max(...times)  / BIN_MIN) * BIN_MIN;

  const counts = [], labels = [];
  for (let t = binStart; t < binEnd; t += BIN_MIN) {
    counts.push(times.filter(x => x >= t && x < t + BIN_MIN).length);
    labels.push(elapsedToTimeOfDay(t / 60));
  }

  const ctx = document.getElementById('finish-histogram').getContext('2d');
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: counts,
        backgroundColor: 'rgba(74,222,128,0.5)',
        borderColor:     'rgba(74,222,128,0.85)',
        borderWidth: 1,
        borderRadius: 3,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => items[0].label,
            label: item  => `${item.raw} runners`,
          }
        }
      },
      scales: {
        x: {
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#9ca3af', font: { size: 11 } },
          title: { display: true, text: 'Finish time (Saturday)', color: '#9ca3af', font: { size: 11 } },
        },
        y: {
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#9ca3af' },
          title: { display: true, text: 'Runners', color: '#9ca3af', font: { size: 11 } },
        }
      }
    }
  });
}

// ─────────────────────────────────────────────
//  Spread chart
// ─────────────────────────────────────────────

function renderSpreadChart() {
  const { stations, stationStats } = model;

  // Skip Sonju (index 6) — timing mat artifact
  const indices = stations.map((_, i) => i).filter(i => i !== 6);
  const labels  = indices.map(i => stations[i].name);
  const get     = key => indices.map(i => +(stationStats[i][key] / 60).toFixed(3));

  const p10 = get('p10'), p25 = get('p25');
  const p50 = get('p50');
  const p75 = get('p75'), p90 = get('p90');

  function fmt(h) {
    const hrs = Math.floor(h);
    const min = Math.round((h - hrs) * 60);
    return `${hrs}h ${String(min).padStart(2, '0')}m`;
  }

  // Night band: 8 PM–6 AM = elapsed 12h–22h
  const NIGHT_START = 12, NIGHT_END = 22;

  const nightPlugin = {
    id: 'nightBand',
    beforeDraw(chart) {
      const { ctx: c, chartArea: { left, right }, scales: { y } } = chart;
      const yTop    = y.getPixelForValue(NIGHT_END);
      const yBottom = y.getPixelForValue(NIGHT_START);
      c.save();
      c.fillStyle = 'rgba(10, 15, 50, 0.55)';
      c.fillRect(left, yTop, right - left, yBottom - yTop);
      c.restore();
    }
  };

  const ctx = document.getElementById('spread-chart').getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        // Outer band: p10 → p90
        { data: p10, fill: { target: 1 }, backgroundColor: 'rgba(74,222,128,0.12)', borderWidth: 0, pointRadius: 0, tension: 0.3 },
        { data: p90, fill: false, borderWidth: 0, pointRadius: 0, tension: 0.3 },
        // Inner band: p25 → p75
        { data: p25, fill: { target: 3 }, backgroundColor: 'rgba(74,222,128,0.32)', borderWidth: 0, pointRadius: 0, tension: 0.3 },
        { data: p75, fill: false, borderWidth: 0, pointRadius: 0, tension: 0.3 },
        // Median line
        { data: p50, fill: false, borderColor: '#22c55e', borderWidth: 2.5, pointRadius: 3, pointBackgroundColor: '#22c55e', tension: 0.3 },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          filter: item => item.datasetIndex === 4,
          callbacks: {
            title:  items => items[0]?.label || '',
            label:  item  => {
              const i = item.dataIndex;
              return [
                `Typical runner: ${fmt(p50[i])}`,
                `Half of runners: ${fmt(p25[i])} – ${fmt(p75[i])}`,
                `Most runners: ${fmt(p10[i])} – ${fmt(p90[i])}`,
              ];
            },
          }
        }
      },
      scales: {
        x: {
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#9ca3af', maxRotation: 35, font: { size: 11 } },
        },
        y: {
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#9ca3af', callback: val => elapsedToTimeOfDay(val) },
          title: { display: true, text: 'Time of day', color: '#9ca3af', font: { size: 11 } },
        }
      }
    },
    plugins: [nightPlugin]
  });
}

// ─────────────────────────────────────────────
//  Init
// ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const [modelRes, runnersRes] = await Promise.all([
      fetch('model.json'),
      fetch('named_runners.json'),
    ]);
    if (!modelRes.ok)   throw new Error(`model.json: HTTP ${modelRes.status}`);
    if (!runnersRes.ok) throw new Error(`named_runners.json: HTTP ${runnersRes.status}`);
    model        = await modelRes.json();
    namedRunners = await runnersRes.json();
  } catch (err) {
    document.getElementById('explore-loading').innerHTML =
      '<p style="color:#f87171;padding:2rem">Failed to load race data.</p>';
    return;
  }

  document.getElementById('explore-loading').classList.add('hidden');
  document.getElementById('explore-ui').classList.remove('hidden');

  renderStats();
  renderTopTen();
  requestAnimationFrame(() => {
    renderSpreadChart();
    renderFinishHistogram();
  });
});
