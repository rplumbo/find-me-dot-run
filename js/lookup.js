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

// ─────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────

let namedRunners  = [];
let runnersByName = new Map();   // normalized name → [{year, splits}, ...]
let activeRunner  = null;        // { displayName, entries: [{year, splits}] }
let activeYear    = null;
let yearChart     = null;

// ─────────────────────────────────────────────
//  Time Formatting
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

function minToSegStr(minutes) {
  if (minutes === null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─────────────────────────────────────────────
//  Data Loading
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
//  Search
// ─────────────────────────────────────────────

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
    if (key.includes(q)) matches.push(val);
  }

  matches.sort((a, b) => a.displayName.localeCompare(b.displayName));

  if (matches.length === 0) {
    resultsEl.innerHTML = '<div class="search-empty">No runners found</div>';
    resultsEl.classList.remove('hidden');
    return;
  }

  resultsEl.innerHTML = matches.slice(0, 40).map(v => {
    const years = v.entries.map(e => e.year).join(', ');
    return `<button class="search-result-row" data-key="${v.displayName.trim().toLowerCase()}">
      <span class="result-name">${v.displayName}</span>
      <span class="result-years">${years}</span>
    </button>`;
  }).join('');

  resultsEl.classList.remove('hidden');

  resultsEl.querySelectorAll('.search-result-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      selectRunner(runnersByName.get(key));
    });
  });
}

// ─────────────────────────────────────────────
//  Runner Detail
// ─────────────────────────────────────────────

function selectRunner(runnerData) {
  activeRunner = runnerData;
  activeYear   = runnerData.entries[runnerData.entries.length - 1].year; // default: most recent

  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('name-search').value = runnerData.displayName;
  document.getElementById('runner-name').textContent = runnerData.displayName;
  document.getElementById('runner-detail').classList.remove('hidden');

  renderYearTabs();
  renderSplitsTable();
  renderYearChart();
  document.getElementById('runner-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderYearTabs() {
  const tabsEl = document.getElementById('year-tabs');
  if (activeRunner.entries.length <= 1) {
    tabsEl.innerHTML = `<span class="year-single">${activeRunner.entries[0].year}</span>`;
    return;
  }
  tabsEl.innerHTML = activeRunner.entries.map(e =>
    `<button class="year-tab${e.year === activeYear ? ' active' : ''}" data-year="${e.year}">${e.year}</button>`
  ).join('');

  tabsEl.querySelectorAll('.year-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeYear = parseInt(btn.dataset.year, 10);
      renderYearTabs();
      renderSplitsTable();
    });
  });
}

function renderSplitsTable() {
  const entry      = activeRunner.entries.find(e => e.year === activeYear);
  const splits     = entry.splits;
  const finishMins = splits[splits.length - 1];
  const finishStr  = minToFinishStr(finishMins);

  // Finish time banner
  const headerCard = document.getElementById('runner-finish');
  if (finishStr) {
    headerCard.innerHTML = `<span class="finish-label">Finish time</span><span class="finish-time">${finishStr}</span>`;
    headerCard.classList.remove('hidden');
  } else {
    headerCard.innerHTML = `<span class="finish-label">Did not finish</span>`;
    headerCard.classList.remove('hidden');
    headerCard.classList.add('dnf');
  }

  const tbody = document.getElementById('history-tbody');
  tbody.innerHTML = AID_STATIONS.map((station, k) => {
    const t    = splits[k];
    const prev = k > 0 ? splits.slice(0, k).reverse().find(s => s !== null) : null;
    const seg  = (t !== null && prev !== null) ? t - prev : null;

    return `<tr${t === null ? ' class="dns-row"' : ''}>
      <td class="td-station">${station.name}</td>
      <td>${station.distance}</td>
      <td>${t !== null ? minToClockStr(t) : '—'}</td>
      <td class="seg-cell">${seg !== null ? minToSegStr(seg) : '—'}</td>
    </tr>`;
  }).join('');
}

// ─────────────────────────────────────────────
//  Year comparison chart
// ─────────────────────────────────────────────

const YEAR_COLORS = ['#22c55e','#60a5fa','#f59e0b','#f472b6','#a78bfa','#34d399','#fb923c'];

function renderYearChart() {
  const chartCard = document.getElementById('year-chart-card');

  if (activeRunner.entries.length < 2) {
    chartCard.classList.add('hidden');
    if (yearChart) { yearChart.destroy(); yearChart = null; }
    return;
  }

  if (yearChart) { yearChart.destroy(); yearChart = null; }

  const labels   = AID_STATIONS.map(s => s.name);
  const datasets = activeRunner.entries.map((entry, i) => ({
    label:            String(entry.year),
    data:             entry.splits.map(t => t !== null ? +(t / 60).toFixed(3) : null),
    borderColor:      YEAR_COLORS[i % YEAR_COLORS.length],
    pointBackgroundColor: YEAR_COLORS[i % YEAR_COLORS.length],
    borderWidth:      2,
    pointRadius:      3,
    tension:          0.2,
    spanGaps:         false,
  }));

  chartCard.classList.remove('hidden');

  // Wait for layout after un-hiding before Chart.js reads dimensions
  setTimeout(() => {
  const ctx = document.getElementById('year-chart').getContext('2d');
  yearChart = new Chart(ctx, {
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
  }, 50); // end setTimeout
}

// ─────────────────────────────────────────────
//  Init
// ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadData();
  } catch (err) {
    document.getElementById('lookup-loading').innerHTML =
      '<p style="color:#f87171;padding:2rem">Failed to load runner data.</p>';
    return;
  }

  document.getElementById('lookup-loading').classList.add('hidden');
  document.getElementById('lookup-ui').classList.remove('hidden');

  const searchEl = document.getElementById('name-search');
  searchEl.addEventListener('input', e => handleSearch(e.target.value));
  searchEl.focus();
});
