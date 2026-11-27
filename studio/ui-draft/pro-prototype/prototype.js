import {sceneHasWeather,sceneHasExteriorLayers} from '../artboards.js?v=scene-options-20261112';
import {DRIVING_EVENT_SECONDS} from '../interaction-duration.js';
import {setAssistDemo} from '../assist-demo.js';
import {isParkingEvent} from '../parking-event-types.js';
import {glideIndicator, morphSegment, reducedMotion, toggleMotionFrames} from '../motion-runtime.js';
import {createScenePreview} from './scene-preview.js?v=20261120-context-recovery';
import {cutInPhases,isAdjacentCutInScene} from '../cut-in-timing.js?v=yielding-cut-in';
import {LANE_CHANGE_TIMING} from '../lane-change-timing.js';
import {JUNCTION_LEFT_TURN, JUNCTION_LEFT_TIMING} from '../junction-left-turn.js';
import {SCENE_THEME_DURATION} from '../theme-blend.js';
import assistWheelOff from '../assist-wheel-off.svg';
import assistWheelOn from '../assist-wheel-on.svg';

(() => {
const $ = (id) => document.getElementById(id);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const LAYER_CHECK = '<svg class="layer-check" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 6 2.2 2.2 4.8-4.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON = {
  play: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.6v8.8a.6.6 0 0 0 .92.5l6.86-4.4a.6.6 0 0 0 0-1L5.92 3.1A.6.6 0 0 0 5 3.6Z" fill="currentColor"/></svg>',
  pause: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.25 3.5v9M10.75 3.5v9" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>',
  replay: '<svg width="16" height="16" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M169.6 512a278.4 278.4 0 0 1 475.264-196.864c13.888 13.888 36.672 38.656 56.512 60.48l25.152 27.904 2.56 2.88H640a41.6 41.6 0 0 0 0 83.2h192a41.6 41.6 0 0 0 41.6-41.6V256a41.6 41.6 0 1 0-83.2 0v94.144l-1.92-2.112-25.472-28.288a2126.848 2126.848 0 0 0-59.328-63.424 361.6 361.6 0 1 0 0 511.36 41.6 41.6 0 1 0-58.88-58.88A278.4 278.4 0 0 1 169.6 512z"/></svg>'
};
const TOTAL = DRIVING_EVENT_SECONDS;
const {signalAt} = LANE_CHANGE_TIMING;
const laneChangePhases = ({steerAt, settledAt, conflictAt = Infinity, clearAt = 0, side = 'right', liveTraffic, waiting}) => {
  const check = ['Check gap', Number.isFinite(conflictAt) ? Math.max(signalAt, conflictAt) : signalAt, `The vehicle checks traffic in the ${side} lane.`];
  if (waiting) return [check, ['Wait for a gap', TOTAL - signalAt, 'The vehicle stays in its lane while traffic passes.']];
  const conflict = Number.isFinite(conflictAt);
  return [
    check,
    ['Gap detected', Number.isFinite(conflictAt) ? 0 : steerAt - signalAt, `The ${side} lane has room. The vehicle plans its move.`],
    ...(conflict ? [
      ['Wait for a gap', clearAt - conflictAt, liveTraffic ? 'The vehicle holds its lane while traffic passes.' : 'The vehicle eases off and lets the other car move ahead.'],
      ['Gap clear', steerAt - clearAt, 'The vehicle rechecks the space before moving.'],
    ] : []),
    ['Change lanes', settledAt - steerAt, `The vehicle steers into the ${side} lane.`],
    ['Lane change complete', TOTAL - settledAt, `The vehicle settles in the ${side} lane.`],
  ].filter(([, duration]) => duration > 0);
};
const {yieldAt, stopAt, turnAt, duration: junctionDuration} = JUNCTION_LEFT_TIMING;
const EVENTS = {
  'parking-yield': {label: 'Oncoming car', phases: [['Approach', 10, 'The vehicle makes room for an oncoming car before parking.']]},
  'parking-taken': {label: 'Space taken', phases: [['Approach', 10, 'The vehicle finds another space when the selected bay is taken.']]},
  [JUNCTION_LEFT_TURN]: {label: 'Left turn'},
  roadworks: {label: 'Roadworks', phases: [
    ['Cruise', 1.3, 'Cones close the middle lane ahead.'],
    ['Brake', 1.5, 'The vehicle slows for the closed lane.'],
    ['Merge', 3.6, 'The vehicle moves into the open lane when there is room.'],
    ['Pass', 2.2, 'The vehicle passes the work zone.'],
    ['Resume', TOTAL - 8.6, 'The work zone is behind. The vehicle returns to cruising speed.']
  ]},
  cutin: {label: 'Cut-in'},
  lanechange: {label: 'Lane change', phases: laneChangePhases(LANE_CHANGE_TIMING)},
};
const isRampMerge = () => S.scene === 'ramp' && S.rampLayout === '07';
// Driving events include a cruise tail; parking duration follows the maneuver.
const total = () => S.roadRun ? Math.round(100*(S.roadRun.duration-S.roadRun.eventStart))/100 : isParkingEvent(S.event) ? S.parkingRun?.duration ?? TOTAL : S.event === JUNCTION_LEFT_TURN ? S.junctionTiming?.duration ?? junctionDuration : TOTAL;
const eventLabel = event => event === 'cutin' && isRampMerge() ? 'Merge' : EVENTS[event].label;
const checkGap = 'The vehicle checks the next ramp lane and the mainline.';
const initialMergePhases = [['Approach', TOTAL, checkGap]];
const mergePhases = ({strategy, decisionAt, releaseAt, mergeAt, settledAt, endAt = TOTAL, yieldTo, rearAlsoPassed, passAt, followsLead}) => {
  if (strategy === 'wait') return [
    ['Approach', decisionAt, checkGap],
    ['Wait for a gap', endAt - decisionAt, 'The vehicle holds on the ramp while traffic passes.'],
  ];
  const yielding = strategy === 'yield';
  const yieldHint = rearAlsoPassed
    ? 'The vehicle leaves room for both ramp and mainline traffic to pass.'
    : yieldTo === 'ramp'
      ? 'The vehicle slows to let the car in the next ramp lane merge first.'
      : 'The vehicle slows on the ramp to let mainline traffic pass.';
  return [
    ['Approach', decisionAt, checkGap],
    ['Yield', releaseAt - decisionAt, yieldHint],
    ['Accelerate', mergeAt - releaseAt, yielding
      ? 'The way is clear. The vehicle builds speed to join behind the passing car.'
      : 'There is room ahead. The vehicle builds speed to merge.'],
    ['Merge', settledAt - mergeAt, 'The vehicle joins the mainline.'],
    [followsLead ? 'Follow' : 'Cruise', (passAt ?? endAt) - settledAt, followsLead
      ? 'The vehicle leaves room behind the car ahead.' : 'The vehicle builds up to cruising speed.'],
    ['Pass', endAt - (passAt ?? endAt), 'The left lane is clear. The vehicle moves over and accelerates past the slower car.'],
  ].filter(([, duration]) => duration > 0);
};
const junctionPhases = ({turnAt, clearAt, duration} = JUNCTION_LEFT_TIMING) => [
  ['Approach', yieldAt, 'The vehicle slows for the junction.'],
  ['Stop', stopAt - yieldAt, 'The vehicle stops at the line and checks traffic.'],
  ['Signal left', JUNCTION_LEFT_TIMING.turnAt - stopAt, 'The vehicle signals before turning.'],
  ['Wait for a gap', Math.min(turnAt, duration) - JUNCTION_LEFT_TIMING.turnAt, 'The vehicle waits for room to complete the turn.'],
  ...(Number.isFinite(turnAt) ? [
    ['Turn left', clearAt - turnAt, 'The turning path is clear. The vehicle turns left.'],
    ['Resume', duration - clearAt, 'The vehicle continues straight and returns to cruising speed.'],
  ] : []),
].filter(([, duration]) => duration > 0);
const eventPhases = () => {
  if (S.event === 'roadworks' && S.roadRun?.workZoneTiming) {
    const {brakeAt, mergeAt, passAt, clearAt, waitAt, endAt} = S.roadRun.workZoneTiming;
    const starts = [
      ['Cruise', 0, 'Cones close the middle lane ahead.'],
      ['Brake', Math.max(0,brakeAt), 'The vehicle slows for the closed lane.'],
      ['Wait for a gap', waitAt, 'The vehicle stays clear of the work zone while traffic passes.'],
      ['Merge', mergeAt, 'The vehicle moves into the open lane.'],
      ['Pass', passAt, 'The vehicle passes the work zone.'],
      ['Resume', clearAt, 'The work zone is behind. The vehicle returns to cruising speed.'],
    ].filter(([,at]) => at < endAt).sort((a,b) => a[1]-b[1]);
    return starts.map(([label,at,guide],i) => [label,(starts[i+1]?.[1] ?? endAt)-at,guide]).filter(([,length]) => length>0);
  }
  if (S.event === JUNCTION_LEFT_TURN) return junctionPhases(S.junctionTiming);
  if (isParkingEvent(S.event)) return S.parkingRun?.phases ?? EVENTS[S.event].phases;
  if (S.event === 'lanechange') return S.laneChangePhases ?? EVENTS.lanechange.phases;
  if (!isAdjacentCutIn()) return EVENTS[S.event].phases;
  if (isRampMerge()) return S.mergePhases ?? initialMergePhases;
  return cutInPhases(S.cutInTiming);
};
const phases = () => {
  const handoff = S.roadRun?.handoff ?? 0;
  const steps = eventPhases();
  return handoff > 0 ? [['Complete maneuver', handoff, 'The vehicle finishes the current maneuver before the new one begins.'], ...steps] : steps;
};
const ROADWORKS_SCENE = 'elevated';
const FORMATS = [['png', 'PNG'], ['kit', 'Kit (ZIP)'], ['camera', 'Camera (JSON)'], ['depth', 'Depth (PNG)'], ['video', 'Video (MP4)']];
const CAMERAS = [['low', 'Low'], ['high', 'High']];
const PARKING_CAMERAS = [...CAMERAS, ['parked', 'Parked']];
const EVENT_CAMERAS = [['auto', 'Auto'], ['low', 'Low'], ['high', 'High']];
const PASS_SIDES = [['left', 'Left'], ['right', 'Right']];
const RAMP_TYPES = [['06', 'Exit'], ['07', 'Entrance']];

const S = {
  event: 'none', playing: false, t: 0,
  camera: 'low', parkedCamera: false, parkedFormat: 'png', eventCamera: 'auto', lanes: '6', rampLayout: '06', passOn: 'left',
  format: 'png', size: '3840',
  scene: 'road', assist: false, weather: 'default', layers: {traffic: false, buildings: true, trees: true}
};
const isParkingScene = scene => scene === 'parking' || scene === 'outdoor';
const active = () => S.event !== 'none';
const isAdjacentCutIn = () => S.event === 'cutin' && isAdjacentCutInScene(S.scene);
const eventAvailable = event => S.scene !== 'road' || event === 'roadworks' || Number(S.lanes) >= 4;
const newCutInSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
function eventParams() {
  if (S.event === 'roadworks') return {side: S.passOn};
  return isAdjacentCutIn() ? {cutInSeed: S.cutInSeed} : {};
}
const phaseAt = (t, steps) => { let acc = 0; for (let i = 0; i < steps.length; i++) { acc += steps[i][1]; if (t < acc) return i; } return steps.length - 1; };

let dismissPreviewError, vehiclePrefetchTimer;
const preview = createScenePreview({
  clip: document.querySelector('.artboard-clip'),
  engineRevision: document.querySelector('meta[name="scene-engine-revision"]')?.content,
  proEngineRevision: document.querySelector('meta[name="pro-engine-revision"]')?.content,
  onReady(bridge, event, {eventApplied, junctionRestored}) {
    dismissPreviewError?.();
    dismissPreviewError = null;
    clearTimeout(vehiclePrefetchTimer);
    // Keep alternate model downloads off the initial scene's critical path.
    vehiclePrefetchTimer = setTimeout(() => preview.prefetchVehicles(), 1500);
    refreshParkedAvailability(bridge.get({audit: false}));
    renderParkingStatus(bridge.get({audit: false}));
    if (eventApplied) {
      const state = bridge.get({audit: false});
      if (S.liveRoad) {
        if (state.roadworks?.event === S.event) {
          S.roadRun = state.roadworks;
          S.t = Math.max(0, state.roadworks.time - state.roadworks.eventStart);
          S.playing = state.requestedPlaying;
        }
        S.liveRoad = false;
      }
      updateTimeline(state);
      return;
    }
    if (event) {
      bridge.setDrivingEvent(event, eventParams());
      bridge.setRoadworksCamera(S.eventCamera);
      if (junctionRestored) S.t = bridge.get({audit: false}).event.time;
      else bridge.seekRoadworks(S.t);
      if (S.playing) bridge.setPlaying(true);
    } else {
      bridge.finishScene();
      if (restoreParkedEntry) {
        restoreParkedEntry = false;
        if (bridge.restoreParkedPreview?.()) {
          parkedSource = bridge.parkingComposition();
          autoParkedShown = true;
          refreshParkedAvailability(bridge.get({audit: false}));
          void syncParkedView();
        } else void hideParked();
      }
    }
    updateTimeline();
  },
  onRecover() { syncScene(); },
  onError(error, restored) {
    if (error.sceneUnrecoverable) {
      S.playing = false;
      updateTimeline();
      toast(error.message, {label: 'Reload', run: () => location.reload(), persistent: true});
      return;
    }
    if (restored) {
      const {state, event, lanes, rampLayout} = restored;
      const remembered = sceneMemory[state.scene];
      selectScene(state.scene);
      const roadRun = state.roadworks?.event === event ? state.roadworks : null;
      Object.assign(S, {
        event: event ?? 'none', lanes, rampLayout, roadRun, liveRoad: false,
        playing: state.requestedPlaying, assist: state.features.path,
        t: roadRun ? Math.max(0, roadRun.time - roadRun.eventStart) : state.event?.time ?? state.loopTime
      });
      if (remembered) Object.assign(S, {camera: remembered.camera, eventCamera: remembered.eventCamera, cutInSeed: remembered.cutInSeed});
      replaceSceneUrl(state.scene);
      setParkedUrl();
      refreshParkedAvailability(state);
      renderAll({animatePlayback: false});
      dismissPreviewError = toast(error.message);
      return;
    }
    if (restoreParkedEntry) void hideParked();
    S.playing = false;
    updateTimeline();
    dismissPreviewError = toast(error.message);
  }
});
const isTimeline = () => active() && !parkedView();
const parkedView = () => isParkingScene(S.scene) && S.parkedCamera;
const themeName = () => document.documentElement.dataset.theme;
const currentVehicle = () => vehicleOptions.find(option => option.getAttribute('aria-checked') === 'true')?.dataset.vehicle ?? 'model-3';
const parkedClip = document.querySelector('.artboard-clip');
let parkedRenderer, parkedRig, parkedCanvas, parkedFrame, parkedSource, parkedMotion, parkedLive, parkedReturn;
let parkedRigTheme, parkedThemeBlend;
let parkedRequest = 0, parkedPosition = 0, canViewParked = false, restoreParkedEntry = false, parkedReplayPending = false;
let parkedCameraPending = false, exitInProgress = false, autoParkedShown = false;
let resumeAfterScrub = null;
const parkingInteractionsLocked = () => isParkingScene(S.scene) && (transportPending || parkedCameraPending || exitInProgress);
const parkedRatio = 1767 / 1090;
const parkedRenderRevision = '20261121-parked-vehicles';
const parkedMotionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const warmedParkedVehicles = new WeakSet();
const clamp = value => Math.min(1, Math.max(0, value));
const smooth = value => value * value * (3 - 2 * value);
const smoother = value => value ** 3 * (value * (6 * value - 15) + 10);
function compositeParked(live, parked, opacity) {
  const source = opacity < 1 && live ? live : parked;
  if (!source) return;
  const {width, height} = opacity > 0 && parked ? parked : source;
  if (parkedCanvas.width !== width || parkedCanvas.height !== height) {
    parkedCanvas.width = width;
    parkedCanvas.height = height;
  }
  const context = parkedCanvas.getContext('2d', {alpha: false});
  context.drawImage(source, 0, 0, width, height);
  if (parked && source !== parked && opacity > 0) {
    context.globalAlpha = opacity;
    context.drawImage(parked, 0, 0, width, height);
    context.globalAlpha = 1;
  }
  parkedCanvas.hidden = false;
}
function stopParkedThemeBlend(preserveFrame = false) {
  if (!parkedThemeBlend) return;
  const {layer, animation} = parkedThemeBlend;
  if (preserveFrame) compositeParked(parkedCanvas, layer, Number(getComputedStyle(layer).opacity));
  parkedThemeBlend = null;
  animation.cancel();
  layer.remove();
}
function startParkedThemeBlend(layer, frame) {
  stopParkedThemeBlend(true);
  parkedClip.append(layer);
  const animation = layer.animate([{opacity: 0}, {opacity: 1}], {
    duration: SCENE_THEME_DURATION,
    // Match the smoothstep interpolation used by the live scene.
    easing: 'cubic-bezier(.333333,0,.666667,1)',
    fill: 'both'
  });
  parkedThemeBlend = {layer, animation};
  void animation.finished.then(() => {
    if (parkedThemeBlend?.layer !== layer) return;
    compositeParked(null, layer, 1);
    stopParkedThemeBlend();
    if (parkedView() && parkedFrame === frame) rememberParkedFrame(frame.model);
  }, () => {});
}
function paintParkedView(theme = themeName(), prepare = false, motionFrame = false) {
  if (!parkedFrame || (parkedCanvas.hidden && !parkedView()) || !parkedPosition) return;
  const reduced = parkedMotionPreference.matches;
  const progress = reduced ? 1 : smoother(parkedPosition);
  const opacity = smooth(parkedPosition);
  const {clientWidth, clientHeight} = parkedClip;
  if (!clientWidth || !clientHeight) return;
  if (!prepare) stopParkedThemeBlend();
  const animated = motionFrame || parkedPosition !== 1;
  const scale = animated ? Math.min(1, devicePixelRatio, Math.sqrt(420_000 / (clientWidth * clientHeight))) :
    Math.min(2.5, Math.max(2.25, devicePixelRatio), Math.sqrt(5_000_000 / (clientWidth * clientHeight)));
  const returning = parkedReturn && {source: parkedReturn.source,
    weight: parkedReturn.from === 1 ? 1 : smooth(1 - parkedPosition / parkedReturn.from)};
  // Sample both layers at the same instant, including the first render after arrival.
  const frameTime = performance.timeOrigin + performance.now();
  const pose = parkedRig.render({
    ...parkedFrame, theme, width: Math.round(clientWidth * scale), height: Math.round(clientHeight * scale),
    source: parkedSource, returning, progress, animated
  });
  parkedRigTheme = theme;
  if (prepare) return parkedFrame;
  let live;
  if (opacity < 1) {
    parkedLive ??= preview.bridge();
    live = reduced ? parkedLive?.canvas : parkedLive?.paintParkedBlend?.(pose, undefined, 1 - opacity, frameTime);
  }
  compositeParked(live, parkedRig.canvas, opacity);
  parkedCanvas.dataset.vehicle = parkedFrame.model;
  if (!animated && parkedView()) {
    clearParkedEntry();
    rememberParkedFrame(parkedFrame.model);
  }
}
function clearParkedEntry() {
  if (!parkedClip.hasAttribute('data-parked-entry')) return;
  delete parkedClip.dataset.parkedEntry;
  document.documentElement.style.removeProperty('--parked-entry-frame');
}
function finishParkedBlend(destination) {
  const canvas = (parkedLive ?? preview.bridge())?.paintParkedBlend?.(null, destination);
  parkedLive = null;
  return canvas;
}
new ResizeObserver(() => paintParkedView()).observe(parkedClip);
function stopParkedMotion() {
  if (!parkedMotion) return;
  cancelAnimationFrame(parkedMotion.frame);
  parkedMotion.finish();
  parkedMotion = null;
}
function animateParked(to) {
  stopParkedMotion();
  if (parkedPosition === to) return Promise.resolve();
  const from = parkedPosition;
  const reduced = parkedMotionPreference.matches;
  const arriving = to === 1;
  const duration = (reduced ? 160 : arriving ? 2000 : 1820) * Math.abs(to - from);
  const maxFrameMs = reduced ? 160 : arriving ? Infinity : 120;
  return new Promise(finish => {
    const motion = parkedMotion = {finish};
    let previous, elapsed = 0;
    function step(now) {
      elapsed += Math.min(maxFrameMs, now - (previous ?? now));
      previous = now;
      const t = clamp(elapsed / duration);
      parkedPosition = from + (to - from) * t;
      paintParkedView(themeName(), false, true);
      if (t < 1) motion.frame = requestAnimationFrame(step);
      else {
        parkedMotion = null;
        if (to === 1) finishParkedBlend();
        finish();
      }
    }
    motion.frame = requestAnimationFrame(step);
  });
}
function refreshParkedAvailability(state) {
  const run = state?.event;
  const matched = active() ? run?.event === S.event && run.time >= run.duration : !run;
  const sameScene = isParkingScene(S.scene) && state?.scene === S.scene;
  const ready = sameScene && matched &&
    !S.assist && !state.requestedPlaying && !!state.parking?.complete && !state.parking.camera.tween &&
    !!preview.bridge()?.parkingComposition?.();
  if (ready === canViewParked) return;
  canViewParked = ready;
  renderCamera();
  renderPlayback(false);
}
let parkingStatusRenderKey = null;
let parkingHeldRemaining = null;
let parkingLastElapsed = null;
let parkingLastGear = null;
function renderParkingStatus(state) {
  const node = $('parking-status'); if (!node) return;
  const p = state?.parking;
  const hidden = !isParkingScene(S.scene) || parkedView() || !p?.target || !state?.features?.path;
  if (hidden) {
    if (parkingStatusRenderKey !== 'hidden') {
      node.hidden = true;
      delete node.dataset.complete;
      delete node.dataset.executing;
    }
    parkingStatusRenderKey = 'hidden';
    parkingHeldRemaining = null;
    parkingLastElapsed = null;
    parkingLastGear = null;
    return;
  }
  const gear = p.gear || 'P';
  const waiting = ['yield', 'space-taken', 'find-space'].includes(p.phase);
  const stationaryPhase = p.complete || waiting || p.phase === 'shift' || p.phase === 'exit-select';
  const jumped = parkingLastElapsed !== null && Number.isFinite(p.elapsed) && Math.abs(p.elapsed - parkingLastElapsed) > 0.5;
  if (stationaryPhase || jumped || gear !== parkingLastGear) parkingHeldRemaining = null;
  parkingLastElapsed = Number.isFinite(p.elapsed) ? p.elapsed : null;
  parkingLastGear = gear;

  const moving = !!p.active && !p.paused && !stationaryPhase;
  let shownRemaining = null;
  if (!p.paused && !stationaryPhase && Number.isFinite(p.remaining)) {
    const raw = Math.max(0, p.remaining);
    const speed = Number.isFinite(p.speed) ? p.speed : Infinity;
    // Follow true remaining arc-length 1:1 with vehicle speed (d(remaining)/dt = -speed)
    // and only freeze when the car is effectively stopped (speed < 0.05 m/s).
    shownRemaining = parkingHeldRemaining !== null && (!moving || speed < 0.05) && raw > 0.05
      ? parkingHeldRemaining
      : raw;
    parkingHeldRemaining = shownRemaining;
  } else {
    parkingHeldRemaining = null;
  }
  const distance = shownRemaining !== null ? Math.max(0, shownRemaining).toFixed(1) : null;
  const instruction = p.complete ? 'Parked'
    : p.phase === 'exit-select' ? 'Choose exit direction'
    : waiting ? 'Waiting'
    : p.paused ? 'Paused'
    : p.phase === 'shift' ? 'Shifting to ' + gear
    : (p.active ? 'Continue' : 'Ready') + (distance === null ? '' : '\u2009' + distance + ' m');
  const executing = !p.complete && !waiting && !p.paused && !!p.active && ['D', 'R'].includes(gear);
  const reminder = p.complete ? 'Parking complete.'
    : p.phase === 'exit-select' ? 'Check surroundings before moving.'
    : waiting ? 'Waiting for the aisle to clear.'
    : p.paused ? 'Check surroundings before resuming.'
    : 'Parking in progress. Watch your surroundings.';
  const key = gear + '|' + instruction + '|' + reminder + '|' + !!executing;
  if (key === parkingStatusRenderKey) return;
  parkingStatusRenderKey = key;
  node.hidden = false;
  node.dataset.complete = String(!!p.complete);
  node.dataset.executing = String(!!executing);
  node.querySelector('.parking-gear text').textContent = gear;
  node.querySelector('.parking-instruction').textContent = instruction;
  node.querySelector('.parking-reminder').textContent = reminder;
  node.setAttribute('aria-label', p.complete ? 'Parking complete' : gear + ' ' + instruction);
}
function renderParkedControls() {
  setParkedUrl();
  renderCamera();
  renderExport();
  renderPlayback(true);
  renderParkingStatus(preview.bridge()?.get({audit: false}));
}
function showParked(source, animate = true) {
  if (!source || parkedView()) return;
  stopParkedMotion();
  parkedSource = source;
  parkedReturn = null;
  S.parkedCamera = true;
  autoParkedShown = true;
  renderParkedControls();
  void syncParkedView(animate);
}
async function hideParked(animate = false, destination) {
  const id = ++parkedRequest;
  if (animate && parkedPosition && destination) {
    const source = preview.bridge()?.parkingComposition?.(destination);
    if (source) parkedReturn = {source, from: parkedPosition};
  }
  restoreParkedEntry = false;
  clearParkedEntry();
  S.parkedCamera = false;
  renderParkedControls();
  document.querySelector('#scene-properties [data-value=parked]')?.removeAttribute('aria-busy');
  const transitioning = animate && parkedPosition > 0;
  if (transitioning && destination && parkedMotionPreference.matches) finishParkedBlend(destination);
  if (transitioning) await animateParked(0);
  if (id !== parkedRequest) return false;
  stopParkedMotion();
  stopParkedThemeBlend();
  const live = finishParkedBlend(animate ? destination : undefined);
  if (transitioning && live) {
    // Present the exact destination frame before returning presentation to the live iframe.
    compositeParked(live, null, 0);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (id !== parkedRequest) return false;
  }
  if (parkedCanvas) parkedCanvas.hidden = true;
  parkedPosition = 0;
  parkedReturn = null;
  return true;
}
function prepareParkedVehicle(model = currentVehicle()) {
  parkedRenderer ??= import(new URL('../parked-view.bundle.js?v=' + parkedRenderRevision, import.meta.url)).then(({createParkedView}) => {
    parkedRig = createParkedView();
    const canvas = parkedCanvas = document.createElement('canvas');
    canvas.className = 'parked-view';
    canvas.hidden = true;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Parked 3D vehicle');
    parkedClip.append(canvas);
    return parkedRig;
  }).catch(error => { parkedRenderer = null; throw error; });
  return parkedRenderer.then(async rig => {
    const vehicle = await rig.prepareVehicle(model);
    if (!warmedParkedVehicles.has(vehicle) && !parkedView()) {
      warmedParkedVehicles.add(vehicle);
      const warm = () => {
        if (!parkedView() && !parkedPosition && isParkingScene(S.scene) && model === currentVehicle()) {
          // Compile the mirror and blur while approaching the bay, before they enter the handoff.
          rig.render({vehicle, theme: themeName(), width: 240, height: 135, progress: 1, animated: true});
        } else warmedParkedVehicles.delete(vehicle);
      };
      if (window.requestIdleCallback) requestIdleCallback(warm, {timeout: 800});
      else setTimeout(warm, 0);
    }
    return vehicle;
  });
}
async function syncParkedView(animate = false, preparedVehicle) {
  if (!parkedView()) return;
  const id = ++parkedRequest, camera = document.querySelector('#scene-properties [data-value=parked]');
  const model = currentVehicle();
  camera?.setAttribute('aria-busy', 'true');
  try {
    const vehicle = preparedVehicle ?? (parkedFrame?.model === model ? parkedFrame.vehicle : await prepareParkedVehicle(model));
    if (id !== parkedRequest || !parkedView()) return;
    parkedFrame = {model, vehicle};
    if (!animate) parkedPosition = 1;
    paintParkedView();
    if (animate) {
      await animateParked(1);
      // Present the last motion frame before allocating the still's full-size buffers.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (id === parkedRequest && parkedView()) paintParkedView();
    }
  } catch (error) {
    if (id !== parkedRequest) return;
    void hideParked();
    toast(error.message);
  } finally {
    if (id === parkedRequest) camera?.removeAttribute('aria-busy');
  }
}
function setParkedUrl() {
  const url = new URL(location.href);
  const previous = history.state;
  let state = previous;
  if (parkedView()) {
    url.searchParams.set('view', 'parked');
    const model = currentVehicle(), theme = themeName();
    if (state?.parkedPreview?.model !== model || state?.parkedPreview?.theme !== theme) {
      state = {...state, parkedPreview: {model, theme}};
    }
  } else if (url.searchParams.get('view') === 'parked') {
    url.searchParams.delete('view');
    if (state?.parkedPreview) {
      state = {...state};
      delete state.parkedPreview;
    }
  }
  if (url.href !== location.href || state !== previous) history.replaceState(state, '', url);
}
function rememberParkedFrame(model) {
  if (model !== currentVehicle()) return;
  const theme = themeName(), saved = history.state?.parkedPreview;
  if (saved?.model === model && saved?.theme === theme && saved.revision === parkedRenderRevision && saved.poster) return;
  // Keep one bounded poster in this history entry for a native reload.
  const thumbnail = document.createElement('canvas');
  thumbnail.width = Math.min(1440, parkedCanvas.width);
  thumbnail.height = Math.round(thumbnail.width * parkedCanvas.height / parkedCanvas.width);
  const context = thumbnail.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(parkedCanvas, 0, 0, thumbnail.width, thumbnail.height);
  const request = parkedRequest;
  thumbnail.toBlob(blob => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (request !== parkedRequest || !parkedView() || themeName() !== theme) return;
      try {
        history.replaceState({...history.state, parkedPreview: {model, theme, poster: reader.result, revision: parkedRenderRevision}}, '');
      } catch { /* A browser history limit must not prevent the live frame from displaying. */ }
    };
    reader.readAsDataURL(blob);
  }, 'image/jpeg', .94);
}
function syncScene() {
  void preview.show(S.scene, active() ? S.event : null, {
    ...S, model: currentVehicle(), params: eventParams(), theme: themeName()
  });
}
function updateSceneParam(key, value, onFailure) {
  return preview.apply(async (bridge) => {
    try { await bridge.param(key, value); }
    catch (error) { onFailure?.(); throw error; }
  }, {sameScene: key === 'traffic'});
}

