// ─────────────────────────────────────────────
//  Track Runner dashboard
// ─────────────────────────────────────────────

const STORAGE_KEY = 's100-track-state-v1';
const BANDWIDTH = 30;
const ARRIVE_BUFFER_MIN = 15;

let model = null;
let namedRunners = [];
let runnersByName = new Map();
let selectedRunner = null;
let sightings = [];
let predictionWindow = '80';
let RACE_START_HOUR = 8;
let AID_STATIONS = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function normalizeName(name) {
  return name.trim().toLowerCase();
}

async function loadData() {
  const [modelRes, runnersRes] = await Promise.all([
    fetch('model.json'),
    fetch('named_runners.json'),
  ]);
  if (!modelRes.ok) throw new Error(`model.json: HTTP ${modelRes.status}`);
  if (!runnersRes.ok) throw new Error(`named_runners.json: HTTP ${runnersRes.status}`);

  model = await modelRes.json();
  namedRunners = await runnersRes.json();
  RACE_START_HOUR = model.raceStartHour;
  AID_STATIONS = model.stations;

  for (const r of namedRunners) {
    const key = normalizeName(r.name);
    if (!runnersByName.has(key)) runnersByName.set(key, { key, displayName: r.name, entries: [] });
    runnersByName.get(key).entries.push({ year: r.year, splits: r.splits });
  }
  for (const runner of runnersByName.values()) {
    runner.entries.sort((a, b) => a.year - b.year);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    if (state.version !== 1) return;
    selectedRunner = state.selectedRunner || null;
    sightings = Array.isArray(state.sightings) ? state.sightings : [];
  } catch {
    selectedRunner = null;
    sightings = [];
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    selectedRunner,
    sightings,
    savedAt: new Date().toISOString(),
  }));
}

function gaussianWeight(diff) {
  return Math.exp(-0.5 * (diff / BANDWIDTH) ** 2);
}

function weightedPct(sortedSamples, totalW, p) {
  let cum = 0;
  for (const { t, w } of sortedSamples) {
    cum += w;
    if (cum / totalW >= p) return t;
  }
  return sortedSamples[sortedSamples.length - 1].t;
}

function predict(observations, targetStationIdx) {
  const relevantObs = observations.filter(o => o.stationIndex < targetStationIdx);
  if (relevantObs.length === 0) return null;

  const samples = [];
  for (const runner of model.runners) {
    let w = 1;
    for (const obs of relevantObs) {
      const t = runner[obs.stationIndex];
      if (t === null) { w = 0; break; }
      w *= gaussianWeight(t - obs.minutesFromStart);
    }
    if (w < 1e-9) continue;

    const tTarget = runner[targetStationIdx];
    if (tTarget === null) continue;
    samples.push({ t: tTarget, w });
  }

  if (samples.length < 5) return null;
  samples.sort((a, b) => a.t - b.t);
  const totalW = samples.reduce((s, x) => s + x.w, 0);
  const effN = totalW ** 2 / samples.reduce((s, x) => s + x.w ** 2, 0);

  return {
    p0: weightedPct(samples, totalW, 0),
    p10: weightedPct(samples, totalW, 0.10),
    p25: weightedPct(samples, totalW, 0.25),
    p50: weightedPct(samples, totalW, 0.50),
    p75: weightedPct(samples, totalW, 0.75),
    p90: weightedPct(samples, totalW, 0.90),
    p100: weightedPct(samples, totalW, 1),
    effectiveN: Math.round(effN),
  };
}

function minToClockObj(minutesFromStart) {
  const total = RACE_START_HOUR * 60 + Math.round(minutesFromStart);
  const dayOffset = Math.floor(total / 1440);
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const day = dayOffset === 0 ? 'Fri' : dayOffset === 1 ? 'Sat' : 'Sun';
  return { display: `${h12}:${String(m).padStart(2, '0')} ${ampm}`, day, dayOffset };
}

function minToClockStr(minutesFromStart) {
  const o = minToClockObj(minutesFromStart);
  return `${o.display} <span class="day-tag-inline">${o.day}</span>`;
}

