import * as THREE from 'three/webgpu';
import {
  Fn, If,
  instancedArray, instanceIndex,
  uniform,
  float, int, vec3, vec4, color,
  hash, time, deltaTime,
  mix, clamp, max, min, normalize, select,
  positionWorld
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PARTICLE_COUNT = 200_000;

let renderer, scene, camera, controls, clock;

const attractorPos = uniform(new THREE.Vector3(0, 0, 0));
const attractorStrength = uniform(0.0);
const dt = uniform(0);

const positions = instancedArray(PARTICLE_COUNT, 'vec3');
const velocities = instancedArray(PARTICLE_COUNT, 'vec3');
const lifetimes = instancedArray(PARTICLE_COUNT, 'float');

const computeInit = Fn(() => {
  const pos = positions.element(instanceIndex);
  const vel = velocities.element(instanceIndex);
  const life = lifetimes.element(instanceIndex);

  const theta = hash(instanceIndex).mul(Math.PI * 2);
  const phi = hash(instanceIndex.add(1)).mul(Math.PI).sub(Math.PI / 2);
  const radius = hash(instanceIndex.add(2)).mul(4.0).add(0.5);

  pos.x.assign(theta.cos().mul(phi.cos()).mul(radius));
  pos.y.assign(phi.sin().mul(radius));
  pos.z.assign(theta.sin().mul(phi.cos()).mul(radius));

  const speed = hash(instanceIndex.add(3)).mul(0.5).add(0.1);
  const angle = hash(instanceIndex.add(4)).mul(Math.PI * 2);
  vel.x.assign(angle.cos().mul(speed).mul(0.3));
  vel.y.assign(speed.mul(0.5));
  vel.z.assign(angle.sin().mul(speed).mul(0.3));

  life.assign(hash(instanceIndex.add(5)).mul(3.0).add(1.0));
})().compute(PARTICLE_COUNT);

const computeUpdate = Fn(() => {
  const pos = positions.element(instanceIndex);
  const vel = velocities.element(instanceIndex);
  const life = lifetimes.element(instanceIndex);

  const toAttractor = attractorPos.sub(pos);
  const dist = toAttractor.length();
  const attractDir = toAttractor.normalize();
  const force = attractDir.mul(attractorStrength).div(dist.mul(dist).add(0.5));
  vel.addAssign(force.mul(dt));

  const centerDist = pos.length();
  const centerForce = pos.negate().normalize().mul(float(0.1).div(centerDist.add(1.0)));
  vel.addAssign(centerForce.mul(dt));

  vel.mulAssign(float(0.998));

  pos.addAssign(vel.mul(dt));
  life.subAssign(dt);

  If(life.lessThan(0), () => {
    const theta = hash(instanceIndex.add(time.mul(1000))).mul(Math.PI * 2);
    const phi = hash(instanceIndex.add(time.mul(1000)).add(1)).mul(Math.PI).sub(Math.PI / 2);
    const radius = hash(instanceIndex.add(time.mul(1000)).add(2)).mul(0.5);

    pos.x.assign(theta.cos().mul(phi.cos()).mul(radius));
    pos.y.assign(phi.sin().mul(radius));
    pos.z.assign(theta.sin().mul(phi.cos()).mul(radius));

    const speed = hash(instanceIndex.add(time.mul(1000)).add(3)).mul(1.0).add(0.5);
    const angle2 = hash(instanceIndex.add(time.mul(1000)).add(4)).mul(Math.PI * 2);
    vel.x.assign(angle2.cos().mul(speed).mul(0.5));
    vel.y.assign(speed);
    vel.z.assign(angle2.sin().mul(speed).mul(0.5));

    life.assign(hash(instanceIndex.add(time.mul(1000)).add(5)).mul(3.0).add(1.0));
  });
})().compute(PARTICLE_COUNT);

async function init() {
  if (!navigator.gpu) {
    document.getElementById('info').innerHTML =
      '<strong style="color:#f66">WebGPU not supported</strong><br>Try Chrome 113+ or Edge 113+';
    return;
  }

  clock = new THREE.Clock();

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  await renderer.init();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050510);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 3, 8);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(PARTICLE_COUNT * 3), 3));

  const material = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  material.positionNode = positions.element(instanceIndex);

  material.colorNode = Fn(() => {
    const life = lifetimes.element(instanceIndex);
    const vel = velocities.element(instanceIndex);
    const speed = vel.length();

    const hot = color(0xff6622);
    const cool = color(0x2244ff);
    const white = color(0xffffff);

    const speedFactor = clamp(speed.div(2.0), 0, 1);
    const baseColor = mix(cool, hot, speedFactor);
    const brightColor = mix(baseColor, white, clamp(speed.div(4.0), 0, 0.6));

    const fadeIn = clamp(float(3.5).sub(life).mul(4.0), 0, 1);
    const fadeOut = clamp(life.mul(2.0), 0, 1);

    return vec4(brightColor, fadeIn.mul(fadeOut).mul(0.7));
  })();

  material.sizeNode = Fn(() => {
    const life = lifetimes.element(instanceIndex);
    const vel = velocities.element(instanceIndex);
    const speed = vel.length();
    const base = clamp(speed.mul(1.5).add(1.0), 1.0, 4.0);
    const fade = clamp(life.mul(2.0), 0, 1);
    return base.mul(fade).mul(window.devicePixelRatio);
  })();

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  renderer.compute(computeInit);

  document.getElementById('count').textContent = PARTICLE_COUNT.toLocaleString();

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const intersection = new THREE.Vector3();

  window.addEventListener('pointerdown', (e) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    plane.normal.copy(camera.getWorldDirection(new THREE.Vector3()));
    plane.constant = 0;

    if (raycaster.ray.intersectPlane(plane, intersection)) {
      attractorPos.value.copy(intersection);
      attractorStrength.value = 8.0;
    }
  });

  window.addEventListener('pointerup', () => {
    attractorStrength.value = 0.0;
  });

  window.addEventListener('pointermove', (e) => {
    if (attractorStrength.value > 0) {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      if (raycaster.ray.intersectPlane(plane, intersection)) {
        attractorPos.value.copy(intersection);
      }
    }
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(animate);
}

function animate() {
  dt.value = Math.min(clock.getDelta(), 0.05);
  renderer.compute(computeUpdate);
  controls.update();
  renderer.render(scene, camera);
}

init();