/* ---------- Toast and tooltip (reuse the live elements) ---------- */
let toastTimer, dismissToast, persistentToast = false;
function toast(msg, action) {
  if (persistentToast && !action?.persistent) return;
  persistentToast = !!action?.persistent;
  const box = $('feedback'), slot = $('feedback-action'); $('feedback-message').textContent = msg; slot.replaceChildren();
  const dismiss = () => {
    if (dismissToast !== dismiss) return;
    clearTimeout(toastTimer);
    box.hidden = true;
  };
  dismissToast = dismiss;
  if (action) {
    const b = h('<button type="button"></button>'); b.textContent = action.label;
    b.addEventListener('click', () => { dismiss(); action.run(); });
    slot.append(b);
  }
  box.hidden = false; box.setAttribute('role', 'status'); clearTimeout(toastTimer);
  if (!persistentToast) toastTimer = setTimeout(dismiss, action ? 6000 : 4000);
  return dismiss;
}
let tipTimer, tipAnchor;
document.addEventListener('pointerover', (e) => {
  if (!matchMedia('(hover:hover) and (pointer:fine)').matches) return;
  const el = e.target.closest('[data-tip]'); if (!el || el === tipAnchor) return;
  hideTip(); tipTimer = setTimeout(() => showTip(el), 400);
});
document.addEventListener('pointerout', (e) => { const el = e.target.closest('[data-tip]'); if (el && !el.contains(e.relatedTarget)) hideTip(); });
document.addEventListener('pointerdown', hideTip);
function showTip(el) {
  const tip = $('tooltip'); tipAnchor = el; tip.textContent = el.dataset.tip; tip.hidden = false;
  const b = el.getBoundingClientRect(), r = tip.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, b.left + b.width / 2 - r.width / 2)) + 'px';
  tip.style.top = (b.top - r.height - 8 < 8 ? b.bottom + 8 : b.top - r.height - 8) + 'px';
}
function hideTip() { clearTimeout(tipTimer); tipAnchor = null; const t = $('tooltip'); if (t) t.hidden = true; }

