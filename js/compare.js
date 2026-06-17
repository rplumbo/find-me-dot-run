// ─────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────

const RACE_START_HOUR = 8;

const AID_STATIONS = [
  { name: "Split Rock",    distance: 8.4  },
  { name: "Beaver Bay",    distance: 18.7 },
  { name: "Silver Bay",    distance: 23.0 },
  { name: "Tettegouche",   distance: 33.1 },
  { name: "County Road 6", distance: 42.4 },
  { name: "Finland",       distance: 50.0 },
  { name: "Sonju Lake Rd", distance: 57.7 },
  { name: "Crosby",        distance: 62.0 },
  { name: "Sugarloaf",     distance: 71.5 },
  { name: "Cramer Road",   distance: 77.0 },
  { name: "Temperance",    distance: 83.9 },
  { name: "Sawbill",       distance: 89.2 },
  { name: "Oberg",         distance: 94.8 },
  { name: "Finish",        distance: 102.0 },
];

// Up to three races; colors mirror the year-over-year chart palette in lookup.js.
const MAX_RACES      = 3;
const COMPARE_COLORS = ['#22c55e', '#60a5fa', '#f59e0b'];

// ─────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────

let namedRunners  = [];
let runnersByName = new Map();   // normalized name → { displayName, entries: [{year, splits}] }
let selected      = [];          // [{ key, displayName, year, splits }]  (max 3)
let compareChart  = null;

// ─────────────────────────────────────────────
//  Time Formatting  (identical to the rest of the app)
// ─────────────────────────────────────────────

function minToClockStr(minutesFromStart) {
  if (minutesFromStart === null) return '—';
  const total     = RACE_START_HOUR * 60 + minutesFromStart;
  const dayOffset = Math.floor(total / 1440);
  const h24       = Math.floor(total / 60) % 24;
  const m         = total % 60;
  const ampm      = h24 >= 12 ? 'PM' : 'AM';
  const h12       = h24 % 12 === 0 ? 12 : h24 % 12;
  const day       = dayOffset === 0 ? 'Fri' : dayOffset === 1 ? 'Sat' : 'Sun';
  return `${h12}:${String(m).padStart(2,'0')} ${ampm} <span class="day-tag-inline">${day}</span>`;
}

function minToFinishStr(minutesFromStart) {
  if (minutesFromStart === null) return null;
  const h = Math.floor(minutesFromStart / 60);
  const m = minutesFromStart % 60;
  return `${h}:${String(m).padStart(2,'0')}`;
}

// ─────────────────────────────────────────────
//  Data Loading  (identical grouping to the lookup page)
// ─────────────────────────────────────────────

async function loadData() {
  const res = await fetch('named_runners.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  namedRunners = await res.json();

  // Group by normalized name
  for (const r of namedRunners) {
    const key = r.name.trim().toLowerCase();
    if (!runnersByName.has(key)) runnersByName.set(key, { displayName: r.name, entries: [] });
    runnersByName.get(key).entries.push({ year: r.year, splits: r.splits });
  }

  // Sort each runner's entries by year
  for (const v of runnersByName.values()) {
    v.entries.sort((a, b) => a.year - b.year);
  }
}

// ─────────────────────────────────────────────
//  Search → pick a Runner-Year instance
// ─────────────────────────────────────────────

function isSelected(key, year) {
  return selected.some(s => s.key === key && s.year === year);
}

function handleSearch(query) {
  const resultsEl = document.getElementById('search-results');
  const q = query.trim().toLowerCase();

  if (q.length < 2) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    return;
  }

  const matches = [];
  for (const [key, val] of runnersByName) {
    if (key.includes(q)) matches.push([key, val]);
  }

  matches.sort((a, b) => a[1].displayName.localeCompare(b[1].displayName));

  if (matches.length === 0) {
    resultsEl.innerHTML = '<div class="search-empty">No runners found</div>';
    resultsEl.classList.remove('hidden');
    return;
  }

  const atMax = selected.length >= MAX_RACES;

  resultsEl.innerHTML = matches.slice(0, 40).map(([key, val]) => {
    const pills = val.entries.map(e => {
      const sel      = isSelected(key, e.year);
      const disabled = sel || atMax;
      return `<button class="year-tab cmp-year-pill${sel ? ' active' : ''}" data-key="${key}" data-year="${e.year}"${disabled ? ' disabled' : ''}>${e.year}</button>`;
    }).join('');
    return `<div class="cmp-result-row">
      <span class="result-name">${val.displayName}</span>
      <div class="cmp-result-years">${pills}</div>
    </div>`;
  }).join('');

  resultsEl.classList.remove('hidden');

  resultsEl.querySelectorAll('.cmp-year-pill:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => addRace(btn.dataset.key, parseInt(btn.dataset.year, 10)));
  });
}

// ─────────────────────────────────────────────
//  Selection
// ─────────────────────────────────────────────

function addRace(key, year) {
  if (selected.length >= MAX_RACES || isSelected(key, year)) return;
  const val   = runnersByName.get(key);
  const entry = val.entries.find(e => e.year === year);
  if (!entry) return;

  selected.push({ key, displayName: val.displayName, year, splits: entry.splits });
  refresh();
}

