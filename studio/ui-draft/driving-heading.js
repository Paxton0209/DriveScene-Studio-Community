// Use the route across the length of the car to estimate its body heading.
const halfBodyLength = 2.4;

export function drivingHeading(xAt, station, metresPerUnit = 1, routeStart = -Infinity) {
 // A stationary car on these routes faces along the lane. No travel chord exists at rest.
 if (metresPerUnit === 0) return 0;
 const halfSpan = Math.min(halfBodyLength / metresPerUnit, station - routeStart);
 if (halfSpan <= 0) return 0;
 return Math.atan2(xAt(station - halfSpan) - xAt(station + halfSpan), 2 * halfSpan * metresPerUnit);
}

// A time-based traffic route can slow to a stop. Bound its time chord and
// measure actual forward travel so a stop never looks seconds into a later turn.
export function trafficHeading(car,time){
 const halfSpan=Math.min(.25,halfBodyLength/Math.max(car.speedAt(time),.01));
 const before=Math.max(0,time-halfSpan),after=time+halfSpan;
 const forward=car.distanceAt(after)-car.distanceAt(before);
 if(forward<1e-5)return 0;
 return Math.atan2(car.xAt(before)-car.xAt(after),forward);
}

// Aim the chase camera into the next section of the ramp. The forward chord
// also brings the camera onto the mainline as the car finishes the merge.
export function rampCameraHeading(xAt, distance) {
 const lookAhead = 8;
 return Math.atan2(xAt(distance) - xAt(distance + lookAhead), lookAhead);
}