/* ---------- Segments (indicator follows the checked item) ---------- */
function layoutSegment(seg) {
  const buttons = [...seg.querySelectorAll('button[role=radio]')];
  if (!buttons.length || !seg.clientWidth) return;
  if (seg.dataset.param !== 'camera') {
    const width = (seg.clientWidth - 4 - 2 * (buttons.length - 1)) / buttons.length;
    buttons.forEach((button) => { button.style.width = width + 'px'; });
  }
  morphSegment(seg, seg.querySelector('[aria-checked=true]') || buttons[0], true);
}
function segmentHTML(label, key, options, value) {
  return `<div class="segment" role="radiogroup" aria-label="${label}" data-key="${key}">${options.map(([v, t]) =>
    `<button type="button" role="radio" aria-checked="${v === value}" tabindex="${v === value ? 0 : -1}" data-value="${v}" data-tip="${label} ${t}">${t}</button>`).join('')}</div>`;
}
function pick(seg, btn, animate = false) {
  seg.querySelectorAll('button[role=radio]').forEach((b) => { const on = b === btn; b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; });
  if (seg.clientWidth) morphSegment(seg, btn, !animate);
}
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.segment button[role=radio]'); if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
  const seg = btn.closest('.segment'); if (seg.closest('#vehicle-panel')) return;
  const key = seg.dataset.key || seg.dataset.param, v = btn.dataset.value;
  if (key === 'camera' && isParkingScene(S.scene) && (transportPending || parkedReplayPending || parkedCameraPending)) return;
  if (key === 'camera' && v === 'parked') {
    if (canViewParked) showParked(preview.bridge()?.parkingComposition?.());
    return;
  }
  pick(seg, btn, e.detail > 0);
  if (key === 'camera') {
    const {scene, event} = S;
    const inEvent = active();
    if (inEvent) S.eventCamera = v;
    else {
      S.camera = v;
      if (!isParkingScene(scene)) S.eventCamera = v;
    }
    if (parkedView() || parkedPosition) {
      const destination = v !== 'auto' && preview.bridge()?.parkingComposition?.(v) ? v : undefined;
      parkedCameraPending = true;
      renderInteraction(false, false);
      try {
        if (!await hideParked(true, destination) || S.scene !== scene || S.event !== event || S.assist || destination) return;
      } finally {
        parkedCameraPending = false;
        renderInteraction(false, false);
      }
    }
    if (inEvent) void preview.apply(bridge => bridge.setRoadworksCamera(v, {animate: true}));
    else void updateSceneParam('camera', v);
  }
  else if (key === 'lanes' && S.lanes !== v) {
    S.lanes = v;
    if (active() && !eventAvailable(S.event)) {
      if (S.eventCamera !== 'auto') S.camera = S.eventCamera;
      Object.assign(S, {event: 'none', liveRoad: true, roadRun: null});
      renderAll({animateControls: e.detail > 0});
    } else {
      renderInteraction(false, false);
      syncScene();
    }
  }
  else if (key === 'side') changeRoute(v);
  else if (key === 'ramp-type') changeRampType(v);
});
document.addEventListener('keydown', (e) => {
  const btn = e.target.closest && e.target.closest('.segment button[role=radio], .shared-weather-options button[role=radio], .pb-seg button[role=radio]'); if (!btn || btn.disabled) return;
  const btns = [...btn.parentElement.querySelectorAll('button[role=radio]:not(:disabled):not([aria-disabled=true])')], i = btns.indexOf(btn);
  const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: btns.length - 1 }[e.key];
  if (next === undefined) return; e.preventDefault();
  const target = btns[(next + btns.length) % btns.length]; target.focus(); target.click();
});
function layoutAllSegments() {
  document.querySelectorAll('.segment').forEach((s) => { if (!s.closest('#vehicle-panel')) layoutSegment(s); });
  document.querySelectorAll('.shared-weather-options').forEach((s) => {
    const selected = s.querySelector('[aria-checked=true]');
    if (selected && s.clientWidth) morphSegment(s, selected, true);
  });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.shared-weather-options button'); if (!b || !sceneHasWeather(S.scene)) return;
  b.parentElement.querySelectorAll('button').forEach((x) => { x.setAttribute('aria-checked', x === b); x.tabIndex = x === b ? 0 : -1; });
  S.weather = b.dataset.weather;
  morphSegment(b.parentElement, b, e.detail === 0);
  updateSceneParam('weather', S.weather);
});

