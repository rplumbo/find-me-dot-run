// ─────────────────────────────────────────────
//  Track Runner dashboard
// ─────────────────────────────────────────────

const STORAGE_KEY = 's100-track-state-v1';

// Cohort definition; must match tools/backtest.py, which verifies the
// claims the UI makes about these statistics.
const COHORT_WINDOWS = [10, 15, 20];   // ± minutes around the sighting; widens until…
const COHORT_TARGET_SIZE = 40;         // …the cohort reaches this size
const MIN_COHORT_SIZE = 5;

const FINISH_WINDOW_MIN = 60;          // ± minutes for finish-anchored cohorts
const STOCK_FINISH_HOURS = [22, 24, 26, 28, 30, 32, 34, 36, 38];
const DEFAULT_STOCK_FINISH_HOUR = 30;

let model = null;
let namedRunners = [];
let runnersByName = new Map();
let selectedRunner = null;
let sightings = [];
let compareTarget = null;
let stockSplitsByHour = new Map();
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
    compareTarget = typeof state.compareTarget === 'string'
      ? state.compareTarget
      : Number.isInteger(state.compareYear) ? `runner:${state.compareYear}` : null;
  } catch {
    selectedRunner = null;
    sightings = [];
    compareTarget = null;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    selectedRunner,
    sightings,
    compareTarget,
    savedAt: new Date().toISOString(),
  }));
}

// Percentile rule: smallest sample value covering fraction p of the cohort.
// Shared with tools/backtest.py so verified claims match displayed numbers.
function cohortPct(sortedTimes, p) {
  const n = sortedTimes.length;
  let cum = 0;
  for (const t of sortedTimes) {
    cum += 1;
    if (cum / n >= p) return t;
  }
  return sortedTimes[n - 1];
}

/**
 * Cohort statistics for arrival at targetStationIdx.
 *
 * The cohort is every historical runner who reached the MOST RECENT sighted
 * station within ±window minutes of the sighting (the window widens
 * 10 → 15 → 20 only while the cohort has fewer than COHORT_TARGET_SIZE).
 * Earlier sightings are shown as actuals but do not constrain the cohort;
 * backtesting showed they add no predictive value at any lookback distance.
 *
 * Arrival times are the cohort's real section durations added to the
 * sighting time. Every returned number is a plain statistic of the cohort,
 * plus the all-years fastest-ever section duration ("record floor").
 */
function predict(observations, targetStationIdx) {
  const relevant = observations.filter(o => o.stationIndex < targetStationIdx);
  if (relevant.length === 0) return null;
  const latest = relevant.reduce((a, b) => (a.stationIndex > b.stationIndex ? a : b));

  let durations = [];
  let dnf = 0;
  let window = COHORT_WINDOWS[0];
  for (const w of COHORT_WINDOWS) {
    durations = [];
    dnf = 0;
    window = w;
    for (const runner of model.runners) {
      const split = runner[latest.stationIndex];
      if (split === null || Math.abs(split - latest.minutesFromStart) > w) continue;
      const target = runner[targetStationIdx];
      if (target === null) {
        // Not recorded at the target or any later station: the runner
        // stopped somewhere before it (drops happen only at aid stations).
        let seenLater = false;
        for (let k = targetStationIdx; k < runner.length; k++) {
          if (runner[k] !== null) { seenLater = true; break; }
        }
        if (!seenLater) dnf++;
        continue;
      }
      if (target < split) continue;
      durations.push(target - split);
    }
    if (durations.length >= COHORT_TARGET_SIZE) break;
  }

  if (durations.length < MIN_COHORT_SIZE) return null;
  const ts = durations.map(d => latest.minutesFromStart + d).sort((a, b) => a - b);

  const rec = model.sectionRecords?.[latest.stationIndex]?.[targetStationIdx] || null;
  return {
    recordFloor: rec ? latest.minutesFromStart + rec[0] : ts[0],
    recordYear: rec ? rec[1] : null,
    p0: ts[0],
    p05: cohortPct(ts, 0.05),
    p25: cohortPct(ts, 0.25),
    p50: cohortPct(ts, 0.50),
    p75: cohortPct(ts, 0.75),
    p95: cohortPct(ts, 0.95),
    n: ts.length,
    window,
    dnf,
    latestStationIndex: latest.stationIndex,
  };
}