function minToElapsed(minutesFromStart) {
  if (minutesFromStart === null) return 'DNF';
  const h = Math.floor(minutesFromStart / 60);
  const m = minutesFromStart % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function minToSeg(minutes) {
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const text = h ? `${h}h ${m}m` : `${m}m`;
  return minutes < 0 ? `${text} faster` : `${text} slower`;
}

function clockDropdownToMinutes(h12, minVal, ampm, dayOffset) {
  let h = parseInt(h12, 10);
  const m = parseInt(minVal, 10);
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return dayOffset * 1440 + h * 60 + m - RACE_START_HOUR * 60;
}

function defaultDayForStation(idx) {
  const s = model.stationStats[idx];
  return s && s.p50 >= 16 * 60 ? 1 : 0;
}

function roundedToFive(minutes) {
  return Math.round(minutes / 5) * 5;
}

function setTimeSelectsFromMinutes(minutes) {
  const total = RACE_START_HOUR * 60 + Math.max(0, roundedToFive(minutes));
  const dayOffset = Math.floor(total / 1440);
  const h24 = Math.floor(total / 60) % 24;
  const minute = total % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;

  document.getElementById('sighting-hour').value = String(h12);
  document.getElementById('sighting-minute').value = String(minute).padStart(2, '0');
  document.getElementById('sighting-ampm').value = ampm;
  document.getElementById('sighting-day').value = String(Math.min(dayOffset, 1));
}

function setupControls() {
  document.getElementById('sighting-station').innerHTML = AID_STATIONS.map((s, i) =>
    `<option value="${i}">${escapeHtml(s.name)} (mi ${s.distance})</option>`
  ).join('');
  document.getElementById('sighting-hour').innerHTML = Array.from({ length: 12 }, (_, i) => i + 1)
    .map(h => `<option value="${h}">${h}</option>`).join('');
  document.getElementById('sighting-minute').innerHTML = Array.from({ length: 12 }, (_, i) => i * 5)
    .map(m => {
      const v = String(m).padStart(2, '0');
      return `<option value="${v}">${v}</option>`;
    }).join('');
  document.getElementById('sighting-ampm').innerHTML = ['AM', 'PM']
    .map(v => `<option value="${v}">${v}</option>`).join('');
  document.getElementById('sighting-day').innerHTML =
    '<option value="0">Fri</option><option value="1">Sat</option>';

  const windowSelect = document.getElementById('prediction-window-select');
  predictionWindow = '80';
  windowSelect.value = predictionWindow;
  windowSelect.addEventListener('change', () => {
    predictionWindow = windowSelect.value;
    renderCheckpointPlan();
  });

  document.getElementById('sighting-station').addEventListener('change', () => {
    const idx = parseInt(document.getElementById('sighting-station').value, 10);
    setTimeSelectsFromMinutes(model.stationStats[idx]?.p50 || 0);
  });
}

function chooseDefaultSightingStation() {
  const lastIdx = sightings.length ? Math.max(...sightings.map(s => s.stationIndex)) : -1;
  const nextIdx = Math.min(lastIdx + 1, AID_STATIONS.length - 1);
  document.getElementById('sighting-station').value = String(nextIdx);
  setTimeSelectsFromMinutes(model.stationStats[nextIdx]?.p50 || 0);
}

function runnerHistory() {
  if (!selectedRunner || !selectedRunner.key) return null;
  return runnersByName.get(selectedRunner.key) || null;
}

function selectHistoricalRunner(runner) {
  selectedRunner = {
    key: runner.key,
    name: runner.displayName,
    kind: 'historical',
  };
  saveState();
  render();
}

function selectFirstTimeRunner(name = '') {
  const cleanName = name.trim();
  selectedRunner = {
    key: normalizeName(cleanName || 'first time runner'),
    name: cleanName || 'First Time Runner',
    kind: 'first-time',
  };
  saveState();
  render();
}

function resetRunnerPicker() {
  selectedRunner = null;
  saveState();
  render();
  document.getElementById('runner-search').focus();
}

function handleRunnerSearch(query) {
  const resultsEl = document.getElementById('runner-results');
  const q = normalizeName(query);
  if (q.length < 2) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    return;
  }

  const matchRank = key => {
    if (key === q) return 0;
    if (key.startsWith(q)) return 1;
    if (key.split(/\s+/).some(part => part.startsWith(q))) return 2;
    return 3;
  };

  const matches = [];
  for (const [key, runner] of runnersByName) {
    if (key.includes(q)) matches.push(runner);
  }
  matches.sort((a, b) => matchRank(a.key) - matchRank(b.key) || a.displayName.localeCompare(b.displayName));

  if (!matches.length) {
    const label = query.trim() ? `First Time Runner: ${query.trim()}` : 'First Time Runner';
    resultsEl.innerHTML = `<button class="search-result-row first-time-result" data-first-time="1">
      <span class="result-name">${escapeHtml(label)}</span>
      <span class="result-years">No history</span>
    </button>`;
    resultsEl.classList.remove('hidden');
    resultsEl.querySelector('[data-first-time]').addEventListener('click', () => selectFirstTimeRunner(query));
    return;
  }

  resultsEl.innerHTML = matches.slice(0, 30).map(runner => {
    const years = runner.entries.map(e => e.year).join(', ');
    return `<button class="search-result-row" data-key="${escapeHtml(runner.key)}">
      <span class="result-name">${escapeHtml(runner.displayName)}</span>
      <span class="result-years">${escapeHtml(years)}</span>
    </button>`;
  }).join('');
  resultsEl.classList.remove('hidden');

  resultsEl.querySelectorAll('.search-result-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const runner = runnersByName.get(btn.dataset.key);
      if (runner) selectHistoricalRunner(runner);
    });
  });
}