/* ---------- Menus (live .format-options popover) ---------- */
let openMenu = null;
function closeMenu(focusTrigger) {
  if (!openMenu) return; const { el, trigger, own } = openMenu;
  if (own) el.remove(); else el.hidden = true;
  trigger.setAttribute('aria-expanded', 'false'); openMenu = null; if (focusTrigger) trigger.focus();
}
function showMenu(trigger, el, { up = false, own = true, alignRight = false, width } = {}) {
  closeMenu(); if (own) document.body.append(el);
  el.hidden = false;
  const r = trigger.getBoundingClientRect();
  const inset = 8, gap = 4;
  el.style.width = (width || Math.max(160, r.width)) + 'px';
  const w = el.offsetWidth;
  if (up === 'auto') {
    const below = innerHeight - r.bottom;
    up = below < el.offsetHeight + gap + inset && r.top > below;
  }
  el.classList.toggle('up', up);
  const left = alignRight ? r.right - w : r.left;
  el.style.left = Math.max(inset, Math.min(innerWidth - w - inset, left)) + 'px';
  el.style.bottom = up ? (innerHeight - r.top + gap) + 'px' : '';
  el.style.top = up ? '' : (r.bottom + gap) + 'px';
  trigger.setAttribute('aria-expanded', 'true'); openMenu = { el, trigger, own };
  (el.querySelector('[aria-selected=true], [aria-checked=true]') || el.querySelector('button'))?.focus({ preventScroll: true });
}
document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.el.contains(e.target) && !openMenu.trigger.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenu) return closeMenu(true);
  if (!openMenu || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  const items = [...openMenu.el.querySelectorAll('button')], i = items.indexOf(document.activeElement);
  e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
});
addEventListener('resize', () => { closeMenu(); layout(); layoutAllSegments(); });

let dismissVehicleError;
const vehicleCard = document.querySelector('.shell-vehicle-card');
const vehicleOptions = [...$('vehicle-strip').querySelectorAll('[data-vehicle]')];
function selectVehicleOption(option) {
  for (const item of vehicleOptions) item.setAttribute('aria-checked', String(item === option));
  const name = option.getAttribute('aria-label');
  vehicleCard.querySelector('.name').textContent = name;
  vehicleCard.querySelector('img').src = option.querySelector('img').src;
  vehicleCard.setAttribute('aria-label', 'Vehicle: ' + name);
}
function showVehicles() {
  if (vehicleCard.getAttribute('aria-busy') === 'true') return;
  if (openMenu?.trigger === vehicleCard) return closeMenu(true);
  const menu = h('<div class="shell-vehicle-menu" role="menu" aria-label="Vehicle"></div>');
  for (const source of vehicleOptions) {
    const option = h('<button type="button" role="menuitemradio" tabindex="-1"><img alt=""><span></span></button>');
    const name = source.getAttribute('aria-label'), image = source.querySelector('img').src;
    option.setAttribute('aria-checked', source.getAttribute('aria-checked'));
    option.querySelector('img').src = image;
    option.querySelector('span').textContent = name;
    const prefetch = () => preview.prefetchVehicles([source.dataset.vehicle]);
    option.addEventListener('pointerenter', prefetch);
    option.addEventListener('focus', prefetch);
    option.addEventListener('click', async () => {
      closeMenu(true);
      if (source.getAttribute('aria-checked') === 'true') return;
      dismissVehicleError?.();
      const model = source.dataset.vehicle;
      const previous = vehicleOptions.find(option => option.dataset.vehicle === currentVehicle());
      vehicleCard.setAttribute('aria-busy', 'true');
      vehicleCard.setAttribute('aria-label', 'Loading ' + name);
      vehicleCard.querySelector('.name').textContent = 'Loading…';
      let vehicle;
      const parked = parkedView() ? prepareParkedVehicle(model).catch(error => error) : null;
      try {
        await preview.selectVehicle(model, parked && (async () => {
          const result = await parked;
          if (!parkedView()) return;
          if (result instanceof Error) throw result;
          vehicle = result;
        }));
        selectVehicleOption(source);
        await syncParkedView(false, vehicle);
      } catch (error) {
        selectVehicleOption(previous);
        dismissVehicleError = toast(error.message);
      } finally {
        vehicleCard.removeAttribute('aria-busy');
      }
    });
    menu.append(option);
  }
  menu.addEventListener('keydown', e => { if (e.key === 'Tab') closeMenu(true); });
  const compact = matchMedia('(max-width:639px), (max-width:959px) and (max-height:500px), (max-width:959px) and (orientation:portrait)').matches;
  showMenu(vehicleCard, menu, {up: !compact, alignRight: compact, width: compact ? Math.min(280, innerWidth - 32) : vehicleCard.getBoundingClientRect().width});
}
vehicleCard.addEventListener('click', showVehicles);
vehicleCard.addEventListener('keydown', e => {
  if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  showVehicles();
});

/* ---------- Inspector: interaction, camera, layers, guide, export ---------- */
const SCENE_EVENTS = Object.entries(EVENTS);
const sceneHasEvent = (scene, event) => {
  if (isParkingEvent(event)) return ['parking', 'outdoor'].includes(scene);
  if (event === 'roadworks') return scene === ROADWORKS_SCENE;
  if (event === 'lanechange') return scene === 'road';
  if (event === JUNCTION_LEFT_TURN) return scene === 'junction';
  return isAdjacentCutInScene(scene);
};
const focusEvent = (event) => document.querySelector(`[data-event="${event}"]`)?.focus({ preventScroll: true });
function renderInteraction(animate, animateControls) {
  const sec = $('interaction-settings');
  const elevated = S.scene === ROADWORKS_SCENE;
  sec.hidden = !elevated && S.scene !== 'junction' && !isAdjacentCutInScene(S.scene) && !['parking', 'outdoor'].includes(S.scene);
  if (sec.hidden) {
    sec.replaceChildren();
    return;
  }
  const eventGroup = S.scene;
  if (!sec.firstElementChild || sec.dataset.group !== eventGroup) {
    sec.dataset.group = eventGroup;
    sec.innerHTML = `<h2>Interaction</h2>
    <div class="event-list" role="group" aria-label="Interaction events">${SCENE_EVENTS.filter(([event]) => sceneHasEvent(S.scene, event)).map(([event]) => {
      const label = eventLabel(event);
      const toggle = `<button type="button" class="layer-row" role="switch" data-event="${event}"><span>${label}</span>${LAYER_CHECK}</button>`;
      if (event !== 'roadworks') return toggle;
      return `<div class="roadworks-controls" role="group" aria-label="Roadworks setup">${toggle}
        <div class="event-disclosure"><div class="event-disclosure-clip"><div class="properties event-params">
          <div class="property"><span class="property-label">Pass on</span>${segmentHTML('Pass on', 'side', PASS_SIDES, S.passOn)}</div>
        </div></div></div>
      </div>`;
    }).join('')}</div>`;
  }
  sec.dataset.motion = animate ? 'live' : 'instant';
  for (const row of sec.querySelectorAll('[data-event]')) {
    const event = row.dataset.event, label = eventLabel(event);
    if (row.firstElementChild.textContent !== label) row.firstElementChild.textContent = label;
    const on = active() && S.event === event;
    const unavailable = !eventAvailable(event);
    const parkingLocked = parkingInteractionsLocked();
    const tip = parkingLocked ? 'Available after the parking exit' : unavailable ? label + ' needs two lanes in the same direction. Choose 4 or 6 lanes.' :
      on ? 'Turn off ' + label : active() ? (S.event === 'lanechange' && event === 'cutin' ? 'Queue ' : 'Switch to ') + label : 'Play ' + label;
    setToggle(row, 'aria-checked', on, animateControls);
    row.dataset.tip = tip;
    if (unavailable || parkingLocked) row.setAttribute('aria-disabled', 'true');
    else row.removeAttribute('aria-disabled');
    if (unavailable || parkingLocked) row.setAttribute('aria-description', tip);
    else row.removeAttribute('aria-description');
  }
  const seg = sec.querySelector('.segment[data-key=side]');
  if (seg) {
    const enabled = active() && S.event === 'roadworks';
    const disclosure = seg.closest('.event-disclosure');
    disclosure.inert = !enabled;
    disclosure.setAttribute('aria-hidden', String(!enabled));
    for (const button of seg.querySelectorAll('button')) button.disabled = !enabled;
  }
  if (seg && seg.querySelector('[aria-checked=true]')?.dataset.value !== S.passOn) {
    const btn = seg.querySelector(`[data-value=${S.passOn}]`); if (btn) pick(seg, btn);
  }
}
// Starting a new run slides the playhead back to 0 instead of jumping.
function slideToStart() {
  const tl = $('event-timeline'); tl.classList.add('is-resetting');
  clearTimeout(slideToStart.timer); slideToStart.timer = setTimeout(() => tl.classList.remove('is-resetting'), 760);
}
function changeRoute(side) {
  if (!active() || S.event !== 'roadworks' || side === S.passOn) return;
  S.passOn = side;
  void preview.apply(bridge => {
    bridge.cutRoadworksSide(S.passOn);
    updateTimeline();
  });
}
$('interaction-settings').addEventListener('click', (e) => {
  const row = e.target.closest('[data-event]');
  if (!row || row.getAttribute('aria-disabled') === 'true') return;
  const event = row.dataset.event;
  if (isParkingScene(S.scene)) {
    const state = preview.bridge()?.get({audit:false});
    if (parkingInteractionsLocked() || state?.parking?.mode === 'out') return;
    const turningOff = active() && S.event === event;
    const completed = state?.event?.event === event && state.parking.complete;
    if (turningOff && completed) {
      S.camera = S.eventCamera === 'high' ? 'high' : 'low';
    } else {
      canViewParked = false;
      void hideParked();
    }
  }
  resumeAfterScrub = null;
  const wasPlaying = S.playing;
  closeMenu();
  if (['road', 'elevated', 'ramp'].includes(S.scene) && preview.hasMountedScene(S.scene)) {
    const next = active() && S.event === event ? 'none' : event;
    if (next === 'none' && S.eventCamera !== 'auto') S.camera = S.eventCamera;
    Object.assign(S, {event: next, t: 0, liveRoad: true, roadRun: null,
      playing: true, laneChange: null, laneChangePhases: null});
    if (next === 'cutin') S.cutInSeed = newCutInSeed();
    lastGuide = -1;
    const animateControls = e.detail > 0;
    renderAll({animatePlayback: animateControls, animateDisclosure: false, animateControls});
    return;
  }
  S.liveRoad = false;
  S.roadRun = null;
  if (active() && S.event === event) {
    if (S.scene === 'junction' && S.eventCamera !== 'auto') S.camera = S.eventCamera;
    Object.assign(S, {event: 'none', parkingRun: null, playing: false, t: 0});
    renderAll({animatePlayback: e.detail > 0, animateControls: e.detail > 0});
  } else if (active()) {
    // Selecting another parking demo starts its own playback, as on first selection.
    slideToStart();
    Object.assign(S, {event, parkingRun: null, t: 0, playing: isParkingEvent(event) || wasPlaying});
    lastGuide = -1;
    renderAll({animatePlayback: false, animateControls: e.detail > 0});
  } else {
    startEvent(event, {animatePlayback: e.detail > 0, animateControls: e.detail > 0});
  }
});

