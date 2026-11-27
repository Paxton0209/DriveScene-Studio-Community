// Default Auto camera timing for open roads.
export const INTERACTION_CAMERA = Object.freeze({rise:1.5,fall:1.4});
const smooth=n=>{if(n<=1e-12)return 0;if(n>=1-1e-12)return 1;return n*n*n*(10+n*(-15+6*n))};
export const interactionCameraLift=(time,riseAt,returnAt)=>
 smooth((time-riseAt)/INTERACTION_CAMERA.rise)*(1-smooth((time-returnAt)/INTERACTION_CAMERA.fall));

// Move the return later when the maneuver leaves too little time for the full transition.
export function maneuverCameraLift(time, riseAt, settledAt, holdUntil = riseAt) {
 const returnAt = Math.max(riseAt + INTERACTION_CAMERA.rise, holdUntil, settledAt - INTERACTION_CAMERA.fall);
 return interactionCameraLift(time, riseAt, returnAt);
}
