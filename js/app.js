// ─────────────────────────────────────────────
//  State (populated from model.json on load)
// ─────────────────────────────────────────────

let RACE_START_HOUR = 8;
let AID_STATIONS    = [];

let model    = null;
let predChart = null;
let obsCount  = 0;

// ─────────────────────────────────────────────
//  Model Loading
// ─────────────────────────────────────────────

async function loadModel() {
  const res = await fetch('model.json');
  if (!res.ok) throw new Error(`HTTP ${res.status} loading model.json`);
  model           = await res.json();
  RACE_START_HOUR = model.raceStartHour;
  AID_STATIONS    = model.stations;
}

// ─────────────────────────────────────────────
//  Kernel Regression
// ─────────────────────────────────────────────

// Gaussian kernel bandwidth (minutes).  A runner whose split differs from the
// observed time by this amount receives ~60% weight; at 2× it receives ~14%.
const BANDWIDTH = 30;

function gaussianWeight(diff) {
  return Math.exp(-0.5 * (diff / BANDWIDTH) ** 2);
}

/**
 * Core prediction function.
 *
 * Given observations = [{ stationIndex, minutesFromStart }, ...], find every
 * historical runner's similarity to this specific race trajectory by
 * multiplying a Gaussian kernel term for each observed station:
 *
 *   weight(runner) = ∏  K( runner.splits[k] − observed_time[k] )
 *
 * This means a runner only earns high weight if they were near the observed
 * time at *every* checkpoint — the "cohort who shares this race history."
 *
 * From that weighted sample of historical runners, compute the conditional
 * distribution at targetStationIdx.
 *
 * Returns { p10, p25, p50, p75, p90, effectiveN } or null.
 */
function predict(observations, targetStationIdx) {
  const relevantObs = observations.filter(o => o.stationIndex < targetStationIdx);
  if (relevantObs.length === 0) return null;

  const samples = [];   // { t, w } for runners who have a target-station time

  for (const runner of model.runners) {
    // Compute joint weight across all observations
    let w = 1;
    for (const obs of relevantObs) {
      const t = runner[obs.stationIndex];
      if (t === null) { w = 0; break; }          // runner has no data here → exclude
      w *= gaussianWeight(t - obs.minutesFromStart);
    }
    if (w < 1e-9) continue;

    const tTarget = runner[targetStationIdx];
    if (tTarget === null) continue;               // runner didn't reach target

    samples.push({ t: tTarget, w });
  }

  if (samples.length < 5) return null;

  samples.sort((a, b) => a.t - b.t);

  const totalW  = samples.reduce((s, x) => s + x.w, 0);
  const effN    = totalW ** 2 / samples.reduce((s, x) => s + x.w ** 2, 0);

  return {
    p10: weightedPct(samples, totalW, 0.10),
    p25: weightedPct(samples, totalW, 0.25),
    p50: weightedPct(samples, totalW, 0.50),
    p75: weightedPct(samples, totalW, 0.75),
    p90: weightedPct(samples, totalW, 0.90),
    effectiveN: Math.round(effN),
  };
}

function weightedPct(sortedSamples, totalW, p) {
  let cum = 0;
  for (const { t, w } of sortedSamples) {
    cum += w;
    if (cum / totalW >= p) return t;
  }
  return sortedSamples[sortedSamples.length - 1].t;
}

// ─────────────────────────────────────────────
//  Density Curve  (split-normal, for the chart)
// ─────────────────────────────────────────────

/**
 * Build a smooth density curve from the predicted percentiles.
 *
 * Uses a split-normal distribution: two half-Gaussians joined at the median,
 * with σ_low  = (p50 − p10) / 1.282
 *     σ_high = (p90 − p50) / 1.282
 * This captures the right-skew typical of race arrival times.
 */
function buildDensityCurve(p10, p50, p90, nPts = 300) {
  const sigL = Math.max((p50 - p10) / 1.282, 0.5);
  const sigH = Math.max((p90 - p50) / 1.282, 0.5);
  const norm = Math.sqrt(2 * Math.PI) * (sigL + sigH) / 2;
  const xMin = p50 - 3.5 * sigL;
  const xMax = p50 + 3.5 * sigH;
  return Array.from({ length: nPts + 1 }, (_, i) => {
    const x = xMin + (xMax - xMin) * i / nPts;
    const s = x <= p50 ? sigL : sigH;
    return { x, y: Math.exp(-0.5 * ((x - p50) / s) ** 2) / norm };
  });
}

// ─────────────────────────────────────────────
//  Time Utilities
// ─────────────────────────────────────────────

