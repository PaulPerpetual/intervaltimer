// --------------------
// DOM Elements
// --------------------
const input = document.getElementById("workoutInput");

const startBtn = document.getElementById("start");
const pauseBtn = document.getElementById("pause");
const stopBtn = document.getElementById("exit");

const clock = document.getElementById("clock");
const activityEl = document.getElementById("activity");
const intervalEl = document.getElementById("interval");
const elapsedEl = document.getElementById("elapsed");
const remainingEl = document.getElementById("remaining");

// --------------------
// Audio (iOS unlock-safe)
// --------------------
// single shared AudioContext; created/resumed on first user gesture
let audioCtx = null;
// decoded sample buffer for sound file (prefetch for offline/PWA use)
let sampleBuffer = null;
function ensureAudioContext() {
  if (audioCtx && audioCtx.state !== "closed") return Promise.resolve(audioCtx);
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    audioCtx = null;
    return Promise.resolve(null);
  }
  // Some browsers (iOS Safari) start in "suspended" state and require a user gesture
  if (audioCtx.state === "suspended") {
    return audioCtx.resume().then(() => audioCtx).catch(() => audioCtx);
  }
  return Promise.resolve(audioCtx);
}

// try to unlock audio on any first user interaction as well
function tryUnlockAudioOnFirstInteraction() {
  const unlock = () => {
    // attempt an immediate short oscillator burst (must run directly inside user gesture)
    unlockAudioGesture().finally(() => {
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("click", unlock);
    });
  };
  window.addEventListener("touchstart", unlock, { once: true, passive: true });
  window.addEventListener("click", unlock, { once: true, passive: true });
}
tryUnlockAudioOnFirstInteraction();

/**
 * Unlock audio by creating/resuming the AudioContext and briefly starting
 * an oscillator at a very low volume inside the user gesture. This is the
 * most reliable way to make WebAudio work on iOS Safari.
 *
 * Safe to call repeatedly; if audio is already running it returns quickly.
 */
function unlockAudioGesture() {
  return ensureAudioContext().then(ctx => {
    if (!ctx) return;
    if (ctx.state === "running") return; // already unlocked

    try {
      // create a tiny audible burst to fully unlock WebAudio in the gesture
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = 600; // mid freq
      g.gain.value = 0.02; // very low volume so it's not jarring

      osc.connect(g);
      g.connect(ctx.destination);

      const now = ctx.currentTime;
      osc.start(now);
      // stop quickly (30–60ms) — long enough to unlock but short for UX
      osc.stop(now + 0.05);

      // cleanup after stop
      osc.onended = () => {
        try { osc.disconnect(); g.disconnect(); } catch (e) {}
      };
    } catch (e) {
      // Silently ignore; unlocking may still have happened via resume()
    }
    // Also attempt to load the sample during this user gesture so it's ready.
    loadSample().catch(() => {});
  }).catch(() => {});
}

// --------------------
// Auto-resize textarea
// --------------------
function autoResize(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}
input.addEventListener("input", () => autoResize(input));
window.addEventListener("load", () => autoResize(input));

// --------------------
// Parsing
// --------------------
// Accept "5min walk" OR just "5min" (no name). Return name === "" when absent.
function parseDuration(str) {
  let total = 0;
  const min = str.match(/(\d+)\s*(m|min)/i);
  const sec = str.match(/(\d+)\s*(s|sec)/i);
  if (min) total += parseInt(min) * 60;
  if (sec) total += parseInt(sec);
  return total;
}

function parseActivity(text) {
  // Capture a duration (minutes + optional seconds) optionally followed by a name.
  // Examples matched:
  // "5min walk"  -> duration="5min" name="walk"
  // "5min"       -> duration="5min" name=undefined -> set to ""
  const match = text.trim().match(
    /^(\d+\s*(?:m|min|s|sec)(?:\s*\d*\s*(?:s|sec))?)(?:\s+(.*))?$/i
  );
  if (!match) return null;

  return {
    name: match[2] ? match[2].trim() : "", // empty string when unnamed
    duration: parseDuration(match[1])
  };
}

