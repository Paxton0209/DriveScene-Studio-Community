import {RAMP_PAINT_INSET,RAMP_CURB_TOP,rampCurbEdges,rampCurbWidth} from './road-boundaries.js';
import {BufferGeometry,Color,Float32BufferAttribute,Group,Mesh,ShaderMaterial} from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {rampPassageState} from './road-mark-motion.js';
import {patchRoadLayout} from '../engine/road-layout-morph.js';
import {mergeRampSection,rampSection} from './ramp-lanes.js';

const passages=new WeakMap();
const EDGE_PAINT_WIDTH = .13;
const GUIDE_TAPER = 2.5;

function paintMergeChevron(world, left, right, u, rise, width) {
 const halfSpan = (right - left) / 2;
 const length = Math.hypot(halfSpan, rise);
 const paddedWidth = width + .36;
 // Keep the paint width measured perpendicular to each arm, including at the
 // shared miter. Use the same analytic edge and paint batch as the solid lines.
 const points = [[left, u, -rise / length, halfSpan / length],
  [(left + right) / 2, u + rise, 0, length / halfSpan],
  [right, u, rise / length, halfSpan / length]];
 const positions = [], uv = [], size = [];
 for (const [x, station, nx, nz] of points) for (const side of [-1, 1]) {
  const offset = side * paddedWidth / 2;
  positions.push(x + nx * offset, .028, station - 60 + nz * offset);
  uv.push((side + 1) / 2, .5);
  size.push(width, 100000, paddedWidth, 100000);
 }
 const geometry = new BufferGeometry();
 geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
 geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
 geometry.setAttribute('paintSize', new Float32BufferAttribute(size, 4));
 geometry.setIndex([0,1,2,1,3,2,2,3,4,3,5,4]);
 geometry.computeVertexNormals();
 world.root.add(new Mesh(geometry, world.mat.whitePaint));
}

// Paint the neutral area past the physical nose, then open the merge with
// a dotted extension of the mainline edge.
export function paintRampMerge(world, half, join, end, far, nose, dual = false) {
 const edge = half - RAMP_PAINT_INSET;
 const section = dual ? rampSection : mergeRampSection;
 const rampEdge = u => section(u).l + RAMP_PAINT_INSET;
 // The painted nose is where the two inset edges meet on the asphalt.
 let before = 0, after = join;
 for (let index = 0; index < 20; index++) {
  const middle = (before + after) / 2;
  if (rampEdge(middle) < edge) before = middle;
  else after = middle;
 }
 const apex = (before + after) / 2;
 const paint = (points, width) => world.pathRibbon(points.map(([x,u]) => [x,u-60]), width, .028, 'white');
 const curve = (start, finish, xAt = rampEdge) => {
  const steps = Math.max(1, Math.ceil((finish - start) / .25));
  return Array.from({length: steps + 1}, (_, index) => {
   const u = start + (finish - start) * index / steps;
   return [xAt(u), u];
  });
 };

 const guideWidth = dual ? .24 : EDGE_PAINT_WIDTH;
 const paintGuide = (points, taperEnd) => {
  const mesh = paint(points, guideWidth);
  if (!dual) return;
  // Change the paint width within the ribbon so no two end faces meet mid-line.
  const sizes = mesh.geometry.getAttribute('paintSize');
  points.forEach(([,u], index) => {
   const t = Math.min(1, Math.max(0, (taperEnd - u) / GUIDE_TAPER));
   const width = EDGE_PAINT_WIDTH + (guideWidth - EDGE_PAINT_WIDTH) * t * t * (3 - 2 * t);
   sizes.setX(index * 2, width);
   sizes.setX(index * 2 + 1, width);
  });
 };
 const rampGuide = curve(apex, far);
 rampGuide[0][0] = edge;
 paintGuide(rampGuide, end + GUIDE_TAPER);
 paintGuide(dual ? curve(apex, join, () => edge) : [[edge, apex], [edge, join]], join);
 let noseTip = end;
 for (let i = 0; i <= 192; i++) noseTip = Math.min(noseTip, nose.getPoint(i / 192).z + 60);
 if (dual) {
  // Fit a complete upstream-facing chevron between the painted and physical
  // noses, with both arms ending on the channelizing lines.
  const u = noseTip - 2.65;
  const right = rampEdge(u);
  const rise = (right - edge) / (2 * Math.tan(40 * Math.PI / 180));
  if (u > apex && rise > 0 && u + rise + .25 < noseTip) {
   paintMergeChevron(world, edge, right, u, rise, .31);
  }
 } else {
  for (let u = noseTip - 2.1; u > apex + 3; u -= 3.1) {
   const left = edge + .48, right = rampEdge(u) - .48;
   const halfSpan = (right - left) / 2;
   if (halfSpan >= .275) paintMergeChevron(world, left, right, u, Math.min(.85, halfSpan), .27);
  }
 }
 for (let u = apex - (dual ? 1.25 : 1.8); u >= (dual ? 1.25 : 4); u -= 3.5) {
  paint([[edge, u], [edge, u - 1.25]], dual ? .13 : .15);
 }
 if (dual) {
  // End the divider before it meets the mainline guide, leaving the two
  // ramp lanes open to converge into the same receiving lane.
  for (let u = apex - 6.5; u + 2.8 <= far; u += 7.5) {
   const dash = Array.from({length: 9}, (_, index) => {
    const station = u + index * .35;
    return [section(station).x, station];
   });
   paint(dash, .13);
  }
 }
}

