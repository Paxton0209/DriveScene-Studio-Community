// Planner clearance in metres; visual warning severity lives in traffic-feedback.js.
export const cutInClearance = {longitudinal: 6, lateral: 2.25};

// Use the rendered Model Y footprint against the divider, before adding the
// safety margin used to predict a collision. Offset and yaw are lane-relative.
export function cutInTouchesDivider(offset, yaw, laneWidth) {
 const lateralReach = .95 * Math.abs(Math.cos(yaw)) + 2.375 * Math.abs(Math.sin(yaw));
 return Math.abs(offset) - lateralReach <= laneWidth / 2;
}