function removeRace(idx) {
  selected.splice(idx, 1);
  refresh();
}

// Re-render every piece that depends on the current selection.
function refresh() {
  renderSelected();
  renderResults();
  handleSearch(document.getElementById('name-search').value); // refresh pill states
}

function raceLabel(race) {
  return `${race.displayName} ${race.year}`;
}

function renderSelected() {
  const el    = document.getElementById('selected-races');
  const atMax = selected.length >= MAX_RACES;

  if (selected.length === 0) {
    el.innerHTML = '<p class="cmp-empty">No races picked yet — search below to add up to three.</p>';
  } else {
    el.innerHTML = selected.map((race, i) => {
      const finish = minToFinishStr(race.splits[13]);
      const meta   = finish ? `${race.year} · Finish ${finish}` : `${race.year} · DNF`;
      return `<div class="cmp-chip" style="--chip-color:${COMPARE_COLORS[i]}">
        <span class="cmp-chip-dot"></span>
        <div class="cmp-chip-text">
          <span class="cmp-chip-name">${race.displayName}</span>
          <span class="cmp-chip-meta">${meta}</span>
        </div>
        <button class="cmp-chip-remove" data-idx="${i}" title="Remove">✕</button>
      </div>`;
    }).join('');

    el.querySelectorAll('.cmp-chip-remove').forEach(btn => {
      btn.addEventListener('click', () => removeRace(parseInt(btn.dataset.idx, 10)));
    });
  }

  const hint = document.getElementById('cmp-hint');
  if (atMax) {
    hint.textContent = "That's three races — remove one to add another.";
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
}

// ─────────────────────────────────────────────
//  Results — chart + table
// ─────────────────────────────────────────────

function renderResults() {
  const section = document.getElementById('compare-results');

  if (selected.length === 0) {
    section.classList.add('hidden');
    if (compareChart) { compareChart.destroy(); compareChart = null; }
    return;
  }

  section.classList.remove('hidden');
  document.getElementById('compare-subtitle').textContent =
    selected.map(raceLabel).join('  vs  ');

  renderCompareChart();
  renderCompareTable();
}

function renderCompareTable() {
  document.getElementById('compare-head').innerHTML =
    `<th>Checkpoint</th><th>Miles</th>` +
    selected.map((race, i) => `<th class="cmp-col-head">
      <div class="cmp-col-inner">
        <span class="cmp-col-dot" style="background:${COMPARE_COLORS[i]}"></span>
        <span class="cmp-col-name">${race.displayName}</span>
        <span class="cmp-col-year">${race.year}</span>
      </div>
    </th>`).join('');

  const tbody = document.getElementById('compare-tbody');
  tbody.innerHTML = AID_STATIONS.map((station, k) => {
    const isFinish = k === AID_STATIONS.length - 1;
    const cells = selected.map(race => {
      const t = race.splits[k];
      return t !== null
        ? `<td>${minToClockStr(t)}</td>`
        : `<td class="cmp-dns">—</td>`;
    }).join('');
    return `<tr${isFinish ? ' class="pace-finish-row"' : ''}>
      <td class="td-station">${station.name}</td>
      <td class="td-range">${station.distance}</td>
      ${cells}
    </tr>`;
  }).join('');
}

function renderCompareChart() {
  const labels   = AID_STATIONS.map(s => s.name);
  const datasets = selected.map((race, i) => ({
    label:                raceLabel(race),
    data:                 race.splits.map(t => t !== null ? +(t / 60).toFixed(3) : null),
    borderColor:          COMPARE_COLORS[i],
    pointBackgroundColor: COMPARE_COLORS[i],
    borderWidth:          2,
    pointRadius:          3,
    tension:              0.2,
    spanGaps:             false,
  }));

  // The chart-wrap is visible now; defer one frame so Chart.js measures it correctly.
  requestAnimationFrame(() => {
    if (compareChart) { compareChart.destroy(); compareChart = null; }
    const ctx = document.getElementById('compare-chart').getContext('2d');
    compareChart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, labels: { color: '#9ca3af', boxWidth: 14, padding: 16 } },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: item => {
                if (item.raw === null) return `${item.dataset.label}: DNF`;
                const h = Math.floor(item.raw);
                const m = Math.round((item.raw - h) * 60);
                return `${item.dataset.label}: ${h}h ${String(m).padStart(2,'0')}m`;
              }
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
            ticks: { color: '#9ca3af', callback: val => `${val}h` },
            title: { display: true, text: 'Elapsed time', color: '#9ca3af', font: { size: 11 } },
          }
        }
      }
    });
  });
}

// ─────────────────────────────────────────────
//  Init
// ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadData();
  } catch (err) {
    document.getElementById('compare-loading').innerHTML =
      '<p style="color:#f87171;padding:2rem">Failed to load runner data.</p>';
    return;
  }

  document.getElementById('compare-loading').classList.add('hidden');
  document.getElementById('compare-ui').classList.remove('hidden');

  renderSelected();

  const searchEl = document.getElementById('name-search');
  searchEl.addEventListener('input', e => handleSearch(e.target.value));
  searchEl.focus();
});