function parseWorkout(text) {
  return text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const set = line.match(/^(\d+)x\s*\((.+)\)$/i);
      if (!set) return { type: "activity", ...parseActivity(line) };

      return {
        type: "set",
        repeat: parseInt(set[1]),
        steps: set[2].split(",").map(s => parseActivity(s)).filter(Boolean)
      };
    })
    .filter(Boolean);
}

// --------------------
// Flatten workout with interval metadata
// --------------------
function flattenWorkout(parsed) {
  const timeline = [];

  parsed.forEach(block => {
    if (block.type === "activity") {
      timeline.push({ ...block });
    }

    if (block.type === "set") {
      for (let r = 1; r <= block.repeat; r++) {
        block.steps.forEach(step => {
          timeline.push({
            ...step,
            interval: r,
            intervalTotal: block.repeat
          });
        });
      }
    }
  });

  return timeline;
}

// --------------------
// Timer state
// --------------------
let timeline = [];
let index = 0;
let remaining = 0;
let elapsed = 0;
let intervalId = null;
let sampleTimeoutId = null; // <--- added

let isRunning = false;
let isPaused = false;

// --------------------
// Controls
// --------------------
startBtn.onclick = () => (isPaused ? resume() : start());
pauseBtn.onclick = () => isRunning && pause();
stopBtn.onclick = stop;

function updateControls() {
  startBtn.classList.toggle("active", isRunning);
  pauseBtn.classList.toggle("active", isPaused);
}

// --------------------
// Timer logic
// --------------------
function start() {
  timeline = flattenWorkout(parseWorkout(input.value));
  if (!timeline.length) return;

  index = 0;
  elapsed = 0;
  isRunning = true;
  isPaused = false;

  startActivity();
  updateControls();
}

function startActivity(subtractOne = false) {
  clearInterval(intervalId);
  if (sampleTimeoutId) { clearTimeout(sampleTimeoutId); sampleTimeoutId = null; }

  // start next activity with full duration normally,
  // but if subtractOne is true (transitioning immediately after previous finished)
  // start at duration - 1 so we don't replay the zeroth second.
  remaining = Math.max(0, timeline[index].duration - (subtractOne ? 1 : 0));
  updateUI();
  intervalId = setInterval(tick, 1000);

  // schedule sample to play exactly 3 seconds before the interval end
  if (index < timeline.length - 1) {
    if (remaining > 3) {
      sampleTimeoutId = setTimeout(() => {
        playSample();
        sampleTimeoutId = null;
      }, (remaining - 3) * 1000);
    } else if (remaining === 3) {
      // play immediately if already at the 3s mark
      playSample();
    }
  }
}

function tick() {
  if (remaining <= 0) return next();

  remaining--;
  elapsed++;

  updateUI();
  pulseClock();
}

function next() {
  index++;
  if (index >= timeline.length) return finish();

  // when advancing from a finished interval, start the next one already
  // subtracting one second so the UI doesn't show the full duration again.
  startActivity(true);
}

function pause() {
  clearInterval(intervalId);
  if (sampleTimeoutId) { clearTimeout(sampleTimeoutId); sampleTimeoutId = null; }
  isPaused = true;
  isRunning = false;
  updateControls();
}

function resume() {
  isPaused = false;
  isRunning = true;
  intervalId = setInterval(tick, 1000);

  // reschedule the sample for the remaining time
  if (index < timeline.length - 1) {
    if (sampleTimeoutId) { clearTimeout(sampleTimeoutId); sampleTimeoutId = null; }
    if (remaining > 3) {
      sampleTimeoutId = setTimeout(() => {
        playSample();
        sampleTimeoutId = null;
      }, (remaining - 3) * 1000);
    } else if (remaining === 3) {
      playSample();
    }
  }

  updateControls();
}

function stop() {
  clearInterval(intervalId);
  if (sampleTimeoutId) { clearTimeout(sampleTimeoutId); sampleTimeoutId = null; }
  isRunning = false;
  isPaused = false;

  clock.textContent = "00:00";
  activityEl.textContent = "ready";
  intervalEl.textContent = "";
  elapsedEl.textContent = "0:00";
  remainingEl.textContent = "0:00";

  updateControls();
}