// Mirror the workbench Layers rules in this prototype, including responsive rules.
function applyLayerStylesToEvents() {
  const rules = [];
  function collect(source, wrap) {
    for (const rule of source) {
      if (rule.selectorText?.includes('#layers') && rule.selectorText.includes('layer-row')) {
        rules.push(wrap(rule.cssText.replaceAll('#layers', '#interaction-settings .event-list').replaceAll('aria-pressed', 'aria-checked')));
      } else if (rule.media && rule.cssRules) {
        collect(rule.cssRules, (text) => wrap(`@media ${rule.media.mediaText}{${text}}`));
      }
    }
  }
  for (const sheet of document.styleSheets) {
    try { collect(sheet.cssRules, (text) => text); } catch { /* Ignore inaccessible external styles. */ }
  }
  const style = document.createElement('style');
  style.textContent = rules.join('\n');
  document.head.append(style);
}
applyLayerStylesToEvents();

function startEvent(event, {animatePlayback = true, animateControls = false} = {}) {
  if (!sceneHasEvent(S.scene, event)) {
    const scene = isParkingEvent(event) ? 'parking' : event === JUNCTION_LEFT_TURN ? 'junction' : event === 'lanechange' || event === 'cutin' ? 'road' : ROADWORKS_SCENE;
    sceneMemory[S.scene] = {camera: S.camera, eventCamera: S.eventCamera};
    S.camera = sceneMemory[scene]?.camera ?? S.camera;
    S.eventCamera = sceneMemory[scene]?.eventCamera ?? (!isParkingScene(scene) && S.camera === 'high' ? 'high' : 'auto');
    selectScene(scene);
  }
  if (!eventAvailable(event)) return;
  if (isParkingScene(S.scene)) {
    S.assist = false;
    canViewParked = false;
    void hideParked();
    void prepareParkedVehicle().catch(() => {});
  }
  Object.assign(S, {event, parkingRun: null, roadRun: null, liveRoad: false, t: 0, playing: true});
  if (event === 'lanechange') S.laneChange = S.laneChangePhases = null;
  if (isAdjacentCutIn()) S.cutInSeed = newCutInSeed();
  renderAll({animatePlayback, animateControls});
}

function changeRampType(layout) {
  if (S.rampLayout === layout) return;
  S.rampLayout = layout;
  S.roadRun = S.cutInTiming = S.rampMerge = S.mergePhases = null;
  const url = new URL(location.href);
  if (layout === '07') url.searchParams.set('type', 'merge');
  else url.searchParams.delete('type');
  history.replaceState(history.state, '', url);
  if (isAdjacentCutIn()) {
    if (S.t > 0) slideToStart();
    S.t = 0;
    S.cutInSeed = newCutInSeed();
  }
  renderAll({animatePlayback: false});
}
function renderRampType() {
  const properties = $('scene-properties');
  let row = properties.querySelector('.ramp-type');
  if (!row && S.scene === 'ramp') {
    row = h(`<div class="property ramp-type"><span class="property-label">Type</span>${segmentHTML('Type', 'ramp-type', RAMP_TYPES, S.rampLayout)}</div>`);
    properties.prepend(row);
  }
  if (row) row.hidden = S.scene !== 'ramp';
}
// Every event can hold a fixed Low or High camera; Auto follows the event.
const eventCameraChoice = () => active();
function renderCamera() {
  const prop = document.querySelector('#scene-properties .segment[data-param=camera]'); if (!prop) return;
  const mode = isParkingScene(S.scene) ? eventCameraChoice() ? 'parking-event' : 'parking' : eventCameraChoice() ? 'event' : 'scene';
  if (prop.dataset.prototypeOptions !== mode) {
    prop.dataset.prototypeOptions = mode;
    const tips = {auto: 'Camera follows the event', low: 'Camera Low', high: 'Camera High', parked: 'Parked view'};
    // Keep the existing selection indicator mounted when the camera options change.
    prop.querySelectorAll('button[role=radio]').forEach((button) => button.remove());
    const options = mode === 'parking-event' ? [...EVENT_CAMERAS, PARKING_CAMERAS.at(-1)] :
      mode === 'event' ? EVENT_CAMERAS : mode === 'parking' ? PARKING_CAMERAS : CAMERAS;
    prop.insertAdjacentHTML('beforeend', options.map(([v, t]) =>
      `<button type="button" role="radio" aria-checked="false" tabindex="-1" data-value="${v}" data-tip="${tips[v]}">${t}</button>`).join(''));
  }
  const parked = prop.querySelector('[data-value=parked]');
  if (parked) {
    const available = canViewParked || parkedView();
    parked.setAttribute('aria-disabled', String(!available));
    parked.dataset.tip = available ? 'Parked view' : 'Available after parking is complete';
  }
  const value = parkedView() ? 'parked' : eventCameraChoice() ? S.eventCamera : S.camera;
  const selected = prop.querySelector(`[data-value="${value}"]`);
  if (selected && selected.getAttribute('aria-checked') !== 'true') pick(prop, selected);
}

const toggleAnimations = new WeakMap();
function setToggle(row, attribute, on, animate = false) {
  let thumb = row.querySelector('.layer-thumb');
  const previous = row.getAttribute(attribute);
  if (!thumb) {
    thumb = h('<span class="layer-thumb" aria-hidden="true"></span>');
    row.append(thumb);
    animate = false;
  } else if (previous === String(on)) return;
  const running = toggleAnimations.get(thumb);
  if (!animate || reducedMotion()) {
    running?.animation.cancel();
    toggleAnimations.delete(thumb);
    row.setAttribute(attribute, on);
    return;
  }

  // Sample the current presentation before cancelling, so a quick reversal keeps its position and velocity.
  const matrix = new DOMMatrixReadOnly(getComputedStyle(thumb).transform);
  const phase = running ? Math.min(1, Math.max(0, Number(running.animation.currentTime) / running.duration)) : 1;
  const velocity = running?.velocities[Math.round(phase * (running.velocities.length - 1))] || 0;
  const shape = (running?.shapePhase || 0) + phase;
  const shapePhase = shape < 1 ? shape : 0;
  running?.animation.cancel();
  row.setAttribute(attribute, on);
  const target = on ? thumb.offsetWidth : 0;
  const {frames, duration, velocities} = toggleMotionFrames(
    {x: matrix.m41, width: matrix.a, height: matrix.d, velocity}, target, undefined, shapePhase
  );
  const animation = thumb.animate(frames, {duration});
  toggleAnimations.set(thumb, {animation, duration, velocities, shapePhase});
  animation.onfinish = () => {
    if (toggleAnimations.get(thumb)?.animation === animation) toggleAnimations.delete(thumb);
  };
}
const trafficRow = document.querySelector('#layers [data-layer=traffic]');
function renderLayers(animate) {
  const indoor = !sceneHasWeather(S.scene);
  const layers = $('layers');
  layers.closest('section').hidden = indoor;
  $('shared-settings').hidden = indoor;
  for (const row of layers.querySelectorAll('.layer-row')) {
    if (row === trafficRow) continue;
    row.hidden = !sceneHasExteriorLayers(S.scene);
    setToggle(row, 'aria-pressed', S.layers[row.dataset.layer] === true);
  }
  const locked = active() && !['roadworks', JUNCTION_LEFT_TURN].includes(S.event), tip = 'Traffic is set by the event';
  trafficRow.disabled = locked;
  trafficRow.classList.toggle('event-controlled', locked);
  setToggle(trafficRow, 'aria-pressed', locked || S.layers.traffic, animate);
  trafficRow.dataset.tip = locked ? tip : 'Traffic';
  if (locked) trafficRow.setAttribute('aria-description', tip);
  else trafficRow.removeAttribute('aria-description');
}
const layerRequests = new Map();
$('layers').addEventListener('click', (e) => {
  const r = e.target.closest('.layer-row'); if (!r || r.disabled || r.closest('[hidden]')) return;
  const on = r.getAttribute('aria-pressed') !== 'true';
  setToggle(r, 'aria-pressed', on, e.detail > 0);
  S.layers[r.dataset.layer] = on;
  const layer = r.dataset.layer, request = (layerRequests.get(layer) ?? 0) + 1, scene = S.scene;
  layerRequests.set(layer, request);
  const change = updateSceneParam(r.dataset.layer, on, () => {
    if (request !== layerRequests.get(layer) || scene !== S.scene) return;
    S.layers[r.dataset.layer] = !on;
    setToggle(r, 'aria-pressed', !on, false);
  });
  if (S.event === 'roadworks' && r.dataset.layer === 'traffic') void change.then(() => updateTimeline());
});
function renderGuide() {
  const box = $('tl-guide'); if (!box) return;
  if (!active()) return;
  const steps = phases(), ended = !S.playing && S.t >= total();
  const held = S.event === JUNCTION_LEFT_TURN && S.junctionTiming?.turnAt === Infinity
    || S.event === 'roadworks' && S.roadRun?.workZoneTiming?.clearAt === Infinity;
  const [phase, , guide] = ended && !held ? ['End', 0, 'Replay to watch again, or drag to pick a frame.'] : steps[phaseAt(S.t, steps)];
  const html = `<b>${phase}</b>${guide}`;
  const current = box.querySelector('p:not(.out)');
  if (current?.innerHTML === html) return;
  // Crossfade between phases: the old line fades out while the new one fades in, stacked in one grid cell.
  box.querySelectorAll('p').forEach((old) => {
    if (old.classList.contains('out')) return old.remove();
    old.classList.remove('in'); old.classList.add('out');
    setTimeout(() => old.remove(), 240);
  });
  const next = document.createElement('p'); next.className = 'in'; next.innerHTML = html;
  box.append(next);
}
let lastGuide = -1;
const sizeLabel = (width, parked) => width + ' × ' + Math.round(parked ? width / parkedRatio : width * 9 / 16);
const currentFormat = () => parkedView() ? S.parkedFormat : S.format;
const currentFormats = () => parkedView() ? FORMATS.filter(([id]) => id === 'png' || id === 'camera') : FORMATS;
function renderExport() {
  const format = currentFormat();
  const label = FORMATS.find((f) => f[0] === format)[1];
  document.querySelector('.format-trigger[aria-controls=format-options] span').textContent = label;
  $('format').value = format;
  const parked = parkedView();
  const sizeTrigger = document.querySelector('.format-trigger[aria-controls=image-size-options]');
  for (const item of $('image-size-options').querySelectorAll('button[data-value]')) {
    item.textContent = sizeLabel(Number(item.dataset.value), parked);
  }
  sizeTrigger.querySelector('span').textContent = sizeLabel(Number(S.size), parked);
  $('overlay-export')?.remove();
}
document.querySelector('.format-trigger[aria-controls=format-options]').addEventListener('click', (e) => {
  const t = e.currentTarget; if (openMenu?.trigger === t) return closeMenu();
  const m = $('format-options');
  m.innerHTML = currentFormats().map(([v, label]) => `<button type="button" role="option" aria-selected="${currentFormat() === v}" tabindex="-1" data-value="${v}">${label}</button>`).join('');
  m.onclick = (ev) => { const b = ev.target.closest('button[data-value]'); if (!b) return; closeMenu(true);
    S[parkedView() ? 'parkedFormat' : 'format'] = b.dataset.value; renderExport(); };
  showMenu(t, m, { up: true, own: false, alignRight: true, width: Math.max(176, t.getBoundingClientRect().width) });
});
document.querySelector('.format-trigger[aria-controls=image-size-options]').addEventListener('click', (e) => {
  const t = e.currentTarget; if (openMenu?.trigger === t) return closeMenu();
  const m = $('image-size-options');
  m.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.value === S.size));
  m.onclick = (ev) => { const b = ev.target.closest('button[data-value]'); if (!b) return; S.size = b.dataset.value; t.querySelector('span').textContent = b.textContent; closeMenu(true); };
  showMenu(t, m, { up: true, own: false });
});
$('export').addEventListener('click', async () => {
  const button=$('export'), format=currentFormat(), width=Number(S.size), parked=parkedView();
  if(button.disabled) return;
  const base = parked ? 'parked' : active() ? eventLabel(S.event).toLowerCase().replaceAll(' ', '-') : S.scene;
  const name = { png: base + '.png', kit: base + '-perspective-kit.zip', camera: base + '-camera.json', depth: base + '-depth.png', video: base + '.mp4' }[format];
  button.disabled=true;
  button.setAttribute('aria-busy','true');
  try {
    button.textContent='Exporting…';
    let blob;
    if (parked) {
      if (!parkedRig || parkedCanvas.hidden || parkedFrame?.model !== currentVehicle()) throw Error('The parked view is still loading. Try exporting again.');
      try {
        blob = await parkedRig.exportFrame({format,width,height:Math.round(width / parkedRatio)});
      } finally { paintParkedView(); }
    } else {
      const bridge=preview.bridge();
      if(!bridge)throw Error('The scene is still loading. Try exporting again.');
      ({blob}=await bridge.export({format,width,onProgress:percent => {button.textContent='Exporting '+percent+'%';}}));
    }
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    Object.assign(link,{href:url,download:name});
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),30_000);
    toast('Exported '+name);
  } catch(error) { toast(error.message); }
  finally { button.disabled=false;button.removeAttribute('aria-busy');button.textContent='Export'; }
});