function minToClockObj(minutesFromStart) {
  const total     = RACE_START_HOUR * 60 + Math.round(minutesFromStart);
  const dayOffset = Math.floor(total / (24 * 60));
  const h         = Math.floor(total / 60) % 24;
  const m         = Math.floor(total % 60);
  const ampm      = h >= 12 ? 'PM' : 'AM';
  const h12       = h % 12 === 0 ? 12 : h % 12;
  const day       = dayOffset === 0 ? 'Fri' : dayOffset === 1 ? 'Sat' : `Day ${dayOffset + 1}`;
  return { display: `${h12}:${String(m).padStart(2,'0')} ${ampm}`, day, dayOffset };
}

function minToClockStr(m) {
  const o = minToClockObj(m);
  return `${o.display} ${o.day}`;
}

function clockDropdownToMinutes(h12, minVal, ampm, dayOffset) {
  let h = parseInt(h12, 10);
  const m = parseInt(minVal, 10);
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return dayOffset * 24 * 60 + h * 60 + m - RACE_START_HOUR * 60;
}

function defaultDayForStation(idx) {
  const s = model.stationStats[idx];
  return s && s.p50 >= 16 * 60 ? 1 : 0;
}

// ─────────────────────────────────────────────
//  UI — Observation Rows
// ─────────────────────────────────────────────

function stationOptions(selected = -1) {
  return AID_STATIONS.map((s, i) =>
    `<option value="${i}"${i === selected ? ' selected' : ''}>${s.name} (mi ${s.distance})</option>`
  ).join('');
}

function dayOptions(selected = 0) {
  return `<option value="0"${selected === 0 ? ' selected' : ''}>Fri (Day 1)</option>
          <option value="1"${selected === 1 ? ' selected' : ''}>Sat (Day 2)</option>`;
}

function hourOptions(selected = '12') {
  return Array.from({length: 12}, (_, i) => i + 1).map(h =>
    `<option value="${h}"${String(h) === String(selected) ? ' selected' : ''}>${h}</option>`
  ).join('');
}

function minuteOptions(selected = '00') {
  return Array.from({length: 12}, (_, i) => i * 5).map(m => {
    const v = String(m).padStart(2, '0');
    return `<option value="${v}"${v === String(selected) ? ' selected' : ''}>${v}</option>`;
  }).join('');
}

function ampmOptions(selected = 'AM') {
  return ['AM','PM'].map(v =>
    `<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`
  ).join('');
}

function addObservationRow(stationIdx = -1, timeVal = '', dayVal = null) {
  const id  = obsCount++;
  const day = dayVal !== null ? dayVal : (stationIdx >= 0 ? defaultDayForStation(stationIdx) : 0);

  const container = document.getElementById('observations-container');
  const row = document.createElement('div');
  row.className  = 'obs-row';
  row.dataset.id = id;
  row.innerHTML = `
    <div class="obs-row-header">
      <span class="obs-row-label">Sighting ${container.children.length + 1}</span>
      <button class="remove-obs-btn" title="Remove" onclick="removeObs(${id})">✕</button>
    </div>
    <div class="obs-inputs">
      <div class="input-group">
        <label class="input-label" for="stn-${id}">Checkpoint</label>
        <select id="stn-${id}" onchange="onStationChange(${id})">
          <option value="">Select…</option>
          ${stationOptions(stationIdx)}
        </select>
      </div>
      <div class="input-group">
        <label class="input-label">Arrival Time</label>
        <div class="time-dropdowns">
          <select id="hr-${id}">${hourOptions()}</select>
          <select id="mn-${id}">${minuteOptions()}</select>
          <select id="ap-${id}">${ampmOptions()}</select>
        </div>
      </div>
      <div class="input-group day-group">
        <label class="input-label" for="day-${id}">Race Day</label>
        <select id="day-${id}" class="day-select">${dayOptions(day)}</select>
      </div>
    </div>`;
  container.appendChild(row);
  updateRemoveButtons();
}

function removeObs(id) {
  document.querySelector(`.obs-row[data-id="${id}"]`)?.remove();
  relabelRows();
  updateRemoveButtons();
}

function relabelRows() {
  document.querySelectorAll('.obs-row').forEach((row, i) => {
    const lbl = row.querySelector('.obs-row-label');
    if (lbl) lbl.textContent = `Sighting ${i + 1}`;
  });
}

function updateRemoveButtons() {
  const rows = document.querySelectorAll('.obs-row');
  rows.forEach(row => {
    const btn = row.querySelector('.remove-obs-btn');
    if (btn) btn.style.display = rows.length > 1 ? 'flex' : 'none';
  });
}