/**
 * Goal-finish cohort: every runner who finished within ±FINISH_WINDOW_MIN
 * of the target. Returns band statistics of their actual splits at each
 * station (used for the pre-race plan), or null where under MIN_COHORT_SIZE.
 */
function finishCohortBands(targetMin) {
  const finishIdx = AID_STATIONS.length - 1;
  const cohort = model.runners.filter(r => {
    const f = r[finishIdx];
    return f !== null && Math.abs(f - targetMin) <= FINISH_WINDOW_MIN;
  });
  return AID_STATIONS.map((_, stationIndex) => {
    const ts = cohort
      .map(r => r[stationIndex])
      .filter(t => t !== null)
      .sort((a, b) => a - b);
    if (ts.length < MIN_COHORT_SIZE) return null;
    return {
      earliestEver: model.stationStats[stationIndex]?.min ?? ts[0],
      p0: ts[0],
      p25: cohortPct(ts, 0.25),
      p50: cohortPct(ts, 0.50),
      p75: cohortPct(ts, 0.75),
      p95: cohortPct(ts, 0.95),
      n: ts.length,
    };
  });
}

function typicalSplitsForFinish(targetMin) {
  const finishIdx = AID_STATIONS.length - 1;
  const cohort = model.runners.filter(r => {
    const f = r[finishIdx];
    return f !== null && Math.abs(f - targetMin) <= FINISH_WINDOW_MIN;
  });
  return AID_STATIONS.map((_, stationIndex) => {
    const ts = cohort
      .map(r => r[stationIndex])
      .filter(t => t !== null)
      .sort((a, b) => a - b);
    return ts.length ? cohortPct(ts, 0.50) : null;
  });
}

