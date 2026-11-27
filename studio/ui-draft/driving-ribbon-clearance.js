import {MathUtils} from 'three';

const {smootherstep, lerp} = MathUtils;
const rearGap = 1.8;
const lateralPadding = .2;
const approachBand = 1.2;

export function drivingRibbonEnd(path, egoZ, halfWidth, cars, pathX, startS, endS, locate) {
 let end = endS;
 for (const car of cars) {
  if (car.direction > 0 || (car.opacity ?? 1) <= 0 || (car.growth ?? 1) <= 0) continue;
  const sine = Math.abs(Math.sin(car.yaw ?? 0)), cosine = Math.abs(Math.cos(car.yaw ?? 0));
  const halfLength = (car.length ?? 4.9) / 2;
  const halfBodyWidth = (car.width ?? 2.1) / 2;
  const depth = cosine * halfLength + sine * halfBodyWidth;
  const width = cosine * halfBodyWidth + sine * halfLength;
  const z = egoZ + car.z;
  const ahead = 1 - smootherstep(car.z - depth, -1, 0);
  if (ahead === 0) continue;
  const offsets = [pathX(z - depth), pathX(z), pathX(z + depth)];
  const lateralGap = Math.max(Math.min(...offsets) - car.x, car.x - Math.max(...offsets), 0) - width - halfWidth;
  // Begin easing before the ribbon touches the footprint, and apply the full
  // limit throughout the overlap, even when the car is grey.
  const weight = ahead * (1 - smootherstep(lateralGap, lateralPadding, lateralPadding + approachBand));
  if (weight === 0) continue;
  const stop = locate(path.points, path.cum, path.plan.x, z + depth + rearGap);
  end = Math.min(end, lerp(endS, Math.max(startS, Math.min(endS, stop)), weight));
 }
 return end;
}