function onStationChange(id) {
  const idx = parseInt(document.getElementById(`stn-${id}`).value, 10);
  if (!isNaN(idx)) document.getElementById(`day-${id}`).value = defaultDayForStation(idx);
}

function readObservations() {
  const obs = [];
  for (const row of document.querySelectorAll('.obs-row')) {
    const id  = row.dataset.id;
    const idx = parseInt(document.getElementById(`stn-${id}`).value, 10);
    if (isNaN(idx)) continue;
    const hr   = document.getElementById(`hr-${id}`).value;
    const mn   = document.getElementById(`mn-${id}`).value;
    const ap   = document.getElementById(`ap-${id}`).value;
    const day  = parseInt(document.getElementById(`day-${id}`).value, 10);
    obs.push({ stationIndex: idx, minutesFromStart: clockDropdownToMinutes(hr, mn, ap, day) });
  }
  return obs;
}

// ─────────────────────────────────────────────
//  Cohort Description
// ─────────────────────────────────────────────

/**
 * Build the plain-language sentence that explains which cohort
 * the prediction is drawn from.
 *
 * Single obs:   "Looking at 47 runners from past races who arrived at
 *                Finland around 10:00 PM Fri"
 * Multiple obs: "Looking at 23 runners from past races who arrived at
 *                Silver Bay around 12:00 PM Fri and Finland around 10:00 PM Fri"
 */
function buildCohortDesc(observations, effectiveN) {
  const parts = observations.map(o => {
    const name = AID_STATIONS[o.stationIndex].name;
    const time = minToClockStr(o.minutesFromStart);
    return `${name} around ${time}`;
  });

  const joined = parts.length === 1
    ? parts[0]
    : parts.slice(0, -1).join(', ') + ' and ' + parts.at(-1);

  return `Looking at ${effectiveN} runners from past races who arrived at ${joined}`;
}

// ─────────────────────────────────────────────
//  UI — Results
// ─────────────────────────────────────────────

