import {DRIVING_EVENT_SECONDS} from './interaction-duration.js';
import {INTERACTION_CAMERA, interactionCameraLift} from './interaction-camera.js';
import * as THREE from 'three';
import {drivingHeading} from './driving-heading.js';
import {roadCruiseSpeed} from './junction-playback.js';
import {createFollowingTraffic, createInteractionTraffic, planFollowingFeedback} from './elevated-following.js';
import {planAdjacentCutIn, planLiveCutIn} from './adjacent-cut-in.js';
import {CUT_IN_TIMING} from './cut-in-timing.js';
import {LANE_CHANGE_TIMING} from './lane-change-timing.js';
import {continueTraffic, planRoadLaneChange} from './road-lane-change.js';
import {anchorVehicle} from '../engine/framing.js';
import {trafficPlan as cruiseTrafficPlan} from '../engine/traffic-vehicle.js';
import {
 coordinateWorkZone, planLiveWorkZone, planRoadworksTraffic, ROADWORKS_MERGE_DISTANCE, ROADWORKS_CONE_START as firstConeDistance,
 ROADWORKS_CONE_SPACING as coneSpacing, ROADWORKS_TAPER_INTERVALS as taperIntervals,
 ROADWORKS_CLEARED_DISTANCE as clearedDistance, ROADWORKS_CRUISE as cruise, roadworksCameraInRange, sampleRoadworksSpeed,
} from './roadworks-traffic.js';

export const ROADWORKS_SECONDS = DRIVING_EVENT_SECONDS;
export const DRIVING_EVENTS = ['roadworks', 'cutin', 'collision', 'aes', 'lanechange'];
const offsets = {near: -6, mid: 0, far: 12};
export const roadworksDuration = () => ROADWORKS_SECONDS;
export function roadworksOptions({obstacle, distance, side} = {}) {
 return {
  obstacle: ['barrier', 'vehicle'].includes(obstacle) ? obstacle : 'cones',
  distance: Object.hasOwn(offsets, distance) ? distance : 'mid',
  side: side === 'right' ? 'right' : 'left',
 };
}
const laneWidth = 3.7;
const up = new THREE.Vector3(0, 1, 0);
const laneChangeStart = 52;
const laneChangeEnd = laneChangeStart + ROADWORKS_MERGE_DISTANCE;
const indicatorStart = 1.3;
const cameraTiming = new Map();
const clamp = THREE.MathUtils.clamp;
const smooth = (value, from, to) => THREE.MathUtils.smootherstep(value, from, to);
const lerp = THREE.MathUtils.lerp;
export function sampleRoadworks(seconds, reducedMotion = false, offset = 0) {
 const time = clamp(seconds, 0, roadworksDuration(offset === offsets.far ? 'far' : 'mid'));
 const timeOffset = offset / cruise;
 const motion = sampleRoadworksSpeed(time, offset);
 const {distance} = motion;
 const laneX = s => -laneWidth * smooth(s, laneChangeStart + offset, laneChangeEnd + offset);
 const releaseDistance = Math.max(laneChangeEnd, clearedDistance) + offset;
 if (!cameraTiming.has(offset)) cameraTiming.set(offset, {
  riseAt: baseTimeWhen(ROADWORKS_SECONDS, offset, f => roadworksCameraInRange(f.distance, f.speed, offset)),
  returnAt: baseTimeAt(releaseDistance, ROADWORKS_SECONDS, offset),
 });
 const {riseAt, returnAt} = cameraTiming.get(offset);
 const indicatorTime = time - indicatorStart - timeOffset;
 const lift = reducedMotion ? 0 : interactionCameraLift(time, riseAt, returnAt);
 const x = laneX(distance);
 const plan = smooth(time, 1.9 + timeOffset, 2.8 + timeOffset);
 const lamp = indicatorTime >= 0 && distance < laneChangeEnd + offset && indicatorTime % .8 < .4 ? 1 : 0;
 return {
  ...motion, lift, lamp, cameraRiseAt: riseAt, cameraReturnAt: returnAt, obstacleZ: distance - firstConeDistance - offset,
  x, yaw: drivingHeading(laneX, distance),
  pathX: z => THREE.MathUtils.lerp(x, laneX(distance - z), plan),
 };
}

function baseTimeAt(distance, time, offset) {
 return baseTimeWhen(time, offset, frame => frame.distance >= distance);
}

function baseTimeWhen(time, offset, reached) {
 let low = 0, high = time;
 for (let i = 0; i < 32; i++) {
  const middle = (low + high) / 2;
  if (!reached(sampleRoadworksSpeed(middle, offset))) low = middle;
  else high = middle;
 }
 return high;
}

function blendRoutePreview(anchor, frame, weight) {
 const delta = frame.distance - anchor.distance;
 const path = frame.pathX;
 const priorCars = new Map(anchor.traffic.map(car => [car.id, car]));
 frame.lift = lerp(anchor.lift, frame.lift, weight);
 frame.pathX = z => lerp(anchor.pathX(z - delta), path(z), weight);
 frame.holdWeight = lerp(anchor.holdWeight ?? 0, frame.holdWeight ?? 0, weight);
 frame.traffic = frame.traffic.map(car => {
  const prior = priorCars.get(car.id);
  priorCars.delete(car.id);
  return {...car, corridorWeight: lerp(prior?.corridorWeight ?? Number(!!prior), 1, weight)};
 });
 for (const car of priorCars.values()) {
  frame.traffic.push({...car, z: car.z + delta, corridorWeight: (car.corridorWeight ?? 1) * (1 - weight)});
 }
 return frame;
}