function stockSplits(hours) {
  if (!stockSplitsByHour.has(hours)) {
    stockSplitsByHour.set(hours, typicalSplitsForFinish(hours * 60));
  }
  return stockSplitsByHour.get(hours);
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

function minToDifference(minutes) {
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
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

  document.getElementById('compare-year-select').addEventListener('change', event => {
    compareTarget = event.target.value;
    saveState();
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

function compareOptions() {
  const history = runnerHistory();
  const options = [];

  if (history) {
    // Values are entry indexes, not years: two different people with the
    // same name (or a re-run year) would otherwise collide.
    const yearCounts = new Map();
    for (const entry of history.entries) {
      yearCounts.set(entry.year, (yearCounts.get(entry.year) || 0) + 1);
    }
    const yearSeen = new Map();
    history.entries.forEach((entry, index) => {
      const nth = (yearSeen.get(entry.year) || 0) + 1;
      yearSeen.set(entry.year, nth);
      const label = yearCounts.get(entry.year) > 1 ? `${entry.year} #${nth}` : String(entry.year);
      options.push({
        index,
        value: `runner:${index}`,
        label,
        entry: {
          label,
          kind: 'runner',
          splits: entry.splits,
        },
      });
    });
    options.reverse();
  }

  for (const hours of STOCK_FINISH_HOURS) {
    options.push({
      value: `stock:${hours}`,
      label: `${hours} hr`,
      entry: {
        label: `${hours} hr`,
        kind: 'stock',
        hours,
        splits: stockSplits(hours),
      },
    });
  }

  return options;
}

function syncCompareTarget() {
  const options = compareOptions();
  if (!options.some(option => option.value === compareTarget)) {
    const history = runnerHistory();
    compareTarget = history && history.entries.length
      ? `runner:${history.entries.length - 1}`
      : `stock:${DEFAULT_STOCK_FINISH_HOUR}`;
  }
  return options;
}

function comparisonEntry() {
  const options = syncCompareTarget();
  return options.find(option => option.value === compareTarget)?.entry || null;
}

function actualComparison(sighting) {
  const entry = comparisonEntry();
  if (!entry) return null;

  const comparisonTime = entry.splits[sighting.stationIndex];
  if (comparisonTime === null || comparisonTime === undefined) {
    return { text: `No ${entry.label} time here`, tone: 'neutral' };
  }

  const delta = sighting.minutesFromStart - comparisonTime;
  if (delta === 0) {
    return { text: `Same as ${entry.label}`, tone: 'neutral' };
  }

  return {
    text: `${minToDifference(delta)} ${delta < 0 ? 'faster' : 'slower'} vs ${entry.label}`,
    tone: delta < 0 ? 'faster' : 'slower',
  };
}

function selectHistoricalRunner(runner) {
  selectedRunner = {
    key: runner.key,
    name: runner.displayName,
    kind: 'historical',
  };
  compareTarget = runner.entries.length
    ? `runner:${runner.entries.length - 1}`
    : `stock:${DEFAULT_STOCK_FINISH_HOUR}`;
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
  compareTarget = `stock:${DEFAULT_STOCK_FINISH_HOUR}`;
  saveState();
  render();
}

function resetRunnerPicker() {
  selectedRunner = null;
  compareTarget = null;
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

function impossibleSightingMessage(sighting) {
  // Compare against neighboring sightings: a section faster than anything
  // in 11 years, or absurdly slow, is almost always a wrong day or time.
  for (const other of sightings) {
    if (other.stationIndex === sighting.stationIndex) continue;
    const [a, b] = other.stationIndex < sighting.stationIndex ? [other, sighting] : [sighting, other];
    const miles = AID_STATIONS[b.stationIndex].distance - AID_STATIONS[a.stationIndex].distance;
    const minutes = b.minutesFromStart - a.minutesFromStart;
    const hrs = Math.round(minutes / 6) / 10;
    const desc = `${AID_STATIONS[a.stationIndex].name} → ${AID_STATIONS[b.stationIndex].name}`;
    if (minutes <= 0 || minutes / miles < 8) {
      return `That would mean ${desc} (${miles.toFixed(1)} mi) in ${minutes} min, faster than anyone in 11 years. Is the time or day right?`;
    }
    if (minutes / miles > 180) {
      return `That would mean ${hrs} hours for ${desc} (${miles.toFixed(1)} mi). Is the race day right?`;
    }
  }
  return null;
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

  const warning = impossibleSightingMessage(sighting);
  if (warning && !window.confirm(warning)) {
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

function minToRangeStr(a, b) {
  const oa = minToClockObj(a);
  const ob = minToClockObj(b);
  if (oa.day === ob.day) {
    return `${oa.display}–${ob.display} <span class="day-tag-inline">${ob.day}</span>`;
  }
  return `${oa.display} <span class="day-tag-inline">${oa.day}</span>–${ob.display} <span class="day-tag-inline">${ob.day}</span>`;
}

function bandLinesHtml(floorLabel, floorMin, bands) {
  return `
      <div class="range-line range-strong">
        <span>${floorLabel}</span>
        <strong>${minToClockStr(floorMin)}</strong>
      </div>
      <div class="range-line">
        <span>Earliest</span>
        <strong>${minToClockStr(bands.p0)}</strong>
      </div>
      <div class="range-line">
        <span>Middle 50%</span>
        <strong>${minToRangeStr(bands.p25, bands.p75)}</strong>
      </div>
      <div class="range-line range-muted">
        <span>Last 5% after</span>
        <strong>${minToClockStr(bands.p95)}</strong>
      </div>`;
}

function estimateRowHtml(station, stationIndex, pred, isNext, markAttrs) {
  const sightedName = AID_STATIONS[pred.latestStationIndex].name;
  return `<div class="checkpoint-row is-estimate${isNext ? ' is-next' : ''}"${markAttrs}>
    <div>
      <div class="checkpoint-name">${escapeHtml(station.name)}</div>
      <div class="checkpoint-meta">Mile ${station.distance}</div>
    </div>
    <div class="checkpoint-time checkpoint-range">${bandLinesHtml('No one earlier', pred.recordFloor, pred)}</div>
    <div class="range-sample">Using ${pred.n} runners who reached ${escapeHtml(sightedName)} within ${pred.window} min of your sighting.</div>
  </div>`;
}

/**
 * Anchor for the pre-race plan, derived from the Compare To selection:
 * a stock pace anchors on that finish time; a past year anchors on that
 * year's actual finish (falling back to the stock default if that year
 * has no recorded finish).
 */
function preRaceAnchor() {
  const entry = comparisonEntry();
  if (!entry) return null;
  const finish = entry.splits[AID_STATIONS.length - 1];
  if (entry.kind === 'stock') {
    return { targetMin: entry.hours * 60, entry, desc: `who finished within 1 h of ${entry.label}` };
  }
  if (finish !== null && finish !== undefined) {
    return {
      targetMin: finish,
      entry,
      desc: `who finished within 1 h of the ${entry.label} finish (${minToDifference(finish)})`,
    };
  }
  return {
    targetMin: DEFAULT_STOCK_FINISH_HOUR * 60,
    entry,
    desc: `who finished within 1 h of ${DEFAULT_STOCK_FINISH_HOUR} hr (${entry.label} has no recorded finish)`,
  };
}

function preRaceRowHtml(station, stationIndex, bands, anchor, markAttrs) {
  const refSplit = anchor.entry.splits[stationIndex];
  const refLine = refSplit !== null && refSplit !== undefined
    ? `<div class="range-line range-muted">
        <span>${escapeHtml(anchor.entry.label)} ${anchor.entry.kind === 'runner' ? 'actual' : 'typical'}</span>
        <strong>${minToClockStr(refSplit)}</strong>
      </div>`
    : '';
  return `<div class="checkpoint-row is-estimate"${markAttrs}>
    <div>
      <div class="checkpoint-name">${escapeHtml(station.name)}</div>
      <div class="checkpoint-meta">Mile ${station.distance}</div>
    </div>
    <div class="checkpoint-time checkpoint-range">${bandLinesHtml('No one earlier', bands.earliestEver, bands)}${refLine}</div>
    <div class="range-sample">Using ${bands.n} runners ${anchor.desc}.</div>
  </div>`;
}

function renderCheckpointPlan() {
  const list = document.getElementById('checkpoint-plan-list');
  const note = document.getElementById('checkpoint-plan-note');
  const compareControl = document.getElementById('compare-year-control');
  const compareSelect = document.getElementById('compare-year-select');
  const lastIdx = latestStationIndex();
  const actualByStation = new Map(sightings.map(s => [s.stationIndex, s]));
  const nextIdx = lastIdx >= 0 ? lastIdx + 1 : -1;

  const options = syncCompareTarget();
  compareSelect.innerHTML = options.map(option =>
    `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`
  ).join('');
  compareSelect.value = compareTarget;
  compareControl.classList.toggle('hidden', !options.length);

  let noteText = '';
  if (sightings.length && lastIdx >= AID_STATIONS.length - 1) {
    noteText = 'Finish sighting saved. All known race-day data is shown below.';
  }
  note.textContent = noteText;
  note.classList.toggle('hidden', !noteText);
  document.getElementById('checkpoint-action-note')
    .classList.toggle('hidden', !selectedRunner);

  const stationIndexes = sightings.length
    ? [
        ...sightings.map(s => s.stationIndex).sort((a, b) => a - b),
        ...AID_STATIONS.map((_, i) => i).filter(i => i > lastIdx),
      ]
    : AID_STATIONS.map((_, i) => i);

  const preRaceAnchorInfo = sightings.length ? null : preRaceAnchor();
  const preRaceBands = preRaceAnchorInfo ? finishCohortBands(preRaceAnchorInfo.targetMin) : null;

  list.innerHTML = stationIndexes.map(stationIndex => {
    const station = AID_STATIONS[stationIndex];
    const actual = actualByStation.get(stationIndex);
    const markAttrs = selectedRunner ? ` data-mark-station="${stationIndex}" role="button" tabindex="0"` : '';
    if (actual) {
      const comparison = actualComparison(actual);
      return `<div class="checkpoint-row is-actual"${markAttrs}>
        <div>
          <div class="checkpoint-name">${escapeHtml(station.name)}</div>
          <div class="checkpoint-meta">Mile ${station.distance}</div>
        </div>
        <div class="checkpoint-time">
          <div class="checkpoint-main">${minToClockStr(actual.minutesFromStart)}</div>
          ${comparison ? `<div class="checkpoint-compare is-${comparison.tone}">${escapeHtml(comparison.text)}</div>` : ''}
        </div>
        <button class="track-icon-btn" data-remove-station="${stationIndex}" title="Remove sighting">×</button>
      </div>`;
    }

    if (!sightings.length) {
      const bands = preRaceBands ? preRaceBands[stationIndex] : null;
      if (bands) return preRaceRowHtml(station, stationIndex, bands, preRaceAnchorInfo, markAttrs);
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

    return estimateRowHtml(station, stationIndex, pred, stationIndex === nextIdx, markAttrs);
  }).join('');

  document.getElementById('range-explainer')
    .classList.toggle('hidden', !list.querySelector('.checkpoint-range'));

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

function render() {
  renderSelectedRunner();
  renderCheckpointPlan();
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