function finish() {
  clearInterval(intervalId);
  if (sampleTimeoutId) { clearTimeout(sampleTimeoutId); sampleTimeoutId = null; }
  clock.textContent = "🎉";
  activityEl.textContent = "done";
  isRunning = false;
  updateControls();
}

// --------------------
// UI updates
// --------------------
function format(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function updateUI() {
  const cur = timeline[index];

  clock.textContent = format(remaining);
  activityEl.textContent = cur.name;

  intervalEl.textContent =
    cur.interval ? `${cur.interval} / ${cur.intervalTotal}` : "";

  elapsedEl.textContent = format(elapsed);

  const totalRemaining =
    timeline.slice(index).reduce((s, a) => s + a.duration, 0) -
    (cur.duration - remaining);

  remainingEl.textContent = format(totalRemaining);
}

// --------------------
// Finish + animation
// --------------------
function finish() {
  clearInterval(intervalId);
  if (sampleTimeoutId) { clearTimeout(sampleTimeoutId); sampleTimeoutId = null; }
  clock.textContent = "🎉";
  activityEl.textContent = "done";
  isRunning = false;
  updateControls();
}

function pulseClock() {
  clock.style.transform = "scale(1.05)";
  setTimeout(() => (clock.style.transform = "scale(1)"), 120);
}

// --------------------
// Web Audio: triangular beep (uses shared audioCtx, resumes if suspended)
// --------------------
function beep(freq = 440, duration = 230) {
  // ensure audio context is available / resumed first
  ensureAudioContext().then(ctx => {
    if (!ctx) return;
    // create nodes
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.value = freq;

    // quick, smooth envelope to avoid clicks
    const now = ctx.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.09, now + 0.002);
    gainNode.gain.linearRampToValueAtTime(0.0001, now + duration / 1000);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(now);
    oscillator.stop(now + duration / 1000 + 0.01);

    // cleanup when finished
    oscillator.onended = () => {
      try { oscillator.disconnect(); gainNode.disconnect(); } catch (e) {}
    };
  }).catch(() => {});
}

// --------------------
// Sample loading & playback (sound.wav)
// --------------------
async function loadSample() {
  try {
    const ctx = await ensureAudioContext();
    if (!ctx) return null;
    if (sampleBuffer) return sampleBuffer;

    const candidates = ["sound.wav", "sound.wav.asd", "sound.wv.asd"];
    for (const url of candidates) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const ab = await resp.arrayBuffer();
        // decodeAudioData may throw on some browsers; await works with the promise-based API
        const decoded = await ctx.decodeAudioData(ab.slice(0));
        sampleBuffer = decoded;
        return sampleBuffer;
      } catch (e) {
        // try next candidate
        continue;
      }
    }
  } catch (e) {
    return null;
  }
  return null;
}

function playSample() {
  ensureAudioContext().then(ctx => {
    if (!ctx) return;
    if (!sampleBuffer) {
      // try to load and then play once ready
      loadSample().then(buf => {
        if (!buf) return;
        try {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.start();
          src.onended = () => { try { src.disconnect(); } catch (e) {} };
        } catch (e) {}
      }).catch(() => {});
      return;
    }

    try {
      const src = ctx.createBufferSource();
      src.buffer = sampleBuffer;
      src.connect(ctx.destination);
      src.start();
      src.onended = () => { try { src.disconnect(); } catch (e) {} };
    } catch (e) {}
  }).catch(() => {});
}

// --------------------
// Start: make sure user gesture created/resumed audio (improves iOS reliability)
// --------------------
startBtn.onclick = (e) => {
  // Ensure audio context is unlocked/resumed on start click (user gesture).
  // Run unlockAudioGesture inside the same gesture so iOS treats it as user-initiated.
  ensureAudioContext()
    .then(() => unlockAudioGesture())
    .then(() => loadSample().catch(() => {}))
    .finally(() => {
      if (isPaused) resume(); else start();
    });
};
pauseBtn.onclick = () => isRunning && pause();
stopBtn.onclick = stop;