/* ---------- Timeline ---------- */
function buildTimeline() {
  const tl = h(`<div id="event-timeline" role="group" aria-label="Interaction timeline" inert aria-hidden="true">
    <button type="button" class="tl-play" id="tl-play" aria-label="Pause" data-tip="Pause">${ICON.pause}</button>
    <div class="tl-body">
      <div class="tl-track">
        <div class="tl-progress" aria-hidden="true"></div>
        <div class="tl-notches" aria-hidden="true"></div>
        <input class="tl-range" id="tl-range" type="range" min="0" max="1000" step="1" value="0" aria-label="Timeline position">
        <span class="tl-thumb" aria-hidden="true"></span>
      </div>
    </div>
    <div class="tl-readout" aria-hidden="true"></div>
  </div>`);
  const playback = $('canvas-playback'), assist = $('scene-transport');
  playback.dataset.mode = 'assist';
  playback.prepend(h('<div class="playback-surface" aria-hidden="true"></div>'));
  // The wheel exists in both states, so it is one element that travels with the plate's edge;
  // the button and the timeline only hold a space for it.
  assist.innerHTML = '<span class="playback-wheel-space" aria-hidden="true"></span><span class="playback-label-measure" aria-hidden="true">Driving assist</span>';
  // One shot: the wheel travels with the plate's left edge, and the "Driving assist" words travel to the
  // right end of the bar, where they become the time. Only the words themselves crossfade.
  playback.append(tl, h(`<div class="playback-leading"><span class="playback-wheel" id="playback-wheel" role="img" aria-label="Driving assist on">${assistWheelOff}${assistWheelOn}</span><span class="tl-divider" aria-hidden="true"></span></div>`),
    h('<span class="playback-text" aria-hidden="true"><span class="pt-label">Driving assist</span><span class="pt-time tl-time" id="tl-time">0.0 s</span></span>'));
  const footer = h('<div id="playback-footer"></div>');
  playback.before(footer);
  footer.append(playback, h('<div id="tl-guide" aria-live="polite" aria-hidden="true"></div>'));
  const wheel = $('playback-wheel');
  wheel.addEventListener('click', () => {
    if (wheel.getAttribute('role') === 'button') void toggleSceneAssist();
  });
  wheel.addEventListener('keydown', e => {
    if (wheel.getAttribute('role') !== 'button' || !['Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    wheel.click();
  });
  $('tl-play').addEventListener('click', async () => {
    if (parkedReplayPending) return;
    const replay = !S.playing && S.t >= total();
    const reroll = replay && isAdjacentCutIn();
    if (parkedView() || parkedPosition) {
      const {scene, event} = S;
      parkedReplayPending = true;
      const leftParked = await hideParked(true);
      parkedReplayPending = false;
      if (!leftParked || scene !== S.scene || event !== S.event) return;
    }
    if (replay) { S.t = 0; S.roadRun = null; }
    if (reroll) S.cutInSeed = newCutInSeed();
    S.playing = !S.playing;
    void preview.apply(bridge => {
      if (!active()) return;
      if (replay) bridge.clearRoadRun();
      if (reroll) bridge.setDrivingEvent(S.event, eventParams());
      if (S.playing && S.t === 0) bridge.seekRoadworks(0);
      bridge.setPlaying(S.playing, {newRun: replay && !reroll});
    });
    updateTimeline();
  });
  // Scrubbing holds the frame; if the event was playing, it carries on from the new point on release.
  $('tl-range').addEventListener('change', () => {
    const resume = resumeAfterScrub; resumeAfterScrub = null;
    if (!resume || !isTimeline() || S.t >= total()) return;
    void preview.apply(bridge => {
      if (!isTimeline()) return;
      bridge.setPlaying(true);
      const state = bridge.get({audit: false});
      S.playing = state.requestedPlaying;
      updateTimeline(state);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || !isTimeline() || openMenu || e.target.closest?.('button, input, select, textarea, [role=radio], [role=switch]')) return;
    e.preventDefault(); $('tl-play').click();
  });
  $('tl-range').addEventListener('input', (e) => {
    if (!isTimeline()) return;
    if (parkedPosition) void hideParked();
    resumeAfterScrub ??= S.playing;
    const progress = e.target.valueAsNumber;
    const time = progress === Number(e.target.max) ? total() : progress / 100;
    S.t = time;
    S.playing = false;
    void preview.apply(bridge => {
      if (!isTimeline()) return;
      bridge.seekRoadworks(time + (S.roadRun?.eventStart ?? 0));
      S.t = time;
      S.playing = false;
      updateTimeline(bridge.get({audit: false}));
    });
  });
  // Hover the track to read the phase at that point; the track itself stays one clean line.
  const range = $('tl-range'), track = tl.querySelector('.tl-track');
  range.addEventListener('pointermove', (e) => {
    if (!active()) return;
    const b = track.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)), t = f * total(), steps = phases();
    const tip = $('tooltip'); tipAnchor = range; tip.textContent = steps[phaseAt(t, steps)][0] + '  ' + t.toFixed(1) + ' s'; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, b.left + f * b.width - r.width / 2)) + 'px';
    tip.style.top = (b.top - r.height - 14) + 'px';
  });
  range.addEventListener('pointerleave', hideTip);
}
const playbackWait = () => S.event === JUNCTION_LEFT_TURN ? [stopAt, S.junctionTiming?.turnAt ?? turnAt] :
  isParkingEvent(S.event) && S.parkingRun ? [S.parkingRun.yieldEnd ?? S.parkingRun.decisionAt, S.parkingRun.releaseAt] : EVENTS[S.event]?.wait;
function updateTimeline(state) {
  const tl = $('event-timeline'); if (!tl || !active()) return;
  if (S.event === 'roadworks') {
    const run = (state ?? preview.bridge()?.get({audit:false}))?.roadworks;
    if (run?.event === S.event) S.roadRun = run;
  }
  if (S.event === JUNCTION_LEFT_TURN) {
    const run = (state ?? preview.bridge()?.get({audit: false}))?.event;
    S.junctionTiming = run?.event === S.event ? run.timing : undefined;
  }
  if (isParkingEvent(S.event)) {
    const current = state ?? preview.bridge()?.get({audit: false});
    const run = current?.event;
    if (run?.event === S.event) S.parkingRun = run;
    renderParkingStatus(current);
  }
  if (isAdjacentCutIn() && !isRampMerge()) {
    const road = (state ?? preview.bridge()?.get({audit: false}))?.roadworks;
    S.cutInTiming = road?.event === S.event && road.time >= road.eventStart + road.handoff ? road.cutInTiming : null;
  }
  if (isRampMerge() && S.event === 'cutin') {
    const merge = (state ?? preview.bridge()?.get({audit: false}))?.roadworks?.rampMerge;
    if (S.rampMerge !== merge) {
      S.rampMerge = merge;
      S.mergePhases = merge && mergePhases(merge);
      S.mergeTimelineKey = S.mergePhases?.map(([phase, duration]) => phase + duration).join(':') ?? '';
    }
  }
  if (S.event === 'lanechange') {
    const road = (state ?? preview.bridge()?.get({audit: false}))?.roadworks;
    const maneuver = road?.time >= (road?.eventStart ?? 0)+(road?.handoff ?? 0) ? road?.laneChange : null;
    if (S.laneChange !== maneuver) {
      S.laneChange = maneuver;
      S.laneChangePhases = maneuver && laneChangePhases(maneuver);
    }
  }
  const steps = phases();
  const eventKey = S.scene + ':' + S.event
    + (S.event === JUNCTION_LEFT_TURN ? ':' + S.junctionTiming?.turnAt : '')
    + (isParkingEvent(S.event) || S.event === 'roadworks' ? ':' + steps.map(([p, d]) => p + d).join(':') : '')
    + (isRampMerge() ? ':merge:' + (S.mergeTimelineKey ?? '') : '')
    + (isAdjacentCutIn() && !isRampMerge() ? ':' + steps.map(([label, duration]) => label + duration).join(':') : '')
    + ':' + (S.roadRun?.eventStart ?? 0)
    + (S.event === 'lanechange' ? ':' + S.laneChange?.steerAt + ':' + S.laneChange?.conflictAt + ':' + S.laneChange?.clearAt : '');
  if (tl.dataset.timelineEvent !== eventKey) {
    tl.dataset.timelineEvent = eventKey;
    lastGuide = -1;
    let at = 0;
    tl.querySelector('.tl-notches').innerHTML = steps.slice(0, -1).map(([, d]) => `<span style="left:${(at += d) / total() * 100}%"></span>`).join('');
    tl.setAttribute('aria-label', eventLabel(S.event) + ' timeline');
    renderWait(tl);
  }
  const wait = playbackWait();
  if (wait) tl.dataset.wait = S.t < wait[0] ? 'before' : S.t < wait[1] ? 'in' : 'after';
  else delete tl.dataset.wait;
  const i = phaseAt(S.t, steps);
  tl.style.setProperty('--timeline-progress', (S.t / total()) * 100 + '%');
  const phase = isParkingEvent(S.event) && S.t >= total() ? 'Parked' : steps[i][0];
  const range = $('tl-range'); range.max = Math.round(total() * 100); range.value = Math.round(S.t * 100); range.setAttribute('aria-valuetext', S.t.toFixed(1) + ' seconds, ' + phase);
  $('tl-time').textContent = S.t.toFixed(1) + ' s';
  const ended = !S.playing && S.t >= total(), play = $('tl-play'), label = S.playing ? 'Pause' : ended ? 'Replay' : 'Play';
  if (play.dataset.state !== label) { play.innerHTML = S.playing ? ICON.pause : ended ? ICON.replay : ICON.play; play.setAttribute('aria-label', label); play.dataset.tip = label; play.dataset.state = label; }
  const guideKey = ended ? 'end' : i;
  if (guideKey !== lastGuide) { lastGuide = guideKey; renderGuide(); }
}
// A stop-and-wait event marks the stretch where the vehicle stands still (dotted track)
// and the moment it is released (ring). The ring fills once the playhead passes it.
function renderWait(tl) {
  const track = tl.querySelector('.tl-track'), range = $('tl-range');
  track.querySelectorAll('.tl-wait, .tl-release').forEach((el) => el.remove());
  const wait = playbackWait();
  if (!wait) return;
  const [from, to] = wait.map((s) => Math.min(s, total()) / total() * 100);
  track.insertBefore(h(`<span class="tl-wait" aria-hidden="true" style="left:${from}%;width:${to - from}%"></span>`), range);
  if (Number.isFinite(wait[1])) track.insertBefore(h(`<span class="tl-release" aria-hidden="true" style="left:${to}%"></span>`), range);
}
function tick() {
  if ((S.playing || isParkingEvent(S.event)) && isTimeline()) {
    const state = preview.bridge()?.get({audit: false});
    // Ignore frames from the previous event while a switch is still settling.
    const playback = state?.event ?? state?.roadworks;
    if (playback?.event === S.event) {
      if (S.event === 'roadworks') S.roadRun = playback;
      S.playing = state.requestedPlaying;
      S.t = Math.max(0, playback.time - (S.roadRun?.eventStart ?? 0));
      if (!S.playing && playback.time >= playback.duration) S.t = total();
      updateTimeline(state);
    }
  } else if (isParkingScene(S.scene) && !parkedView()) {
    const state = preview.bridge()?.get({audit: false});
    if (state?.parking) renderParkingStatus(state);
  }
  requestAnimationFrame(tick);
}