function readSightingForm() {
  const stationIndex = parseInt(document.getElementById('sighting-station').value, 10);
  const hr = document.getElementById('sighting-hour').value;
  const mn = document.getElementById('sighting-minute').value;
  const ap = document.getElementById('sighting-ampm').value;
  const day = parseInt(document.getElementById('sighting-day').value, 10);
  return {
    stationIndex,
    minutesFromStart: clockDropdownToMinutes(hr, mn, ap, day),
    enteredAt: new Date().toISOString(),
  };
}

function showError(message) {
  const el = document.getElementById('track-error');
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 7000);
}

function saveSighting() {
  const sighting = readSightingForm();
  if (sighting.minutesFromStart < 0) {
    showError('That time is before the 8:00 AM race start. Check the day and time.');
    return;
  }

  const stats = model.stationStats[sighting.stationIndex];
  if (stats && (sighting.minutesFromStart < stats.min - 120 || sighting.minutesFromStart > stats.max + 120)) {
    showError(`That ${AID_STATIONS[sighting.stationIndex].name} time is outside the normal historical range.`);
    return;
  }

  const existingIdx = sightings.findIndex(s => s.stationIndex === sighting.stationIndex);
  if (existingIdx >= 0) sightings[existingIdx] = sighting;
  else sightings.push(sighting);
  sightings.sort((a, b) => a.stationIndex - b.stationIndex);

  saveState();
  chooseDefaultSightingStation();
  closeSightingSheet();
  render();
}

function removeSighting(stationIndex) {
  sightings = sightings.filter(s => s.stationIndex !== stationIndex);
  saveState();
  chooseDefaultSightingStation();
  render();
}

function openSightingSheet(stationIndex = null) {
  if (stationIndex !== null) {
    document.getElementById('sighting-station').value = String(stationIndex);
    const existing = sightings.find(s => s.stationIndex === stationIndex);
    setTimeSelectsFromMinutes(existing ? existing.minutesFromStart : (model.stationStats[stationIndex]?.p50 || 0));
  } else {
    chooseDefaultSightingStation();
  }
  const sheet = document.getElementById('sighting-sheet');
  sheet.classList.remove('hidden');
  sheet.setAttribute('aria-hidden', 'false');
  document.getElementById('sighting-station').focus();
}

function closeSightingSheet() {
  const sheet = document.getElementById('sighting-sheet');
  sheet.classList.add('hidden');
  sheet.setAttribute('aria-hidden', 'true');
}

function renderSelectedRunner() {
  const picker = document.getElementById('runner-picker');
  const selected = document.getElementById('selected-runner');
  const desc = document.getElementById('runner-card-desc');

  if (!selectedRunner) {
    picker.classList.remove('hidden');
    selected.classList.add('hidden');
    desc.classList.remove('hidden');
    return;
  }

  const history = runnerHistory();
  const sub = history
    ? `${history.entries.length} prior Superior ${history.entries.length === 1 ? 'start' : 'starts'}`
    : 'First time runner';

  picker.classList.add('hidden');
  desc.classList.add('hidden');
  selected.classList.remove('hidden');
  selected.innerHTML = `
    <div class="track-runner-selected">
      <div>
        <div class="track-runner-name">${escapeHtml(selectedRunner.name)}</div>
        <div class="track-runner-sub">${escapeHtml(sub)}</div>
      </div>
      <button id="selected-change-runner-btn" class="track-runner-status">Change</button>
    </div>`;
  document.getElementById('selected-change-runner-btn').addEventListener('click', resetRunnerPicker);
}