function entranceContactMaterial(world) {
 const material = new ShaderMaterial({
  transparent: true, depthWrite: false, toneMapped: false,
  uniforms: {
   strength: world.draftEntranceContact ??= {value: 0},
   tone: world.draftThemeTone ?? world.environmentTone ?? {value: 0},
   dayColor: {value: new Color('#8895a0')},
   nightColor: {value: new Color('#11151b')}
  },
  vertexShader: `
   varying float across;
   varying float depth;
   void main() {
    #include <begin_vertex>
    vec4 positionInView = modelViewMatrix * vec4(transformed, 1.);
    depth = -positionInView.z;
    across = uv.x;
    gl_Position = projectionMatrix * positionInView;
   }
  `,
  fragmentShader: `
   uniform float strength;
   uniform float tone;
   uniform vec3 dayColor;
   uniform vec3 nightColor;
   varying float across;
   varying float depth;
   void main() {
    float opacity = 1. - smoothstep(0., 1., across);
    opacity *= strength * mix(.38, .19, tone) * (1. - smoothstep(65., 150., depth));
    gl_FragColor = vec4(mix(dayColor, nightColor, tone), opacity);
    #include <colorspace_fragment>
   }
  `
 });
 material.defaultAttributeValues.layoutOffset = [0, 0, 0];
 material.defaultAttributeValues.roadLayoutRole = [0];
 patchRoadLayout(material, world);
 return material;
}

// Follow the ground side of each curb, tapering from its base into the grade.
function curbContact(points, width, material, centerY = 0) {
 const sections = [[-.06, -.098], [.50, -.118], [2.15, -.136]];
 const positions = [], coordinates = [], indices = [];
 for (let i = 0; i < points.length; i++) {
  const [x, z] = points[i];
  const before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 1)];
  const dx = after[0] - before[0], dz = after[1] - before[1], length = Math.hypot(dx, dz) || 1;
  for (const [offset, y] of sections) {
   positions.push(x - dz / length * (width + offset), y - centerY, z + dx / length * (width + offset));
   coordinates.push(offset / sections.at(-1)[0], 0);
  }
  for (let section = 0; i > 0 && section < sections.length - 1; section++) {
   const a = (i - 1) * sections.length + section, b = a + sections.length;
   indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
 }
 const geometry = new BufferGeometry();
 geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
 geometry.setAttribute('uv', new Float32BufferAttribute(coordinates, 2));
 geometry.setIndex(indices);
 const mesh = new Mesh(geometry, material);
 mesh.name = 'Ramp curb contact';
 return mesh;
}