/* ---------- Scene nav, assist, theme ---------- */
function selectScene(scene, animate = false) {
  if (scene !== S.scene && (isParkingScene(scene) || isParkingScene(S.scene))) {
    exitInProgress = false;
    autoParkedShown = false;
    resumeAfterScrub = null;
    S.assist = false;
    canViewParked = false;
    restoreParkedEntry = false;
    if (parkedView() || parkedPosition) void hideParked();
    renderParkingStatus(null);
  }
  S.scene = scene;
  const rows = [...document.querySelectorAll('#scene-nav .scene-row')];
  const row = rows.find((r) => r.dataset.scene === scene);
  rows.forEach((r) => r === row ? r.setAttribute('aria-current', 'page') : r.removeAttribute('aria-current'));
  placeSceneIndicator(animate);
  const label = row.getAttribute('aria-label') || row.textContent.trim();
  $('scene-group').textContent = 'Scene';
  $('mobile-scene').textContent = label;
  $('mobile-scene').setAttribute('aria-label', `Scene: ${label}`);
  const lanes = document.querySelector('.segment[data-param=lanes]');
  lanes.closest('.property').hidden = scene !== 'road';
}
function replaceSceneUrl(scene) {
  const url = new URL(location.href);
  url.searchParams.set('scene', scene);
  url.searchParams.delete('type');
  history.replaceState(history.state, '', url);
}
// Each scene keeps its own camera; the event scene also keeps its event, frame and play state.
const sceneMemory = {};
function changeScene(scene, animate) {
  if (scene === S.scene) return;
  resumeAfterScrub = null;
  closeMenu();
  sceneMemory[S.scene] = {camera: S.camera, eventCamera: S.eventCamera, ...(active() && {event: S.event, t: Math.max(0, S.t - (S.roadRun?.handoff ?? 0)), playing: S.playing, cutInSeed: S.cutInSeed})};
  selectScene(scene, animate);
  replaceSceneUrl(scene);
  Object.assign(S, {event: 'none', playing: false, t: 0, liveRoad: false, roadRun: null});
  const saved = sceneMemory[scene];
  if (saved?.event) Object.assign(S, {event: saved.event, t: saved.t, playing: saved.playing, cutInSeed: saved.cutInSeed});
  S.camera = saved?.camera ?? S.camera;
  setParkedUrl();
  S.eventCamera = saved?.eventCamera ?? (!isParkingScene(scene) && S.camera === 'high' ? 'high' : 'auto');
  renderAll();
  // The inspector's content changes with the scene; let it settle in rather than snap.
  const sc = $('inspector-scroll'); sc.classList.remove('scene-in'); void sc.offsetWidth; sc.classList.add('scene-in');
}
$('scene-nav').addEventListener('click', (e) => {
  const row = e.target.closest('.scene-row');
  if (row) changeScene(row.dataset.scene, e.detail > 0);
});
$('mobile-scene').addEventListener('click', (e) => {
  const trigger = e.currentTarget;
  if (openMenu?.trigger === trigger) return closeMenu(true);
  const menu = h('<div class="shell-vehicle-menu shell-scene-menu" id="mobile-scene-menu" role="menu" aria-label="Scenes"></div>');
  let group;
  for (const row of $('scene-nav').querySelectorAll('.nav-title, .scene-row')) {
    if (row.classList.contains('nav-title')) {
      group = h('<div role="group"><div class="shell-menu-heading" aria-hidden="true"></div></div>');
      group.firstElementChild.textContent = row.textContent;
      group.setAttribute('aria-label', row.textContent.trim());
      menu.append(group);
      continue;
    }
    const option = h(`<button type="button" role="menuitemradio" tabindex="-1" aria-checked="${row.dataset.scene === S.scene}"></button>`);
    option.textContent = row.getAttribute('aria-label') || row.textContent.trim();
    option.addEventListener('click', () => { closeMenu(true); changeScene(row.dataset.scene); });
    group.append(option);
  }
  menu.addEventListener('keydown', (ev) => { if (ev.key === 'Tab') closeMenu(true); });
  showMenu(trigger, menu, {width: Math.min(260, innerWidth - 32)});
  const top = parseFloat(menu.style.top) || trigger.getBoundingClientRect().bottom + 4;
  menu.style.maxHeight = Math.max(120, innerHeight - top - 16) + 'px';
});
function setSceneAssist(value) {
  S.assist = value;
  const button = $('scene-transport');
  button.setAttribute('aria-checked', String(value));
  button.dataset.tip = (value ? 'Turn off' : 'Turn on') + ' driving assist';
  if (isParkingScene(S.scene)) refreshParkedAvailability(preview.bridge()?.get({audit: false}));
}

let transportPending = false;
async function toggleSceneAssist() {
  if (transportPending || parkedCameraPending) return;
  const scene = S.scene, assist = !S.assist;
  const parkingScene = isParkingScene(scene);
  const depart = assist && parkingScene && !!preview.bridge()?.get({audit:false})?.parking?.complete;
  if (isTimeline() && !depart) return;
  transportPending = true;
  setSceneAssist(assist);
  if (parkingScene) renderInteraction(false, false);
  try {
    if (depart) {
      S.camera = 'low';
      if (active()) S.eventCamera = 'low';
    }
    if ((parkedView() || parkedPosition) && !await hideParked(true, depart ? 'low' : undefined)) return;
    if (scene !== S.scene) return;
    await preview.apply(async bridge => {
      try {
        if (assist && parkingScene) {
          if (!depart) void prepareParkedVehicle().catch(() => {});
          await bridge.parkingPlay({depart});
        }
        else await setAssistDemo(bridge, assist);
        if (scene !== S.scene) return;
        const current = bridge.get({audit:false});
        if (depart && current.parking?.mode === 'out') {
          exitInProgress = true;
          if (active()) {
            Object.assign(S, {event: 'none', playing: false, t: 0, parkingRun: null});
            renderAll();
          } else renderCamera();
        }
        if (assist && parkingScene && !current.requestedPlaying) setSceneAssist(false);
      } catch (error) {
        if (scene === S.scene) setSceneAssist(!assist);
        throw error;
      }
    });
  } finally {
    transportPending = false;
    if (isParkingScene(S.scene)) renderInteraction(false, false);
  }
}
$('scene-transport').addEventListener('click', toggleSceneAssist);
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== document.querySelector('.pro-scene-preview')?.contentWindow ||
      event.data?.type !== 'ui-draft-status' || !isParkingScene(S.scene) || event.data.value?.scene !== S.scene) return;
  const bridge = preview.bridge();
  const current = bridge?.get({audit: false});
  if (!current?.parking) return;
  const {parking, requestedPlaying, event: run} = current;
  if (!parking.complete) autoParkedShown = false;
  const exiting = parking.mode === 'out';
  if (exitInProgress !== exiting) {
    exitInProgress = exiting;
    renderInteraction(false, false);
  }
  if (!transportPending && !requestedPlaying) {
    if (S.assist && parking.exited) setSceneAssist(false);
    const matchingEvent = active() && run?.event === S.event && run.time >= run.duration;
    if ((matchingEvent || !active() && !run && S.assist) && parking.completedInPlayback && parking.replayReady && !autoParkedShown && !parkedView()) {
      const pose = bridge.parkingComposition();
      if (pose) {
        if (matchingEvent) {
          S.playing = false;
          S.t = run.duration;
          updateTimeline(current);
        }
        setSceneAssist(false);
        showParked(pose);
      }
    }
  }
  refreshParkedAvailability(current);
  renderParkingStatus(current);
});
const themeButton = $('theme');
const renderThemeLabel = () => themeButton.setAttribute('aria-label', `Switch to ${themeName() === 'dark' ? 'light' : 'dark'} theme`);
renderThemeLabel();
let requestedTheme = themeName(), themeTransition, themeRequest = 0;
themeButton.addEventListener('click', async () => {
  const root = document.documentElement;
  const target = requestedTheme === 'dark' ? 'light' : 'dark';
  const request = ++themeRequest;
  const animate = Boolean(document.startViewTransition) && !reducedMotion();
  requestedTheme = target;
  try { localStorage.setItem('sr-ui-draft-theme', target); } catch {}
  let preparedBridge, preparedParked, parkedThemeLayer, presentedParked = false;
  const prepareParked = () => {
    if (parkedView() && parkedPosition === 1) preparedParked = paintParkedView(target, true);
    if (!preparedParked || !animate) return;
    const source = parkedRig.canvas;
    parkedThemeLayer = document.createElement('canvas');
    parkedThemeLayer.className = 'parked-view';
    parkedThemeLayer.setAttribute('aria-hidden', 'true');
    parkedThemeLayer.style.pointerEvents = 'none';
    parkedThemeLayer.width = source.width;
    parkedThemeLayer.height = source.height;
    parkedThemeLayer.getContext('2d', {alpha: false}).drawImage(source, 0, 0);
  };
  const applyShell = () => {
    if (request !== themeRequest) return;
    preparedBridge?.startThemeBlend?.();
    if (preparedParked && preparedParked === parkedFrame && parkedView() && parkedPosition === 1 && parkedRigTheme === target) {
      if (parkedThemeLayer) startParkedThemeBlend(parkedThemeLayer, preparedParked);
      else {
        stopParkedThemeBlend();
        compositeParked(null, parkedRig.canvas, 1);
      }
      presentedParked = true;
    }
    root.dataset.theme = target;
    renderThemeLabel();
  };
  const refreshParked = () => {
    if (request !== themeRequest) return;
    if (parkedView()) setParkedUrl();
    if (!presentedParked) paintParkedView();
    else if (!animate && parkedView()) rememberParkedFrame(parkedFrame.model);
  };
  themeTransition?.skipTransition();
  const sceneTheme = preview.apply(bridge => {
    if (request !== themeRequest) return;
    preparedBridge = bridge;
    return bridge.theme(target, {animate, deferBlend: animate});
  }, {acrossScenes: true});
  if (!animate) {
    prepareParked();
    applyShell();
    refreshParked();
    return;
  }
  // Prepare the live scene while it keeps moving. Start its color clock when
  // the shell changes, without waiting for WebGL in the transition callback.
  await sceneTheme;
  if (request !== themeRequest) return;
  prepareParked();
  const b = themeButton.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
  root.style.setProperty('--theme-reveal-x', x + 'px'); root.style.setProperty('--theme-reveal-y', y + 'px');
  root.style.setProperty('--theme-reveal-radius', Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 180 + 'px');
  root.classList.add('theme-changing', 'theme-live-scene');
  const transition = document.startViewTransition(applyShell);
  themeTransition = transition;
  // Cancelling an older reveal rejects ready even though its update may finish.
  void transition.ready.catch(() => {});
  void transition.updateCallbackDone.then(() => {
    if (themeTransition === transition) refreshParked();
  });
  void transition.finished.catch(() => {}).then(() => {
    if (themeTransition !== transition) return;
    themeTransition = null;
    root.classList.remove('theme-changing', 'theme-live-scene');
  });
});