function latestStationIndex() {
  return sightings.length ? Math.max(...sightings.map(s => s.stationIndex)) : -1;
}

function predictionRange(pred) {
  if (predictionWindow === '100') {
    return {
      early: minToClockObj(pred.p0),
      expected: minToClockObj(pred.p50),
      late: minToClockObj(pred.p100),
    };
  }
  if (predictionWindow === '50') {
    return {
      early: minToClockObj(pred.p25),
      expected: minToClockObj(pred.p50),
      late: minToClockObj(pred.p75),
    };
  }
  return {
    early: minToClockObj(pred.p10),
    expected: minToClockObj(pred.p50),
    late: minToClockObj(pred.p90),
  };
}

function renderCheckpointPlan() {
  const list = document.getElementById('checkpoint-plan-list');
  const note = document.getElementById('checkpoint-plan-note');
  const lastIdx = latestStationIndex();
  const actualByStation = new Map(sightings.map(s => [s.stationIndex, s]));
  const nextIdx = lastIdx >= 0 ? lastIdx + 1 : -1;

  let noteText = '';
  if (!selectedRunner) {
    noteText = 'Choose a runner, then add the first sighting to start forecasting.';
  } else if (lastIdx >= AID_STATIONS.length - 1) {
    noteText = 'Finish sighting saved. All known race-day data is shown below.';
  }
  note.textContent = noteText;
  note.classList.toggle('hidden', !noteText);
  document.getElementById('prediction-window-control')
    .classList.toggle('hidden', !selectedRunner || !sightings.length || lastIdx >= AID_STATIONS.length - 1);
  document.getElementById('checkpoint-action-note')
    .classList.toggle('hidden', !selectedRunner);

  const stationIndexes = sightings.length
    ? [
        ...sightings.map(s => s.stationIndex).sort((a, b) => a - b),
        ...AID_STATIONS.map((_, i) => i).filter(i => i > lastIdx),
      ]
    : AID_STATIONS.map((_, i) => i);

  list.innerHTML = stationIndexes.map(stationIndex => {
    const station = AID_STATIONS[stationIndex];
    const actual = actualByStation.get(stationIndex);
    const markAttrs = selectedRunner ? ` data-mark-station="${stationIndex}" role="button" tabindex="0"` : '';
    if (actual) {
      return `<div class="checkpoint-row is-actual"${markAttrs}>
        <div>
          <div class="checkpoint-name">${escapeHtml(station.name)}</div>
          <div class="checkpoint-meta">Mile ${station.distance}</div>
        </div>
        <div class="checkpoint-time">
          <div class="checkpoint-main">${minToClockStr(actual.minutesFromStart)}</div>
        </div>
        <button class="track-icon-btn" data-remove-station="${stationIndex}" title="Remove sighting">×</button>
      </div>`;
    }

    if (!sightings.length) {
      return `<div class="checkpoint-row is-empty"${markAttrs}>
      <div>
        <div class="checkpoint-name">${escapeHtml(station.name)}</div>
        <div class="checkpoint-meta">Mile ${station.distance}</div>
      </div>
      <div class="checkpoint-time muted">No data yet</div>
    </div>`;
    }

    const pred = predict(sightings, stationIndex);
    if (!pred) {
      return `<div class="checkpoint-row is-empty"${markAttrs}>
      <div>
        <div class="checkpoint-name">${escapeHtml(station.name)}</div>
        <div class="checkpoint-meta">Mile ${station.distance}</div>
      </div>
      <div class="checkpoint-time muted">Not enough data</div>
    </div>`;
    }

    const isNext = stationIndex === nextIdx;
    const range = predictionRange(pred);
    return `<div class="checkpoint-row is-estimate${isNext ? ' is-next' : ''}"${markAttrs}>
      <div>
        <div class="checkpoint-name">${escapeHtml(station.name)}</div>
        <div class="checkpoint-meta">Mile ${station.distance}</div>
      </div>
      <div class="checkpoint-time checkpoint-range">
        <div class="range-line range-muted">
          <span>Earliest</span>
          <strong>${range.early.display} <span class="day-tag-inline">${range.early.day}</span></strong>
        </div>
        <div class="range-line range-expected">
          <span>Expected</span>
          <strong>${range.expected.display} <span class="day-tag-inline">${range.expected.day}</span></strong>
        </div>
        <div class="range-line range-muted">
          <span>Latest</span>
          <strong>${range.late.display} <span class="day-tag-inline">${range.late.day}</span></strong>
        </div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-remove-station]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      removeSighting(parseInt(btn.dataset.removeStation, 10));
    });
  });
  list.querySelectorAll('[data-mark-station]').forEach(row => {
    const stationIndex = parseInt(row.dataset.markStation, 10);
    row.addEventListener('click', () => openSightingSheet(stationIndex));
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openSightingSheet(stationIndex);
    });
  });
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function renderHistory() {
  const historySection = document.getElementById('history-section');
  const emptySection = document.getElementById('empty-history-section');
  const history = runnerHistory();

  if (!selectedRunner) {
    historySection.classList.add('hidden');
    emptySection.classList.add('hidden');
    return;
  }

  if (!history) {
    historySection.classList.add('hidden');
    emptySection.classList.remove('hidden');
    return;
  }

  emptySection.classList.add('hidden');
  historySection.classList.remove('hidden');

  const finishes = history.entries.map(e => e.splits[13]).filter(t => t !== null);
  const best = finishes.length ? Math.min(...finishes) : null;
  const latest = history.entries[history.entries.length - 1];

  document.getElementById('history-summary').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${history.entries.length}</div>
      <div class="stat-label">Starts</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${finishes.length}</div>
      <div class="stat-label">Finishes</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${best === null ? 'DNF' : minToElapsed(best)}</div>
      <div class="stat-label">Best</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${latest.year}</div>
      <div class="stat-label">Latest Run</div>
    </div>`;

  const comparison = sightings.map(s => {
    const values = history.entries.map(e => e.splits[s.stationIndex]).filter(t => t !== null);
    const expectedSplit = median(values);
    const station = AID_STATIONS[s.stationIndex];
    if (expectedSplit === null) {
      return `<div class="track-list-row">
        <div>
          <div class="track-row-title">${escapeHtml(station.name)}</div>
          <div class="track-row-sub">No personal split history here</div>
        </div>
        <div class="track-row-main">${minToClockStr(s.minutesFromStart)}</div>
      </div>`;
    }
    const delta = s.minutesFromStart - expectedSplit;
    const deltaClass = delta <= 0 ? 'good' : 'slow';
    return `<div class="track-list-row">
      <div>
        <div class="track-row-title">${escapeHtml(station.name)}</div>
        <div class="track-row-sub">Expected from this runner's history ${minToClockStr(expectedSplit)}</div>
      </div>
      <div class="track-row-times">
        <div class="track-row-main">${minToClockStr(s.minutesFromStart)}</div>
        <div class="track-delta ${deltaClass}">${delta === 0 ? 'On expected pace' : minToSeg(delta)}</div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('history-comparison').innerHTML = comparison ||
    '<p class="section-desc">Add a sighting to compare today against this runner\'s historical checkpoints.</p>';

  document.getElementById('history-results').innerHTML = history.entries.slice().reverse().map(entry => {
    const finish = entry.splits[13] === null ? 'DNF' : minToElapsed(entry.splits[13]);
    const lastSeenIdx = entry.splits.reduce((last, t, i) => t !== null ? i : last, -1);
    const lastSeen = lastSeenIdx >= 0 ? AID_STATIONS[lastSeenIdx].name : 'No splits';
    return `<div class="track-list-row">
      <div>
        <div class="track-row-title">${entry.year}</div>
        <div class="track-row-sub">${escapeHtml(lastSeen)}</div>
      </div>
      <div class="track-row-main">${finish}</div>
    </div>`;
  }).join('');
}

function render() {
  renderSelectedRunner();
  renderCheckpointPlan();
  renderHistory();
}

function bindEvents() {
  document.getElementById('runner-search').addEventListener('input', e => handleRunnerSearch(e.target.value));
  document.getElementById('close-sighting-sheet-btn').addEventListener('click', closeSightingSheet);
  document.getElementById('sighting-sheet').addEventListener('click', e => {
    if (e.target.id === 'sighting-sheet') closeSightingSheet();
  });
  document.getElementById('save-sighting-btn').addEventListener('click', saveSighting);
}

async function init() {
  try {
    await loadData();
  } catch (err) {
    document.getElementById('track-loading').innerHTML =
      '<p style="color:#f87171;padding:2rem">Failed to load race data. Open this page once with a connection before relying on offline use.</p>';
    return;
  }

  loadState();
  setupControls();
  chooseDefaultSightingStation();
  bindEvents();
  document.getElementById('track-loading').classList.add('hidden');
  document.getElementById('track-ui').classList.remove('hidden');
  render();
}

document.addEventListener('DOMContentLoaded', init);