const obstacleDepth = coneSpacing * taperIntervals + 8;

function roadworksAssembly(world, obstacle) {
 // Build the same cones and service truck used by Road, at deck height.
 const root = world.root;
 const zone = world.roadworkZone;
 const assembly = new THREE.Group();
 try {
  world.root = assembly;
  world.roadworks(3 * laneWidth, {
   additionalClosedWidth: laneWidth,
   coneSpacing,
   taperIntervals,
   truckZ: -10 - obstacleDepth,
   serviceTruck: obstacle === 'cones',
  });
  if (obstacle === 'barrier') {
   const z = -10 - obstacleDepth;
   for (const x of [-.18, 1.85, 3.88]) {
    world.box(1.94, .26, .68, x, .15, z, 'cone', .06);
    world.box(1.94, .64, .36, x, .56, z, 'cone', .06);
    world.box(1.66, .14, .025, x, .69, z + .19, 'white', .02);
   }
  }
 } finally {
  world.root = root;
  world.roadworkZone = zone;
 }
 assembly.name = 'elevated-roadworks-' + obstacle;
 root.add(assembly);
 return assembly;
}

function createWarningOutline(root) {
 const group = new THREE.Group();
 group.name = 'collision-warning';
 const material = new THREE.MeshBasicMaterial({color: 0xff352e, toneMapped: false, transparent: true, depthWrite: false});
 const bar = new THREE.PlaneGeometry(.82, .14);
 for (const x of [-1.28, 1.28]) for (const z of [-2.65, 2.65]) {
  const end = new THREE.Mesh(bar, material);
  end.rotation.x = -Math.PI / 2;
  end.position.set(x - Math.sign(x) * .4, 0, z);
  const side = new THREE.Mesh(bar, material);
  side.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
  side.position.set(x, 0, z - Math.sign(z) * .4);
  group.add(end, side);
 }
 root.add(group);
 return group;
}

const laneHighlightLength = 184;
const laneHighlightRear = 44;