function showResults(observations) {
  const lastIdx  = Math.max(...observations.map(o => o.stationIndex));
  const upcoming = AID_STATIONS
    .map((s, i) => ({ ...s, index: i }))
    .filter(s => s.index > lastIdx);

  if (!upcoming.length) {
    showError("Runner has already reached the finish — nothing left to predict.");
    return;
  }

  const next = upcoming[0];
  const res  = predict(observations, next.index);
  if (!res) {
    showError("Too few historical runners match this input. Try adjusting the times.");
    return;
  }

  // ── Next-station card ──
  const p10o = minToClockObj(res.p10);
  const p50o = minToClockObj(res.p50);
  const p90o = minToClockObj(res.p90);

  document.getElementById('next-station-card').innerHTML = `
    <div class="next-card-eyebrow">Next Checkpoint</div>
    <h2>Expected arrival at <span class="station-name">${next.name}</span></h2>
    <div class="time-grid">
      <div class="time-cell">
        <div class="time-cell-label">Early (10%)</div>
        <div class="time-cell-value">${p10o.display}<span class="day-tag">${p10o.day}</span></div>
      </div>
      <div class="time-cell highlight">
        <div class="time-cell-label">Median</div>
        <div class="time-cell-value">${p50o.display}<span class="day-tag">${p50o.day}</span></div>
      </div>
      <div class="time-cell">
        <div class="time-cell-label">Late (90%)</div>
        <div class="time-cell-value">${p90o.display}<span class="day-tag">${p90o.day}</span></div>
      </div>
    </div>`;

  // ── Build cohort description (used in chart + table) ──
  const cohortDesc = buildCohortDesc(observations, res.effectiveN);

  // ── Chart ──
  document.getElementById('chart-title').textContent =
    `Predicted Arrival · ${next.name} (mile ${next.distance})`;
  document.getElementById('chart-subtitle').textContent = cohortDesc;
  renderChart(res);

  // ── All-stations table ──
  const tbody = document.getElementById('pred-tbody');
  tbody.innerHTML = '';
  for (const station of upcoming) {
    const r  = predict(observations, station.index);
    const tr = document.createElement('tr');
    if (station.index === next.index) tr.className = 'next-row';
    if (r) {
      const m50 = minToClockObj(r.p50);
      const m10 = minToClockObj(r.p10);
      const m90 = minToClockObj(r.p90);
      tr.innerHTML = `
        <td class="td-station">${station.name}</td>
        <td class="td-range">${station.distance}</td>
        <td class="td-median">${m50.display} <span class="day-tag-inline">${m50.day}</span></td>
        <td class="td-range">${m10.display}<span class="day-tag-inline">${m10.day}</span></td>
        <td class="td-range">${m90.display}<span class="day-tag-inline">${m90.day}</span></td>`;
    } else {
      tr.innerHTML = `<td class="td-station">${station.name}</td>
        <td></td>
        <td colspan="3" class="td-range">Not enough data</td>`;
    }
    tbody.appendChild(tr);
  }

  // ── Table note: same cohort, carries through to all rows ──
  document.getElementById('sample-note').textContent =
    `All times below are based on the same ${res.effectiveN} runners.`;

  document.getElementById('results-section').classList.remove('hidden');
  document.getElementById('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─────────────────────────────────────────────
//  Chart
// ─────────────────────────────────────────────

function renderChart(result) {
  const { p10, p25, p50, p75, p90 } = result;

  const curve = buildDensityCurve(p10, p50, p90);
  const yMax  = Math.max(...curve.map(pt => pt.y));

  const band80 = curve.filter(pt => pt.x >= p10 && pt.x <= p90);
  const band50 = curve.filter(pt => pt.x >= p25 && pt.x <= p75);
  const medLine = [{ x: p50, y: 0 }, { x: p50, y: yMax * 1.08 }];

  if (predChart) { predChart.destroy(); predChart = null; }

  predChart = new Chart(
    document.getElementById('prediction-chart').getContext('2d'),
    {
      type: 'line',
      data: {
        datasets: [
          {
            data: band80, fill: true,
            backgroundColor: 'rgba(74,222,128,0.12)', borderColor: 'transparent',
            borderWidth: 0, pointRadius: 0, tension: 0.4, order: 3,
          },
          {
            data: band50, fill: true,
            backgroundColor: 'rgba(74,222,128,0.30)', borderColor: 'transparent',
            borderWidth: 0, pointRadius: 0, tension: 0.4, order: 2,
          },
          {
            data: curve, fill: false,
            borderColor: 'rgba(74,222,128,0.75)', borderWidth: 2,
            pointRadius: 0, tension: 0.4, order: 1,
          },
          {
            data: medLine, fill: false,
            borderColor: '#22c55e', borderWidth: 2.5,
            pointRadius: 0, order: 0,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 400 }, parsing: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index', intersect: false,
            filter: item => item.datasetIndex === 3,
            callbacks: {
              title: () => `Median: ${minToClockStr(p50)}`,
              label: () => null,
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: curve[0].x, max: curve[curve.length - 1].x,
            ticks: {
              color: '#86efac', maxTicksLimit: 8,
              callback: val => { const o = minToClockObj(val); return [o.display, o.day]; },
              font: { size: 11 },
            },
            grid:   { color: 'rgba(42,66,44,0.6)' },
            border: { color: 'rgba(42,66,44,0.8)' },
          },
          y: { display: false, min: 0 },
        },
      },
    }
  );
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function showError(msg) {
  const el = document.getElementById('input-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 7000);
}

// ─────────────────────────────────────────────
//  Init
// ─────────────────────────────────────────────

async function init() {
  try {
    await loadModel();
  } catch (err) {
    document.getElementById('loading-screen').innerHTML =
      '<p style="color:#f87171;padding:2rem">Failed to load model.json. ' +
      'Run <code>python3 build_model.py</code> then serve over HTTP ' +
      '(<code>python3 -m http.server</code>).</p>';
    return;
  }

  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('input-section').classList.remove('hidden');
  document.getElementById('footer-note').textContent =
    `Model: ${model.runners.length} runners · 2023–2025 Superior 100`;

  addObservationRow();

  document.getElementById('add-obs-btn').addEventListener('click', () => addObservationRow());

  document.getElementById('predict-btn').addEventListener('click', () => {
    document.getElementById('input-error').classList.add('hidden');
    const obs = readObservations();
    if (obs.length === 0) {
      showError('Select at least one checkpoint and enter an arrival time.');
      return;
    }
    for (const o of obs) {
      if (o.minutesFromStart < 0) {
        showError('One time appears to be before the 8:00 AM race start. Check the race day selection.');
        return;
      }
      const s = model.stationStats[o.stationIndex];
      if (s && (o.minutesFromStart < s.min - 120 || o.minutesFromStart > s.max + 120)) {
        showError(`Time for "${AID_STATIONS[o.stationIndex].name}" is outside the historical range — double-check the race day.`);
        return;
      }
    }
    showResults(obs);
  });

  document.getElementById('reset-btn').addEventListener('click', () => {
    document.getElementById('results-section').classList.add('hidden');
    document.getElementById('input-section').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

document.addEventListener('DOMContentLoaded', init);
