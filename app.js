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
function parseDuration(str) {
  let total = 0;
  const min = str.match(/(\d+)\s*(m|min)/i);
  const sec = str.match(/(\d+)\s*(s|sec)/i);
  if (min) total += parseInt(min) * 60;
  if (sec) total += parseInt(sec);
  return total;
}

function parseActivity(text) {
  const match = text.trim().match(
    /^(\d+\s*(?:m|min|s|sec)(?:\s*\d*\s*(?:s|sec))?)\s+(.*)$/i
  );
  if (!match) return null;

  return {
    name: match[2].trim(),
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

  // start next activity with full duration normally,
  // but if subtractOne is true (transitioning immediately after previous finished)
  // start at duration - 1 so we don't replay the zeroth second.
  remaining = Math.max(0, timeline[index].duration - (subtractOne ? 1 : 0));
  updateUI();
  intervalId = setInterval(tick, 1000);
}

function tick() {
  if (remaining <= 0) return next();

  remaining--;
  elapsed++;

  // LAST 3 SECONDS BEEP
  if (remaining <= 3 && remaining > 0) {
    beep(1000, 150); // triangular 1000 Hz beep
  }

  // FINAL beep (higher) when interval ends (not last)
  if (remaining === 0 && index < timeline.length - 1) {
    beep(1500, 250); // higher beep
  }

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
  isPaused = true;
  isRunning = false;
  updateControls();
}

function resume() {
  isPaused = false;
  isRunning = true;
  intervalId = setInterval(tick, 1000);
  updateControls();
}

function stop() {
  clearInterval(intervalId);
  isRunning = false;
  isPaused = false;

  clock.textContent = "00:00";
  activityEl.textContent = "ready";
  intervalEl.textContent = "";
  elapsedEl.textContent = "0:00";
  remainingEl.textContent = "0:00";

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
// Web Audio: triangular beep
// --------------------
function beep(freq = 1000, duration = 200) {
  const context = new (window.AudioContext || window.webkitAudioContext)();
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(context.destination);

  oscillator.type = "triangle";
  oscillator.frequency.value = freq;

  oscillator.start();
  gainNode.gain.setValueAtTime(0.1, context.currentTime);
  oscillator.stop(context.currentTime + duration / 1000);
}