function placeSceneIndicator(animate) {
  const nav = $('scene-nav'), row = nav.querySelector('.scene-row[aria-current=page]');
  if (!row?.offsetWidth) return;
  glideIndicator(nav, row.offsetTop, !animate, row.offsetHeight, row.offsetLeft, row.offsetWidth);
}

/* ---------- Layout ---------- */
const stackedInspector = matchMedia('(max-width:959px)');
const compactStageQuery = matchMedia('(max-width:639px), (max-width:959px) and (orientation:portrait)');
const shortLandscapeQuery = matchMedia('(min-width:640px) and (max-width:959px) and (max-height:500px), (min-width:480px) and (max-width:639px) and (max-height:400px)');
const isCompactPortraitStage = () => compactStageQuery.matches && !shortLandscapeQuery.matches && innerHeight > 400;
function layout() {
  const stage = $('stage'), art = $('artboard'); if (!stage || !art) return;
  const workspace = stage.parentElement, footer = $('playback-footer'), playback = $('canvas-playback');
  const ratio = 16 / 9;
  // Measure the compact icon+label content width (even when the mobile button spans 100%)
  // so the wheel and label start centred and glide cleanly to the bar's edges on expansion.
  const transport = $('scene-transport');
  const labelW = playback.querySelector('.playback-label-measure').offsetWidth;
  const wheelW = playback.querySelector('.playback-wheel-space')?.offsetWidth || 20;
  const ts = getComputedStyle(transport);
  const compactW = isCompactPortraitStage()
    ? Math.round(wheelW + labelW + (parseFloat(ts.columnGap || ts.gap) || 8) + (parseFloat(ts.paddingLeft) || 16) + (parseFloat(ts.paddingRight) || 16))
    : transport.offsetWidth;
  playback.style.setProperty('--playback-compact', compactW + 'px');
  playback.style.setProperty('--playback-label-w', labelW + 'px');
  if (isCompactPortraitStage()) {
    const stageWidth = Math.max(1, stage.clientWidth);
    art.style.width = stageWidth + 'px';
    const below = footer.offsetHeight;
    const maxStageHeight = Math.round(innerHeight * 0.48);
    const w = Math.max(1, Math.floor(Math.min(stageWidth, Math.max(1, maxStageHeight - below) * ratio)));
    const hgt = Math.round(w / ratio);
    workspace.dataset.mobileStage = 'true';
    workspace.style.setProperty('--mobile-stage-h', (hgt + below) + 'px');
    Object.assign(art.style, { width: w + 'px', height: hgt + 'px', left: Math.round((stageWidth - w) / 2) + 'px', top: '0px' });
  } else {
    delete workspace.dataset.mobileStage;
    workspace.style.removeProperty('--mobile-stage-h');
    const r = stage.getBoundingClientRect();
    const below = footer.offsetHeight, padX = r.width < 480 ? 12 : 40, padY = r.height < 360 ? 12 : 40;
    const w = Math.max(1, Math.floor(Math.min(r.width - padX * 2, (r.height - padY * 2 - below) * ratio)));
    const hgt = Math.round(w / ratio);
    Object.assign(art.style, { width: w + 'px', height: hgt + 'px', left: Math.round((r.width - w) / 2) + 'px', top: Math.round((r.height - hgt - below) / 2) + 'px' });
  }
  updateTimeline(); placeSceneIndicator(false);
}

let wheelDeformation;
function renderPlayback(animate) {
  const playingEvent = isTimeline(), playback = $('canvas-playback'), assist = $('scene-transport'), timeline = $('event-timeline'), guide = $('tl-guide');
  playback.dataset.motion = animate ? 'live' : 'instant';
  const mode = playingEvent ? 'timeline' : 'assist';
  const modeChanged = playback.dataset.mode !== mode;
  playback.dataset.mode = mode;
  // The footer always reserves the guide line, so canvas, playback bar, and settings
  // stay anchored with zero vertical shift when toggling an interaction on desktop or mobile.
  $('playback-footer').dataset.reserveGuide = 'true';
  // Read-only while an event plays, but still hoverable so its tooltip explains the state.
  assist.disabled = false;
  assist.setAttribute('aria-disabled', String(playingEvent));
  assist.setAttribute('aria-hidden', String(playingEvent));
  const wheel = $('playback-wheel');
  const canExitFromTimeline = playingEvent && isParkingEvent(S.event) && canViewParked;
  wheel.setAttribute('aria-hidden', String(!playingEvent));
  wheel.setAttribute('role', canExitFromTimeline ? 'button' : 'img');
  wheel.setAttribute('aria-label', canExitFromTimeline ? 'Driving assist' : 'Driving assist on');
  wheel.tabIndex = canExitFromTimeline ? 0 : -1;
  if (playingEvent) wheel.dataset.tip = canExitFromTimeline ? 'Exit parking space' : 'Driving assist stays on during the event'; else delete wheel.dataset.tip;
  assist.tabIndex = playingEvent ? -1 : 0;
  assist.setAttribute('role', playingEvent ? 'img' : 'switch');
  assist.setAttribute('aria-label', playingEvent ? 'Driving assist on' : 'Driving assist');
  if (playingEvent) assist.removeAttribute('aria-checked');
  else assist.setAttribute('aria-checked', S.assist);
  assist.dataset.tip = playingEvent ? 'Driving assist stays on during the event' : (S.assist ? 'Turn off' : 'Turn on') + ' driving assist';
  timeline.inert = !playingEvent;
  timeline.setAttribute('aria-hidden', !playingEvent);
  guide.setAttribute('aria-hidden', !playingEvent);
  if (!animate) wheelDeformation?.cancel();
  if (animate && modeChanged && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const travel = playback.getAnimations({subtree: true}).find(animation =>
      animation.transitionProperty === 'transform' && animation.effect.target === wheel.parentElement);
    const style = getComputedStyle(wheel);
    const from = style.scale;
    const easing = style.getPropertyValue('--ds-motion-ease');
    wheelDeformation?.cancel();
    if (travel) {
      const {duration, delay} = travel.effect.getTiming();
      wheelDeformation = wheel.animate([
        {scale: from, easing},
        {scale: '1.06 .97', offset: .32, easing},
        {scale: '1'}
      ], {duration, delay, fill: 'backwards'});
    }
  }
}

let playbackReady = false;
function renderAll({animatePlayback = true, animateDisclosure = animatePlayback, animateControls = false} = {}) {
  renderInteraction(playbackReady && animateDisclosure, animateControls); renderCamera(); renderRampType(); renderLayers(animateControls); renderGuide(); lastGuide = -1; renderExport();
  renderPlayback(playbackReady && animatePlayback);
  layout(); updateTimeline(); layoutAllSegments();
  syncScene();
  playbackReady = true;
}

const inspectorScroll = $('inspector-scroll');
const updateInspectorOverflow = () => {
  const {scrollTop, clientHeight, scrollHeight} = inspectorScroll;
  inspectorScroll.classList.toggle('has-above', scrollTop > 2);
  inspectorScroll.classList.toggle('has-more', scrollTop + clientHeight < scrollHeight - 2);
};
const placeExport = () => {
  const exportSection = $('export-section'), inspector = $('inspector');
  const parent = stackedInspector.matches ? inspectorScroll : inspector;
  if (parent && exportSection && exportSection.parentElement !== parent) {
    parent.append(exportSection);
    inspectorResize.observe(exportSection);
    updateInspectorOverflow();
  }
};
inspectorScroll.addEventListener('scroll', updateInspectorOverflow, {passive: true});
const inspectorResize = new ResizeObserver(updateInspectorOverflow);
inspectorResize.observe(inspectorScroll);
for (const group of inspectorScroll.children) inspectorResize.observe(group);
stackedInspector.addEventListener('change', () => { placeExport(); layout(); layoutAllSegments(); updateInspectorOverflow(); });
compactStageQuery.addEventListener('change', () => { renderPlayback(false); layout(); layoutAllSegments(); updateInspectorOverflow(); });
shortLandscapeQuery.addEventListener('change', () => { renderPlayback(false); layout(); layoutAllSegments(); updateInspectorOverflow(); });
placeExport();

buildTimeline(); layout();
const entry = new URL(location.href);
const initialEvent = entry.searchParams.get('interaction');
const initialScene = entry.searchParams.get('scene');
const oldScene = initialEvent === 'roadworks' ? 'elevated' : initialEvent === JUNCTION_LEFT_TURN ? 'junction'
  : isParkingEvent(initialEvent) ? 'parking' : 'road';
const scene = ['road', 'elevated', 'ramp', 'junction', 'parking', 'outdoor'].includes(initialScene) ? initialScene : oldScene;
if (scene === 'ramp' && entry.searchParams.get('type') === 'merge') S.rampLayout = '07';
selectScene(scene);
restoreParkedEntry = isParkingScene(scene) && !initialEvent && entry.searchParams.get('view') === 'parked';
if (restoreParkedEntry) {
  S.parkedCamera = true;
  parkedClip.dataset.parkedEntry = '';
  const savedModel = history.state?.parkedPreview?.model;
  const option = vehicleOptions.find(item => item.dataset.vehicle === savedModel);
  if (option) selectVehicleOption(option);
  $('theme').setAttribute('aria-label', 'Switch to ' + (themeName() === 'dark' ? 'light' : 'dark') + ' theme');
  void prepareParkedVehicle().catch(() => {});
}
if (Object.hasOwn(EVENTS, initialEvent)) {
  entry.searchParams.delete('interaction');
  entry.searchParams.set('scene', scene);
  history.replaceState(history.state, '', entry);
}
for (const key of ['plan','checkout','session_id']) entry.searchParams.delete(key);
history.replaceState(history.state, '', entry);
renderAll();
delete document.documentElement.dataset.parkedEntry;
requestAnimationFrame(tick);
document.fonts?.ready?.then(() => { layout(); layoutAllSegments(); });
})();