export function installRampPassage(world,id,width,startIndex,join,dual=false,inner,outer){
 const root=world.root,payload=new Group();payload.name='ramp-passage';
 const curbWidth=rampCurbWidth(id==='07'?-1:1);
 const contact=id==='07'&&inner&&outer?entranceContactMaterial(world):null;
 if(contact)for(const points of rampCurbEdges(inner,outer))if(points.length>1)root.add(curbContact(points,curbWidth,contact));
 for(const mesh of root.children.slice(startIndex)){
  if(mesh.userData.laneDash||mesh.geometry?.type==='PlaneGeometry'&&mesh.position.x<0)continue;
  // The asphalt is horizontal. Near-zero-area triangles along dense straight
  // perimeter samples can otherwise produce inverted or zero vertex normals.
  if(mesh.geometry?.type==='ShapeGeometry'&&mesh.material===world.mat.road){
   const normal=mesh.geometry.getAttribute('normal');
   for(let i=0;i<normal.count;i++)normal.setXYZ(i,0,1,0);
   normal.needsUpdate=true;
  }
  mesh.castShadow=false;payload.add(mesh);
 }
 const paint=[...payload.children].filter(mesh=>mesh.material===world.mat.whitePaint);
 if(paint.length>1){
  const geometries=paint.map(mesh=>{mesh.updateMatrix();return mesh.geometry.clone().applyMatrix4(mesh.matrix)}),merged=mergeGeometries(geometries,false);
  geometries.forEach(geometry=>geometry.dispose());
  if(merged){const batch=new Mesh(merged,world.mat.whitePaint);batch.name='ramp-passage-paint';payload.add(batch);for(const mesh of paint){mesh.removeFromParent();mesh.geometry.dispose();}}
 }
 root.add(payload);world.road(0,width,70,-900,-.002);
 const edges=new Group();edges.name='ramp-mainline-edge';root.add(edges);
 for(let index=0;index<2;index++){world.line(width/2-RAMP_PAINT_INSET,70,-900);const mesh=root.children.at(-1);mesh.name='ramp-mainline-edge-'+index;edges.add(mesh);}
 if(dual){
  // The near edge shares a flush endpoint with the painted guide. Suppress
  // the plane's antialiased end cap there to avoid a dark line across the join.
  const mesh=edges.children[0],uv=mesh.geometry.getAttribute('uv');
  for(let i=0;i<uv.count;i++)uv.setY(i,.5);
  mesh.userData.flushPaintEnd=true;
 }
 const curbs=new Group();curbs.name='ramp-mainline-curbs';root.add(curbs);
 const height=RAMP_CURB_TOP+.10,center=(RAMP_CURB_TOP-.10)/2;
 const straightCurb=(edge,direction)=>{
  const curb=world.box(curbWidth,height,970,edge+direction*curbWidth/2,center,-415,'curb');
  curb.castShadow=false;curb.receiveShadow=false;
  if(contact){
   const x=-direction*curbWidth/2;
   curb.add(curbContact([[x,direction*485],[x,-direction*485]],curbWidth,contact,center));
  }
  return curb;
 };
 for(let index=0;index<2;index++)curbs.add(straightCurb(width/2,1));
 straightCurb(-(width+1.6)-width/2,-1);
 const gap=id==='06'?[-8-join,-8]:[-60,-60+join];
 passages.set(root,{payload,edges,curbs,gap});advanceRampPassage(root,world.drivingDistance||0);
}

function edgeSpan(mesh,start,end){
 const near=Math.min(70,start),far=Math.max(-900,end);
 mesh.visible=near>far;
 if(!mesh.visible)return;
 mesh.position.z=(near+far)/2;
 if(mesh.geometry.type==='BoxGeometry')mesh.scale.z=(near-far)/mesh.geometry.parameters.depth;
 else mesh.scale.y=(near-far+(mesh.userData.flushPaintEnd?0:.8))/mesh.geometry.parameters.height;
}

export function advanceRampPassage(root,distance){
 const passage=passages.get(root);if(!passage)return;
 const state=rampPassageState(distance),far=passage.gap[0]+state.offset,near=passage.gap[1]+state.offset;
 passage.payload.position.z=state.offset;passage.payload.visible=state.visible;
 edgeSpan(passage.edges.children[0],70,near);edgeSpan(passage.edges.children[1],far,-900);
 edgeSpan(passage.curbs.children[0],70,near);edgeSpan(passage.curbs.children[1],far,-900);
}
