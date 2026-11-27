import {installContextRecovery} from '../context-recovery.js';
import {isParkingEvent} from '../parking-event-types.js';
import {createArtboard} from '../artboards.js?v=scene-options-20261112';
import {waitForEngine} from '../engine-ready.js';
import {revealScene} from '../scene-reveal.js';
import {JUNCTION_LEFT_TURN} from '../junction-left-turn.js';

export function createScenePreview({clip, engineRevision, proEngineRevision, onReady, onError, onRecover}) {
  window.__draftVehicleAssets = new Map();
  let cover = clip.querySelector?.('#frame-cover');
  if (!cover) {
    cover = document.createElement('canvas');
    cover.id = 'frame-cover';
    cover.hidden = true;
    cover.setAttribute('aria-hidden', 'true');
    clip.append(cover);
  }
  let frame, engine, key, keyOnCanvas, sceneOnCanvas, layoutOnCanvas, lanesOnCanvas, eventOnCanvas, request = 0, ready = false, stopped = false, reveal;
  let sceneTask = Promise.resolve(), selectedModel, coverEntryBottom, latest;
  const recovery = installContextRecovery({host: window, frame: () => frame,
    rebuild() {
      ++request; reveal?.abort(); ready = false;
      frame?.remove(); frame = engine = key = keyOnCanvas = sceneOnCanvas = layoutOnCanvas = lanesOnCanvas = eventOnCanvas = null;
      sceneTask = Promise.resolve();
      if (onRecover) onRecover();
      else if (latest) show(...latest);
    },
    onFailure: () => stop(Object.assign(Error('The 3D view stopped. Please reload.'), {sceneUnrecoverable: true}))
  });
  function stop(error) {
    stopped = true;
    ready = false;
    ++request;
    reveal?.abort();
    recovery.dispose();
    frame?.remove();
    frame = engine = null;
    cover.hidden = true;
    onError(error);
  }
  const resize = () => engine?.resize(clip.clientWidth);
  let resizeFrame;
  function queueResize() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      resize();
    });
  }
  new ResizeObserver(queueResize).observe(clip);
  // Pinch zoom scales the visual viewport without changing the clip's layout width.
  window.visualViewport?.addEventListener('resize', queueResize);

  async function mount(scene, event, board, theme, eventParams) {
    const {params, seed} = board;
    window.__draftStartupProject = {active: scene, boards: {[scene]: board}};
    const query = new URLSearchParams({
      'neutral-parking': '20261118-parking-handoff',
      'scene-preview': '1', 'traffic-palette': 'amber-red-20261112', 'traffic-feedback': 'cut-in-divider-20261112', 'camera-motion': 'roadworks-context-tail15-20261112', 'parking-interactions': '20261113-parking-arrival-camera', 'sky-gradient': '20261112', 'adaptive-roadworks-traffic': '1', review: 'ui-draft', quality: 'sr50', paused: '1',
      scene: params.layout, mode: theme, lanes: params.lanes,
      view: params.camera, model: params.model, weather: params.weather, seed, vehicle: '1',
      path: Number(params.path), roadworks: '0',
      ...(event && {interaction: event}),
      ...(eventParams?.cutInSeed != null && {'cut-in-seed': eventParams.cutInSeed})
    });
    for (const layer of ['traffic', 'buildings', 'trees', 'waterfront']) {
      query.set(layer, Number(params[layer]));
    }
    // A fresh prototype must not mount a cached engine shell from an older build.
    const revision = proEngineRevision || engineRevision;
    if (revision) query.set('engine-v', revision);
    const targetUrl = new URL('../pro-engine.html?' + query, import.meta.url);
    const early = clip.querySelector?.('iframe.pro-scene-preview[data-early-mount]');
    if (early && early.src === targetUrl.href) {
      delete early.dataset.earlyMount;
      frame = early;
    } else {
      early?.remove();
      frame = document.createElement('iframe');
      frame.title = '3D scene preview';
      frame.className = 'pro-scene-preview';
      frame.tabIndex = -1;
      frame.src = targetUrl;
      clip.prepend(frame);
    }
    const mountedFrame = frame;
    try {
      await waitForEngine({
        host: window, frame: mountedFrame, timeout: 120000,
        ready: () => {
          const api = mountedFrame.contentWindow?.layoutEngine;
          const state = api?.draft?.get({audit: false});
          return api?.get().ready && state?.ready && state.startup?.ready;
        }
      });
      if (frame !== mountedFrame) throw new DOMException('Preview replaced', 'AbortError');
      engine = mountedFrame.contentWindow.layoutEngine.draft;
      resize();
      engine.completeStartup();
    } catch (error) {
      mountedFrame.remove();
      throw error;
    }
  }

  function show(scene, event, {camera, eventCamera = 'auto', lanes, rampLayout, model, weather, layers, theme, assist, params, t, playing, liveRoad = false}) {
    if (stopped) return;
    latest = [scene, event, {camera, eventCamera, lanes, rampLayout, model, weather, layers, theme, assist, params, t, playing, liveRoad}];
    const nextKey = scene + ':' + event + (scene === 'ramp' ? ':' + rampLayout : scene === 'road' ? ':' + lanes : '');
    if (key === nextKey) return;
    key = nextKey;
    const id = ++request;
    reveal?.abort();
    const matchesCanvas = () => sceneOnCanvas === scene &&
      (scene === 'ramp' ? rampLayout === layoutOnCanvas : scene !== 'road' || lanes === lanesOnCanvas);
    function holdFrame() {
      const source = engine.canvas;
      cover.width = source.width;
      cover.height = source.height;
      cover.getContext('2d').drawImage(source, 0, 0);
      coverEntryBottom = engine.parkingEntryBottom();
      cover.hidden = false;
    }
    const morphRoad = () => sceneOnCanvas === 'road' && scene === 'road';
    if (sceneOnCanvas && cover.hidden && !matchesCanvas() && !morphRoad()) holdFrame();
    ready = false;
    const board = createArtboard(scene, {
      ...(scene === 'ramp' && {layout: rampLayout}), camera: event ? 'low' : camera,
      lanes, model, weather, ...layers, traffic: scene === 'parking' || layers.traffic, path: !!event || assist
    });
    sceneTask = sceneTask.then(async () => {
      if (id !== request) return;
      const previousFrame = frame;
      const laneEdit = morphRoad() && lanes !== lanesOnCanvas;
      const eventApplied = !!engine && (matchesCanvas() || laneEdit);
      let junctionRestored = false;
      if (selectedModel) board.params.model = selectedModel;
      if (eventApplied) {
        if (isParkingEvent(event)) await engine.prepareParkingAssets();
        else if (board.params.traffic || event && event !== JUNCTION_LEFT_TURN) await engine.prepareEventTraffic();
        if (id !== request) return;
        const incompatible = scene === 'ramp' && rampLayout === '07' && !!event && event !== eventOnCanvas;
        if (incompatible) holdFrame();
        const unchangedJunctionTurn = scene === 'junction' && event === JUNCTION_LEFT_TURN && eventOnCanvas === event;
        if (!unchangedJunctionTurn && (!laneEdit || event !== eventOnCanvas)) {
          engine.switchInteraction(event, {
            params, camera: event ? eventCamera : camera, time: t, overlay: true, assist, playing,
            trafficEnabled: board.params.traffic, animateCamera: eventOnCanvas === event, liveRoad
          });
        }
        if (laneEdit) await engine.param('lanes', Number(lanes));
      } else if (engine) {
        if (cover.hidden) holdFrame();
        if (isParkingEvent(event)) {
          await engine.prepareParkingAssets();
          if (id !== request) return;
        }
        const entryBottom = ['parking', 'outdoor'].includes(scene) ? coverEntryBottom : undefined;
        junctionRestored = await engine.scene(scene, board.seed, board.params, entryBottom, {event, params});
      } else {
        await mount(scene, event, board, theme, params);
      }
      // A newer intent can arrive while the existing engine commits a scene.
      // Record what is physically on its canvas before honoring that intent.
      if (previousFrame && previousFrame !== frame) return;
      keyOnCanvas = nextKey;
      sceneOnCanvas = scene;
      layoutOnCanvas = rampLayout;
      lanesOnCanvas = lanes;
      eventOnCanvas = event;
      if (id !== request) return;
      resize();
      ready = true;
      onReady(engine, event, {eventApplied, junctionRestored});
      if (cover.hidden) return;
      reveal = new AbortController();
      void revealScene({
        cover, commit() {}, signal: reveal.signal,
        live: !['parking', 'outdoor'].includes(scene),
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches
      });
    }).catch((error) => {
      if (id !== request || recovery.pending) return;
      if (error.sceneUnrecoverable) { stop(error); return; }
      const state = engine?.get({audit: false});
      if (sceneOnCanvas && state?.scene === sceneOnCanvas) {
        key = keyOnCanvas;
        ready = true;
        cover.hidden = true;
        onError(error, {state, event: eventOnCanvas, lanes: lanesOnCanvas, rampLayout: layoutOnCanvas});
      } else {
        key = null;
        onError(error);
      }
    });
  }

  function apply(operation, {sameScene = false, acrossScenes = false} = {}) {
    const id = request, scene = sceneOnCanvas;
    // A pending layer edit must finish before the next scene applies its own layer rules.
    sceneTask = sceneTask.then(async () => {
      if (!engine || (!acrossScenes && (sameScene ? scene !== sceneOnCanvas : !ready || id !== request))) return;
      await operation(engine);
    }).catch(error => {
      if (id === request) onError(error);
    });
    return sceneTask;
  }

  async function selectVehicle(model, prepareVisible) {
    const target = frame, bridge = engine;
    if (!bridge) throw Error('The scene is still loading. Please try again.');
    // Keep scene inputs live during transfer. Serialize only the GPU preparation and commit.
    const release = await target.contentWindow.layoutEngine.loadVehicleChoice(model);
    try {
      await prepareVisible?.();
      const change = sceneTask.then(async () => {
        if (frame !== target || engine !== bridge) throw Error('The 3D view changed. Please try again.');
        await bridge.param('model', model);
        selectedModel = model;
      });
      sceneTask = change.catch(() => {});
      await change;
    } finally {
      release();
    }
  }

  function prefetchVehicles(ids) {
    if (ready) void frame?.contentWindow?.layoutEngine?.prefetchVehicles?.(ids)?.catch(() => {});
  }

  return {show, apply, selectVehicle, prefetchVehicles, hasMountedScene: scene => !!engine && sceneOnCanvas === scene, bridge: () => ready ? engine : null};
}
