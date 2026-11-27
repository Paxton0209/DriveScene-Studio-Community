// Cross section of the ramp at a longitudinal station u measured away from
// the mainline. The lane offsets follow the perpendicular road width.
export function rampSection(u, halfWidth = 3.7) {
 const t = Math.max(0, u), q = Math.min(t, 60);
 const x = 1.85 + .009 * q * q + Math.max(0, t - 60) * 1.08;
 const half = halfWidth * Math.hypot(1, .018 * q);
 return {x, l: x - half, r: x + half};
}

export function rampRightLaneX(u) {
 return rampSection(u, 1.85).r;
}

// The standalone draft keeps its single entrance lane.
export function mergeRampSection(u) {
 const {x, r} = rampSection(u);
 return {x: (x + r) / 2, l: x, r};
}

// The Pro entrance uses both lanes of the approach. The inner lane reaches
// the receiving lane first; round off its tangent as it straightens out.
export function mergeRampLaneX(u, lane, mainlineX = 3.7) {
 if (lane === 'outer') return mergeRampSection(u).x;
 const {x, l} = rampSection(u);
 const offset = (x + l) / 2 - mainlineX, blend = 2.4;
 if (offset <= -blend) return mainlineX;
 if (offset >= blend) return mainlineX + offset;
 return mainlineX + (offset + blend) ** 2 / (4 * blend);
}