function createTargetLane(root) {
 const material = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, toneMapped: false,
  uniforms: {opacity: {value: 0}, ink: {value: new THREE.Color('#4caeff')}},
  vertexShader: 'varying vec2 v;void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: `varying vec2 v;
   uniform float opacity;
   uniform vec3 ink;
   void main(){
    float distanceFade=1.-smoothstep(.57,1.,v.y);
    gl_FragColor=vec4(ink,opacity*distanceFade*.12);
    #include <colorspace_fragment>
   }`,
 });
 const mesh = new THREE.Mesh(new THREE.PlaneGeometry(laneWidth, laneHighlightLength), material);
 mesh.name = 'lane-change-lane';
 mesh.rotation.x = -Math.PI / 2;
 mesh.renderOrder = 1;
 root.add(mesh);
 return mesh;
}

function createLaneChangeTarget(root) {
 const material = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, toneMapped: false,
  uniforms: {
   opacity: {value: 0}, rimWeight: {value: 0}, selected: {value: 0},
   neutralInk: {value: new THREE.Color('#c3c9d0')},
  },
  vertexShader: 'varying vec2 v;void main(){v=uv.yx;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: `varying vec2 v;
   uniform float opacity, rimWeight, selected;
   uniform vec3 neutralInk;
   void main(){
    vec2 t=(v-.5)*vec2(4.9,2.8);
    vec2 q=abs(t)-(vec2(2.45,1.4)-vec2(.4));
    float d=length(max(q,0.))+min(max(q.x,q.y),0.)-.34;
    float aa=max(fwidth(d),.001);
    float fill=1.-smoothstep(-aa,aa,d);
    float edge=(1.-smoothstep(.02-aa,.02+aa,abs(d+.02)))*fill;
    float rimAlpha=rimWeight*(mix(.18,.28,selected)+.0175);
    gl_FragColor=vec4(neutralInk,opacity*(.12*fill+rimAlpha*edge));
    #include <colorspace_fragment>
   }`,
 });
 const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
 mesh.name = 'lane-change-target';
 mesh.rotation.x = -Math.PI / 2;
 mesh.renderOrder = 2;
 root.add(mesh);
 return mesh;
}

function blendRoadworksFrame(from, to, weight) {
 const frame = {...to};
 for (const key of ['x', 'yaw', 'distance', 'speed', 'obstacleZ', 'brakeStrength', 'holdZ', 'holdWeight']) {
  if (Number.isFinite(from[key]) && Number.isFinite(to[key])) frame[key] = lerp(from[key], to[key], weight);
 }
 frame.pathX = z => lerp(from.pathX(z), to.pathX(z), weight);
 frame.traffic = to.traffic.map(car => {
  const prior = from.traffic.find(old => old.id === car.id);
  return prior ? {
   ...car, x: lerp(prior.x, car.x, weight), z: lerp(prior.z, car.z, weight),
   yaw: lerp(prior.yaw, car.yaw, weight), speed: lerp(prior.speed, car.speed, weight),
  } : car;
 });
 return frame;
}

export function createElevatedRoadworks(world, drive, traffic, newTrafficRandom, {adaptiveTraffic = false} = {}) {
 let base, baseRoot, high, assembly, warning, vehicle, trafficPlan, trafficRandom, ambient, interactionFleet, adjacentPlan, cutInSeed;
 let laneChangePlan, targetSlot, targetLane, followingFeedback, followingTrafficEnabled;
 let event = 'roadworks', options = roadworksOptions(), overlay = true;
 let routes = [], roadRun;
 const rampAnchor = new THREE.Vector3();
 const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
 const ambientEnabled = () => world.draftTrafficEnabled && traffic.enabled;
 function planTraffic(initial, trafficEnabled = true) {
  const offset = offsets[options.distance];
  if (trafficEnabled) {
   trafficRandom ??= newTrafficRandom();
   trafficRandom.reset();
  }
  return planRoadworksTraffic(trafficRandom, {
   duration: roadworksDuration(options.distance), width: laneWidth, clearedDistance: clearedDistance + offset,
   offset, initial, trafficEnabled, adaptiveTraffic, extendUntilClear: true,
  });
 }
 function startRun(enabled = ambientEnabled()) {
  routes = [{time: -Infinity, enabled, plan: enabled ? planTraffic() : null}];
 }
 function sampleRoute(seconds, route) {
  const offset = offsets[options.distance];
  const frame = sampleRoadworks(seconds, reducedMotion.matches, offset);
  if (!route.plan) return {...frame, traffic: []};
  if (seconds === route.time) return {...route.anchor};
  const moving = route.plan.sample(seconds);
  const signalStart = moving.signalAt;
  const result = {
   ...frame, ...moving,
   // Like the live handoff, replay frames the work zone with one Auto lift.
   lift: reducedMotion.matches ? 0 : interactionCameraLift(seconds, moving.cameraRiseAt, moving.cameraReturnAt),
   lamp: moving.distance < moving.mergeEnd ? Number(seconds >= signalStart && (seconds - signalStart) % .8 < .4) : 0,
   obstacleZ: moving.distance - firstConeDistance - offset,
  };
  return seconds < route.time + .75
   ? blendRoutePreview(route.anchor, result, smooth(seconds, route.time, route.time + .75))
   : result;
 }
 return {
  configure(nextEvent, params) {
   const next = roadworksOptions(params);
   if (event !== nextEvent || options.distance !== next.distance) trafficPlan = null;
   if (event !== nextEvent) ambient = interactionFleet = followingFeedback = null;
   if (event !== nextEvent) laneChangePlan = null;
   if (event !== nextEvent || cutInSeed !== params?.cutInSeed) adjacentPlan = null;
   cutInSeed = params?.cutInSeed;
   if (event !== nextEvent || options.distance !== next.distance) routes = [];
   event = nextEvent;
   options = next;
  },
  setOverlay(value) { overlay = value; },
  get options() { return options; },
  resumeAt(time, {newRun = false} = {}) {
   if (roadRun) return;
   if (event !== 'roadworks') {
    if (newRun) interactionFleet = adjacentPlan = laneChangePlan = followingFeedback = null;
    return;
   }
   const enabled = ambientEnabled();
   if (newRun) trafficRandom = null;
   if (time === 0 || !routes.length) startRun(enabled);
   else if (routes.findLast(route => route.time <= time).enabled !== enabled) this.setTrafficAt(time, enabled);
  },
  setTrafficAt(time, enabled) {
   if (roadRun) {roadRun.setTraffic?.(time, enabled); return;}
   if (!routes.length) startRun(!enabled);
   // Seeking and editing an earlier point replaces the future of that run.
   routes = routes.filter(route => route.time < time);
   const previous = routes.at(-1);
   if (previous.enabled === enabled) return;
   const anchor = sampleRoute(time, previous);
   const offset = offsets[options.distance];
   const mergeDistance = laneChangeStart + offset;
   const merge = previous.plan ? anchor.merge : anchor.distance >= mergeDistance
    ? {distance: mergeDistance, time: baseTimeAt(mergeDistance, time, offset)} : null;
   const plan = planTraffic({...anchor, time, merge}, enabled);
   routes.push({time, enabled, anchor, plan});
  },
  get duration() { return roadRun?.duration ?? (event === 'roadworks' ? routes.at(-1)?.plan?.timing.endAt ?? ROADWORKS_SECONDS : adjacentPlan?.endAt ?? ROADWORKS_SECONDS); },
  get workZoneTiming() {
   if (event !== 'roadworks') return;
   const plan = roadRun?.workZoneTiming?.() ?? routes.at(-1)?.plan?.timing;
   const offset = offsets[options.distance];
   if (plan) return plan;
   const mergeAt = baseTimeAt(laneChangeStart + offset, ROADWORKS_SECONDS, offset);
   return {brakeAt: indicatorStart + offset / cruise, mergeAt,
    passAt: baseTimeAt(laneChangeEnd + offset, ROADWORKS_SECONDS, offset),
    clearAt: baseTimeAt(clearedDistance + offset, ROADWORKS_SECONDS, offset),
    waitAt: Infinity, endAt: ROADWORKS_SECONDS};
  },
  get eventStart() { return roadRun?.requestedAt ?? 0; },
  get eventHandoff() { return roadRun ? roadRun.start-roadRun.requestedAt : 0; },
  get cruisingRoad() { return roadRun?.event === null; },
  captureRoadCruise(at, driving) {
   const baseX = world.dividedRoad?.egoCenter ?? laneWidth / 2;
   const x = world.car.position.x;
   const z = world.car.position.z;
   const {positions, lanes} = traffic.audit();
   const fleet = positions.map(([x, , carZ], i) => {
    const {id, alpha, direction, speed, yaw} = lanes[i];
    return {id, x, z: carZ - z, speed, direction, yaw: yaw ?? (direction > 0 ? Math.PI : 0), opacity: alpha};
   });
   const speed = driving.speed ?? cruise;
   return {start: at, event: null, baseX, sample: time => {
    const elapsed = time - at;
    return {distance: driving.distance + speed * elapsed, speed, x: x - baseX, yaw: 0,
     pathX: () => x, lamp: 0, lift: 0, holdWeight: 0,
     traffic: fleet.map(car => ({...car, z: car.z + (speed + car.speed * car.direction) * elapsed}))};
   }};
  },
  captureRoadRun() {
   if (roadRun) return roadRun;
   const lane = laneChangePlan, cut = adjacentPlan;
   if (lane) {
    const sample = time => {
     const frame = lane(time, reducedMotion.matches);
     if (reducedMotion.matches) frame.lift = frame.targetBias = 0;
     return frame;
    };
    return {start: 0, event: 'lanechange', sample, baseX: base.carPosition.x};
   }
   if (cut) return {start: 0, event: 'cutin', baseX: base.carPosition.x, cutInTiming: cut(0).cutInTiming, sample: time => {
    const frame = cut(time);
    if (reducedMotion.matches) frame.lift = 0;
    return frame;
   }};
  },
  continueRoad(previous, at, {camera, outgoingCamera, view, trafficEnabled}) {
   // Replacing a request that has not started must not discard the committed maneuver.
   const pending = previous;
   while (previous.previous && at < previous.start) previous = previous.previous;
   if (previous !== pending && previous.event === event) {roadRun = previous; return;}
   const baseX = previous.baseX;
   const frameAtSwitch = previous.sample(at);
   const local = at - previous.start;
   const lane = frameAtSwitch.laneChange;
   const onRoad = world.state.id === '02';
   // Once a car starts moving across a lane, let it finish its physical move.
   // The successor can start from the settled lane instead of pulling the car sideways.
   let start = Math.max(at, previous.start);
   const finishLaneChange = previous.event === 'lanechange' && lane && event === 'cutin' &&
    local >= LANE_CHANGE_TIMING.signalAt && !lane.waiting;
   if (finishLaneChange) {
    const end = lane.waiting ? ROADWORKS_SECONDS : lane.settledAt + LANE_CHANGE_TIMING.slotFadeSeconds;
    start = Math.max(start, previous.start + end);
   } else if (previous.event === 'lanechange' && lane && local >= lane.steerAt && local < lane.settledAt) {
    start = previous.start + lane.settledAt;
   }
   const intruder = lane?.intruder;
   if (previous.event === 'lanechange' && intruder && local >= intruder.enter && local < intruder.end) {
    start = Math.max(start, previous.start + intruder.end);
   }
   const cut = previous.cutInTiming ?? CUT_IN_TIMING;
   if (previous.event === 'cutin' && local >= cut.merge && local < cut.inLane) {
    start = previous.start + cut.inLane;
   }
   if (previous.event === 'roadworks' && frameAtSwitch.merge && frameAtSwitch.distance < frameAtSwitch.mergeEnd &&
       Number.isFinite(frameAtSwitch.cameraReturnAt)) {
    start = Math.min(previous.duration,previous.start + frameAtSwitch.cameraReturnAt + INTERACTION_CAMERA.fall);
   }
   const merge = frameAtSwitch.rampMerge;
   if (merge && local < merge.settledAt) start = previous.start + merge.settledAt;
   if (merge && local >= merge.passAt && local < merge.passSettledAt) start = previous.start + merge.passSettledAt;
   const anchor = previous.sample(start);
   // Auto uses the live view as its resting pose. A committed maneuver keeps
   // its old camera through alignment before handing over to the next one.
   const cameraPose = start === at ? view
    : anchor.cameraPoseMode === outgoingCamera && (!onRoad || anchor.cameraPoseWeight > 0) ? anchor.cameraPose : null;
   const priorFrame = time => {
    const frame = previous.sample(time);
    return {...frame, cameraMode: frame.cameraMode ?? outgoingCamera,
     ...(!finishLaneChange && {targetSlot: undefined, laneHighlight: 0})};
   };
   const laneX = baseX + anchor.x;
   const outerLane = (world.state.laneCount / 2 - .5) * laneWidth;
   const side = laneX + laneWidth <= outerLane + .01 ? 1 : -1;
   if (!event) {
    const cruiseLeg = (time, distance, speed, fleet) => {
     const ego={x:laneX,z:0,speed,preferredSpeed:roadCruiseSpeed(world),direction:-1};
     return {time,distance,trafficAt:continueTraffic([...fleet,ego])};
    };
    const original = cruiseLeg(start, anchor.distance, anchor.speed, trafficEnabled ? anchor.traffic : []);
    let leg = original;
    // Finish any committed motion without retaining the cancelled event's cues.
    const clearFeedback = car => ({...car, trafficFeedback: undefined, cutInColor: undefined, cutInTint: 0,
     rearIndicator: null, constraining: false, corridorInfluence: 0});
    const setTraffic = (time, enabled) => {
     time = Math.max(time, start);
     const fleet = enabled ? cruiseTrafficPlan(world.state,laneX).map((car,index)=>({
      ...car,id:'cruise-'+index,z:car.egoLane?Math.min(car.z,-38):car.z,yaw:car.direction>0?Math.PI:0,
     })) : [];
     const from = sample(time);
     leg = cruiseLeg(time, from.distance, from.speed, fleet);
    };
    const sample = time => {
     if (time < start) {
      const frame = priorFrame(time);
      return {...frame, brakeStrength: 0, holdWeight: 0, visibleTraffic: undefined,
       traffic: trafficEnabled ? (frame.visibleTraffic ?? frame.traffic).map(clearFeedback) : []};
     }
     const elapsed = time - start;
     const ease = smooth(elapsed, 0, 1.8);
     const pace = time >= leg.time ? leg : original;
     const dt = time - pace.time;
     const cars=pace.trafficAt(dt,0);
     const ego=cars.pop();
     const speed=ego.speed, distance=pace.distance-ego.z;
     return {...anchor, distance, speed, laneChange: undefined, yaw: anchor.yaw * (1 - ease), lamp: 0,
      brakeStrength: 0, holdWeight: 0, visibleTraffic: undefined,
      pathX: z => lerp(anchor.pathX(z - (distance - anchor.distance)), laneX, ease),
      lift: 0, cameraPose, cameraPoseMode: camera,
      cameraPoseWeight: onRoad && camera === 'auto' ? 1 - ease : undefined,
      targetSlot: undefined, laneHighlight: 0,
      traffic: cars.map(car => ({
       ...clearFeedback(car), z:car.z-ego.z,
       opacity: 1, growth: lerp(car.growth ?? 1,1,ease),
      })),
     };
    };
    roadRun = {event, start, requestedAt:at, duration: Infinity, sample, baseX, previous, setTraffic};
    return;
   }
   const divided = world.state.id !== '02';
   const liveCut = event === 'cutin'
    ? planLiveCutIn(newTrafficRandom(cutInSeed), {egoX: laneX, outerLane: divided ? laneWidth : outerLane,
     innerLane: divided ? -laneWidth : laneWidth / 2, speed: anchor.speed, traffic: anchor.traffic,
     rampExit: world.state.id === '06'})
    : null;
   let next, setTraffic, workZoneTiming;
   const workZoneX = world.dividedRoad?.egoCenter ?? laneX;
   if (event === 'roadworks') {
    const routesBySide = new Map();
    const toggles = [];
    const random = newTrafficRandom();
    const routeForSide = () => {
     const direction = options.side === 'right' ? -1 : 1;
     const cached = routesBySide.get(options.side);
     if (cached) return cached;
     const carried=anchor.traffic.filter(car=>(car.opacity??1)>.02).map(car=>({
      id:car.id, direction:car.direction, speed:car.speed, station:-car.z,
      x:(car.x-workZoneX)*(car.direction>0?1:direction),
     }));
     const {offset}=planLiveWorkZone(carried,laneWidth,offsets[options.distance],ROADWORKS_SECONDS,anchor.speed);
     random.reset();
     const plan = (initial, enabled, liveFleet) => {
      random.reset();
      return planRoadworksTraffic(random, {duration:ROADWORKS_SECONDS, width:laneWidth, offset,
       clearedDistance:clearedDistance+offset, initial, liveFleet, trafficEnabled:enabled, adaptiveTraffic:true,extendUntilClear:true});
     };
     const initial={speed:anchor.speed,entryX:(laneX-workZoneX)*direction};
     const run=trafficEnabled&&carried.length?coordinateWorkZone(random,carried,{
      duration:ROADWORKS_SECONDS,width:laneWidth,offset,initial,clearedDistance:clearedDistance+offset,adaptiveTraffic:true,extendUntilClear:true,
     }):plan(initial,trafficEnabled);
     let trafficRoutes = [{time:0, enabled:trafficEnabled, run}];
     const timing = () => trafficRoutes.at(-1).run.timing;
     const routeAt = time => trafficRoutes.findLast(route => route.time <= time) ?? trafficRoutes[0];
     const toggle = (time, enabled) => {
      const local = clamp(time - start, 0, timing().endAt);
      const route = routeAt(local);
      if (route.enabled === enabled) return;
      const frame = route.run.sample(local);
      frame.lift = liftAt(local, route, frame);
      trafficRoutes = trafficRoutes.filter(entry => entry.time < local);
      trafficRoutes.push({time:local, enabled, run:plan({...frame,entryX:initial.entryX,time:local}, enabled), from:frame});
     };
     const liftAt = (time, route, frame) => {
      const lift = interactionCameraLift(time,frame.cameraRiseAt,frame.cameraReturnAt);
      return route.from ? lerp(route.from.lift,lift,smooth(time,route.time,route.time+.75)) : lift;
     };
     const sample = time => {
      const route = routeAt(time);
      const f = route.run.sample(time);
      f.lift = liftAt(time,route,f);
      if (route.from && time < route.time+.75) {
       const lift = f.lift, traffic = f.traffic;
       blendRoutePreview(route.from,f,smooth(time,route.time,route.time+.75));
       f.lift=lift;
       f.traffic=traffic;
      }
      return {...f,x:workZoneX-laneX+f.x*direction,yaw:f.yaw*direction,pathX:z=>workZoneX+f.pathX(z)*direction,
       lamp: Number(time>=f.signalAt&&f.distance<f.mergeEnd&&(time-f.signalAt)%.8<.4), lampSide:options.side,
       obstacleZ:f.distance-firstConeDistance-offset,
       traffic:f.traffic.map(car=>({...car,x:workZoneX+car.x*(car.direction>0?1:direction),
        yaw:car.direction>0?Math.PI:car.yaw*direction,
        ...(direction<0&&car.rearIndicator&&{rearIndicator:'right'}),
        growth:carried.length===0&&!route.from?smooth(time,0,.6):1}))};
     };
     const route = {sample, toggle, timing};
     for (const change of toggles) toggle(change.time,change.enabled);
     routesBySide.set(options.side, route);
     return route;
    };
    next = time => routeForSide().sample(time);
    workZoneTiming = () => routeForSide().timing();
    setTraffic = (time, enabled) => {
     routeForSide();
     for (const route of routesBySide.values()) route.toggle(time, enabled);
     toggles.push({time,enabled});
    };
   } else {
    next = liveCut?.sample ?? planRoadLaneChange(newTrafficRandom(), {egoX: laneX, laneWidth: side * laneWidth,
     live: {...anchor, cruiseSpeed: roadCruiseSpeed(world)}});
   }
   const handoffSeconds = 1.8;
   const sample = time => {
    if (time < start) return priorFrame(time);
    const elapsed = time - start;
    const frame = next(elapsed, reducedMotion.matches);
    const prior = event !== 'roadworks' && elapsed < handoffSeconds
     ? new Map(anchor.traffic.map(car => [car.id, car])) : null;
    if (prior) {
     frame.traffic = frame.traffic.map(car => {
      const before = prior.get(car.id);
      prior.delete(car.id);
      if (!before) return car;
      if (elapsed === 0) return before;
      return {...car,growth:lerp(before.growth ?? 1,1,smooth(elapsed,0,.6))};
     });
     for (const car of prior.values()) {
      frame.traffic.push({...car, z: car.z + frame.distance + car.speed * car.direction * elapsed,
       growth: (car.growth ?? 1) * (1 - smooth(elapsed, 0, handoffSeconds))});
     }
    }
    if (event==='roadworks') frame.visibleTraffic=ambientEnabled()?frame.traffic:[];
    const mix = smooth(elapsed, 0, handoffSeconds);
    frame.yaw = lerp(anchor.yaw, frame.yaw, mix);
    frame.distance += anchor.distance;
    frame.roadOffset = anchor.roadOffset ?? 0;
    frame.cameraYaw ??= anchor.cameraYaw ?? 0;
    frame.x += anchor.x;
    frame.lift = reducedMotion.matches ? 0 : frame.lift;
    frame.cameraPose = cameraPose;
    frame.cameraPoseMode = camera;
    if (onRoad && camera === 'auto' && cameraPose && !reducedMotion.matches) {
     const riseAt = liveCut?.timing.cameraRiseAt;
     const handoff = liveCut ? Math.min(handoffSeconds, riseAt ?? handoffSeconds) : frame.laneChange?.steerAt;
     frame.cameraPoseWeight = 1 - (Number.isFinite(handoff) ? smooth(elapsed,0,handoff) : mix);
    }
    if (reducedMotion.matches) frame.targetBias = 0;
    const delta = frame.distance - anchor.distance;
    if (mix < 1) {
     const path = frame.pathX;
     frame.pathX = z => lerp(anchor.pathX(z - delta), path(z), mix);
    }
    return frame;
   };
   roadRun = {event, start, requestedAt:at, get duration(){return start + (workZoneTiming?.().endAt ?? ROADWORKS_SECONDS)}, sample, baseX, previous, cutInTiming: liveCut?.timing, workZoneX, setTraffic, workZoneTiming};
  },
  clearRoadRun() { roadRun = null; },
  sample(seconds, camera = world.state.cameraView === 'high' ? 'high' : 'auto', from, weight = 1) {
   if (event === 'roadworks' && (assembly?.parent !== world.root || assembly.name !== 'elevated-roadworks-' + options.obstacle)) {
    if (assembly) assembly.visible = false;
    assembly = world.root.getObjectByName('elevated-roadworks-' + options.obstacle) ?? roadworksAssembly(world, options.obstacle);
   }
   const {id} = world.state;
   const adjacent = adaptiveTraffic && event === 'cutin' && id !== '03';
   const ramp = id === '06' || id === '07';
   if (!base || baseRoot !== world.root || vehicle !== world.car) {
    baseRoot = world.root;
    vehicle = world.car;
    world.car.position.x = roadRun?.baseX ?? (adjacent && ramp ? laneWidth : world.dividedRoad?.egoCenter ?? laneWidth / 2);
    world.car.rotation.y = 0;
    if (event === 'lanechange') {
     targetLane = world.root.getObjectByName('lane-change-lane') ?? createTargetLane(world.root);
     targetSlot = world.root.getObjectByName('lane-change-target') ?? createLaneChangeTarget(world.root);
     const {x: width, z: length} = new THREE.Box3().setFromObject(world.car).getSize(new THREE.Vector3());
     // The target SDF runs lengthwise in UV.x and insets each edge by .06.
     // Preserve the car's aspect ratio in the visible footprint, with 16% clearance.
     targetSlot.scale.set(width * 1.16 / (1 - .12 / 2.8), length * 1.16 / (1 - .12 / 4.9), 1);
    }
    world.configureCamera(id, {cameraView:'low'});
    base = world.captureCamera();
    world.configureCamera(id, {cameraView:'high'});
    world.camera.position.y += 2;
    world.camera.position.z += 5;
    world.camera.lookAt(world.cameraAim);
    world.framing = anchorVehicle(world.car, world.camera, 'high');
    high = world.captureCamera();
   }
   const showTraffic = ambientEnabled();
   if (followingTrafficEnabled !== showTraffic) {
    followingFeedback = null;
    followingTrafficEnabled = showTraffic;
   }
   let frame;
   if (roadRun) {
    frame = roadRun.sample(seconds);
   } else if (event === 'roadworks') {
    const offset = offsets[options.distance];
    const direction = options.side === 'right' ? -1 : 1;
    const orient = car => car.direction > 0 || direction === 1 ? car : {
     ...car, x: -car.x, yaw: -car.yaw,
     ...(car.rearIndicator && {rearIndicator: 'right'}),
    };
    if (adaptiveTraffic) {
     if (!routes.length) startRun();
     const route = routes.findLast(entry => entry.time <= seconds);
     frame = sampleRoute(seconds, route);
     const fleet = route.enabled ? route.plan : routes.findLast(entry => entry.enabled)?.plan;
     frame.visibleTraffic = showTraffic && fleet ? fleet.sampleTraffic(seconds, frame.distance, route.enabled)
      .filter(car => car.direction > 0 || Math.abs(car.z) > 6 || Math.abs(car.x - frame.x) > 2.25)
      .map(orient) : [];
    } else {
     if (showTraffic) trafficPlan ??= planTraffic();
     else trafficPlan = trafficRandom = null;
     frame = sampleRoute(seconds, {plan: trafficPlan, time: -Infinity});
    }
    const pathX = frame.pathX;
    frame.x *= direction;
    frame.yaw *= direction;
    frame.pathX = z => direction * pathX(z);
    frame.lampSide = options.side;
    frame.traffic = frame.traffic.map(orient);
    if (options.obstacle === 'vehicle') {
     const stopped = {id:'stopped-vehicle', x: direction * laneWidth, z: frame.obstacleZ - obstacleDepth, yaw:0, speed:0, direction:-1};
     frame.traffic.unshift(stopped);
     frame.visibleTraffic?.unshift(stopped);
    }
   } else if (event === 'lanechange') {
    laneChangePlan ??= planRoadLaneChange(newTrafficRandom(), {egoX: base.carPosition.x, laneWidth});
    frame = laneChangePlan(seconds, reducedMotion.matches);
    if (reducedMotion.matches) frame.lift = frame.targetBias = 0;
   } else if (adjacent) {
    if (!adjacentPlan) {
     const random = newTrafficRandom(cutInSeed);
     const egoX = base.carPosition.x;
     adjacentPlan = id === '02'
      ? planLiveCutIn(random, {egoX, outerLane: (world.state.laneCount / 2 - .5) * laneWidth, traffic: [], speed: cruise}).sample
      : planAdjacentCutIn(random, {layout: id, egoX});
     adjacentPlan.endAt = adjacentPlan(0).rampMerge?.endAt;
    }
    frame = adjacentPlan(seconds);
    if (reducedMotion.matches) frame.lift = 0;
   } else if (adaptiveTraffic && (event === 'cutin' || event === 'aes')) {
    interactionFleet ??= createInteractionTraffic(newTrafficRandom(), laneWidth, event);
    followingFeedback??=planFollowingFeedback(event,laneWidth,interactionFleet.ambient,interactionFleet.actor);
    frame = followingFeedback(seconds);
    if (reducedMotion.matches) frame.lift = 0;
   } else {
    if (showTraffic) ambient ??= createFollowingTraffic(newTrafficRandom(), laneWidth);
    else if (!adaptiveTraffic) ambient = null;
    followingFeedback??=planFollowingFeedback(event,laneWidth,showTraffic?ambient??[]:[]);
    frame = followingFeedback(seconds);
    if (reducedMotion.matches) frame.lift = 0;
   }
   camera = frame.cameraMode ?? camera;
   const cameraX = frame.x;
   // Auto events and the manual High pick share one endpoint.
   const target = high;
   const lift = camera === 'high' ? 1 : camera === 'low' ? 0 : frame.lift;
   if (event === 'roadworks' && from && weight < 1) frame = blendRoadworksFrame(from, frame, weight);
   const {x, yaw, distance, speed, obstacleZ} = frame;
   drive.seekDraftDistance(distance + (frame.roadOffset ?? 0), speed);
   world.draftRoadworksFrame = frame;
   world.car.position.copy(base.carPosition).x += x;
   world.car.rotation.y = yaw;
   world.camera.position.copy(base.position).lerp(target.position, lift);
   world.cameraAim.copy(base.aim).lerp(target.aim, lift);
   if (ramp && frame.cameraYaw != null) {
    world.camera.position.sub(base.carPosition).applyAxisAngle(up, frame.cameraYaw ?? 0).add(world.car.position);
    world.cameraAim.sub(base.carPosition).applyAxisAngle(up, frame.cameraYaw ?? 0).add(world.car.position);
   } else {
    world.camera.position.x += cameraX;
    world.cameraAim.x += cameraX + (camera === 'auto' ? frame.targetBias ?? 0 : 0);
   }
   world.camera.lookAt(world.cameraAim);
   const offset = THREE.MathUtils.lerp(base.offset.y, target.offset.y, lift);
   const view = world.camera.view;
   if (view?.offsetX !== base.offset.x || view.offsetY !== offset) {
    world.camera.setViewOffset(1920, 1080, base.offset.x, offset, 1920, 1080);
   }
   world.camera.updateMatrixWorld(true);
   if (event === 'roadworks') {
    assembly.visible=Number.isFinite(obstacleZ);
    if(assembly.visible)assembly.position.set(roadRun?.workZoneX ?? base.carPosition.x, base.carPosition.y - .02, base.carPosition.z + obstacleZ + 10);
    assembly.scale.x = options.side === 'right' ? -1 : 1;
   }
   if (event === 'collision' || event === 'aes') {
    if (warning?.parent !== world.root) warning = world.root.getObjectByName('collision-warning') ?? createWarningOutline(world.root);
    warning.visible = overlay && frame.warning > 0;
    warning.position.set(frame.traffic[0].x, base.carPosition.y + .035, base.carPosition.z + frame.traffic[0].z);
    warning.children[0].material.opacity = frame.warning;
   }
   const rig = frame.cameraPose;
   const poseWeight = camera === 'auto' ? frame.cameraPoseWeight ?? 1 - lift : 1;
   if (rig && camera === frame.cameraPoseMode && poseWeight > 0) {
    const pose = world.captureCamera();
    const follow = (world.car.position.x - rig.carPosition.x) * poseWeight;
    pose.position.lerp(rig.position, poseWeight).x += follow;
    pose.aim.lerp(rig.aim, poseWeight).x += follow;
    pose.offset.lerp(rig.offset, poseWeight);
    pose.carPosition = null;
    pose.quaternion = poseWeight === 1 ? rig.quaternion : null;
    world.applyCamera(pose);
   }
   if (frame.rampMerge) {
    // Keep the vehicle centered as the chase camera rotates and changes height.
    const view = world.camera.view;
    rampAnchor.copy(world.car.position).y += .9;
    rampAnchor.project(world.camera);
    world.camera.setViewOffset(1920, 1080, view.offsetX + rampAnchor.x * 960, view.offsetY, 1920, 1080);
   }
   if (frame.targetSlot && !targetSlot) {
    targetLane = world.root.getObjectByName('lane-change-lane');
    targetSlot = world.root.getObjectByName('lane-change-target');
   }
   if (targetSlot && !frame.targetSlot) targetSlot.visible = targetLane.visible = false;
   if (targetSlot && frame.targetSlot) {
    const {x, z, opacity, rim, selected} = frame.targetSlot;
    targetLane.visible = frame.laneHighlight > 0;
    targetLane.position.set(x, base.carPosition.y + .002, base.carPosition.z + laneHighlightRear - laneHighlightLength / 2);
    targetLane.material.uniforms.opacity.value = frame.laneHighlight;
    targetSlot.visible = opacity > 0;
    targetSlot.position.set(x, base.carPosition.y + .045, base.carPosition.z + z);
    const uniforms = targetSlot.material.uniforms;
    uniforms.opacity.value = opacity;
    uniforms.rimWeight.value = rim;
    uniforms.selected.value = selected;
   }
  },
  reset() {
   if (base) {
    world.applyCamera(world.state.cameraView === 'high' ? high : base);
    world.car.rotation.y = 0;
   }
   if (assembly) assembly.visible = false;
   if (warning) warning.visible = false;
   if (targetSlot) targetSlot.visible = false;
   if (targetLane) targetLane.visible = false;
   base = baseRoot = roadRun = null;
   trafficPlan = null;
   trafficRandom = null;
   routes = [];
   ambient = interactionFleet = adjacentPlan = laneChangePlan = followingFeedback = null;
   world.draftRoadworksFrame = null;
  },
 };
}
