import * as THREE from 'three';

// The traffic asset merges its lights into the body mesh. This strip follows
// the sampled left rear contour of the Model Y, just clear of the paint.
export function createCutInIndicator() {
 const geometry = new THREE.BufferGeometry();
 geometry.setAttribute('position', new THREE.Float32BufferAttribute([
  -.78, 1.01, 2.044, -.78, 1.075, 1.951,
  -.73, .99, 2.138, -.73, 1.085, 2.119,
  -.65, .98, 2.187, -.65, 1.075, 2.182,
  -.54, .975, 2.224, -.54, 1.065, 2.233,
  -.43, .975, 2.248, -.43, 1.06, 2.266,
 ], 3));
 geometry.setIndex([0,2,1, 1,2,3, 2,4,3, 3,4,5, 4,6,5, 5,6,7, 6,8,7, 7,8,9]);
 const material = new THREE.MeshBasicMaterial({color:'#ffb449',toneMapped:false,side:THREE.DoubleSide});
 const indicator = new THREE.Group();
 indicator.name = 'Cut-in left rear turn signal';
 indicator.userData.draftOwned = true;
 indicator.add(new THREE.Mesh(geometry, material));
 return indicator;
}
