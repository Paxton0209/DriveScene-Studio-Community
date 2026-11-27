import * as THREE from 'three';

const volvoBumper=/^desirefxme_(049|050|051|052|054|060|061|068|088|090|091|092|093|097|098)_/;
const frontPlates={
  x6:/^Object_40$/,
  ix:/^Object_(46|47|48|49)$/,
  xc90:/^desirefxme_135_/
};

// Several models merge front and rear trim in one indexed primitive.
function splitFrontSurface(mesh,predicate,frontMaterial){
  const source=mesh.geometry,position=source.attributes.position,indices=source.index;
  const remaining=[],front=[],triangle=[],center=new THREE.Vector3(),point=new THREE.Vector3();
  for(let i=0,n=indices?.count??position.count;i<n;i+=3){
    center.set(0,0,0);
    for(let j=0;j<3;j++){
      const index=indices?indices.getX(i+j):i+j;
      triangle[j]=index;
      center.add(point.fromBufferAttribute(position,index));
    }
    center.multiplyScalar(1/3).applyMatrix4(mesh.matrixWorld);
    (predicate(center)?front:remaining).push(...triangle);
  }
  if(!front.length)return;
  const geometry=source.clone();
  geometry.setIndex(remaining.concat(front));geometry.clearGroups();
  if(remaining.length)geometry.addGroup(0,remaining.length,0);
  geometry.addGroup(remaining.length,front.length,1);
  mesh.geometry=geometry;mesh.material=[mesh.material,frontMaterial];
}

function satin(material,color,metalness,roughness,environment){
  material.color.set(color);
  material.metalness=metalness;
  material.roughness=roughness;
  material.envMapIntensity=environment;
  if(material.isMeshPhysicalMaterial)material.clearcoat=0;
  material.needsUpdate=true;
}

export function finishParkedFront(car,id){
  const lens=new THREE.MeshPhysicalMaterial({
    name:'Front lamp lens',color:'#364653',metalness:.10,roughness:.29,
    clearcoat:.46,clearcoatRoughness:.24,envMapIntensity:.46,
    transparent:true,opacity:.90,depthWrite:false,
    polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1
  });
  const invisible=new THREE.MeshBasicMaterial({visible:false});
  car.updateMatrixWorld(true);
  car.traverse(mesh=>{
    if(!mesh.isMesh)return;
    if(frontPlates[id]?.test(mesh.name)){
      splitFrontSurface(mesh,p=>p.z< -2.37&&Math.abs(p.x)<.33,invisible);
      return;
    }
    if(id==='x6'&&mesh.name==='mesh_7'){
      splitFrontSurface(mesh,p=>p.z< -1.73&&p.y<1.12&&Math.abs(p.x)>.43,lens);
      return;
    }
    if(id==='model-3'&&mesh.name==='Object_12'){
      const badge=new THREE.MeshStandardMaterial({
        name:'Hood badge',color:'#4a5760',metalness:.36,roughness:.32,envMapIntensity:.55
      });
      splitFrontSurface(mesh,p=>p.z< -2.17&&p.y>.62&&Math.abs(p.x)<.055,badge);
      return;
    }
    if(id==='xc90'&&volvoBumper.test(mesh.name))mesh.material=mesh.material.clone();
    for(const material of [mesh.material].flat()){
      const role=material.userData.surfaceRole;
      if(role?.startsWith('grille-')){
        const frame=role==='grille-frame';
        const panel=role==='grille-panel';
        satin(material,frame?'#626a72':panel?'#292d32':'#394047',frame?.38:.15,frame?.43:.60,frame?.52:.29);
      }else if(id==='x6'&&material.name==='black_ext_ao'){
        satin(material,'#30383e',.04,.68,.28);
      }else if(id==='xc90'&&volvoBumper.test(mesh.name)){
        const chrome=role==='chrome';
        satin(material,chrome?'#666e75':'#373e45',chrome?.28:.10,chrome?.49:.63,.34);
      }else if(role==='head-lens'){
        satin(material,'#778997',.08,.27,.60);
        material.opacity=.36;
      }else if(role==='headlamp'){
        satin(material,'#b4c5d2',.18,.32,.75);
        material.emissiveIntensity=.045;
      }
    }
  });
}
