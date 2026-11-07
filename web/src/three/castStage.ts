import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Chibi, type ChibiPalette } from './characters/chibi';
import { CAST, castSpec, type CastRole } from './characters/presets';
import { createOutlineSettings, toon } from './materials/toon';

export type Motion = 'idle' | 'walk';

/** Space between characters: wide on a desktop, shoulder to shoulder on a phone. */
const SPACING_WIDE = 2.7;
const SPACING_NARROW = 1.72;
const STAGE_RADIUS = 5.7;

/** The /characters stage: the four characters side by side, with orbit controls. */
export class CastStage {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  private readonly controls: OrbitControls;
  private readonly outline = createOutlineSettings(0.032);
  private readonly cast = new Map<CastRole, Chibi>();
  private readonly spots: THREE.Mesh[] = [];
  private readonly floor: THREE.Group = new THREE.Group();
  private spacing = SPACING_WIDE;
  private readonly ro: ResizeObserver;
  private readonly timer = new THREE.Timer();
  private readonly host: HTMLElement;
  private userMoved = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);
    const touch = window.matchMedia('(pointer: coarse)').matches;
    this.renderer.domElement.setAttribute('aria-label', `The four characters. Drag to orbit, ${touch ? 'pinch' : 'scroll'} to zoom.`);

    this.camera.position.set(0, 3.1, 9.0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.0, 0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 18;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.5;
    this.controls.update();
    this.controls.addEventListener('start', () => (this.userMoved = true));

    this.scene.add(new THREE.HemisphereLight('#FFFFFF', '#D9D2F2', 1.9));
    const sun = new THREE.DirectionalLight('#FFF8EE', 1.6);
    sun.position.set(-4, 9, 7);
    this.scene.add(sun);

    // A soft round stage with a spot under each character. Its size follows the spacing.
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(STAGE_RADIUS, STAGE_RADIUS + 0.15, 0.3, 72), toon('#F3F7EC'));
    floor.position.y = -0.15;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(STAGE_RADIUS + 0.07, 0.09, 8, 96), toon('#CFEBBF'));
    rim.rotation.x = Math.PI / 2;
    this.floor.add(floor, rim);
    this.scene.add(this.floor);

    const spotColors = ['#E2DBFF', '#FFE0EA', '#D7F1EA', '#FFEBCB'];
    CAST.forEach((member, i) => {
      const spot = new THREE.Mesh(new THREE.CircleGeometry(1.05, 48), toon(spotColors[i]));
      spot.rotation.x = -Math.PI / 2;
      spot.position.y = 0.005;
      this.scene.add(spot);
      this.spots.push(spot);
      const chibi = new Chibi(castSpec(member.role), this.outline);
      this.scene.add(chibi.root);
      this.cast.set(member.role, chibi);
    });
    this.layout(SPACING_WIDE);

    this.timer.connect(document);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(this.frame);
  }

  setMotion(role: CastRole, motion: Motion) {
    const c = this.cast.get(role);
    if (!c) return;
    c.walking = motion === 'walk';
    // Walking in place reads best from three-quarter view.
    c.face(motion === 'walk' ? 0.62 : 0);
  }

  setPlayerPalette(p: ChibiPalette) {
    this.cast.get('player')?.setPalette(p);
  }

  hop(role: CastRole) {
    this.cast.get(role)?.hop(2);
  }

  /** Places the four in a row `spacing` apart and sizes the stage to fit them. */
  private layout(spacing: number) {
    this.spacing = spacing;
    CAST.forEach((member, i) => {
      const x = (i - (CAST.length - 1) / 2) * spacing;
      this.cast.get(member.role)?.root.position.set(x, 0, 0);
      this.spots[i].position.x = x;
      this.spots[i].scale.setScalar(Math.min(1, spacing / 2.1));
    });
    const k = Math.max(0.62, spacing / SPACING_WIDE);
    this.floor.scale.set(k, 1, k);
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // On a narrow screen the four stand shoulder to shoulder, so they can be bigger.
    const spacing = w / h < 1.3 ? SPACING_NARROW : SPACING_WIDE;
    if (spacing !== this.spacing) this.layout(spacing);
    // Keep all four in view: back off until the whole row fits the width.
    const halfSpan = ((CAST.length - 1) * spacing) / 2 + (spacing < SPACING_WIDE ? 1.05 : 1.7);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const fit = Math.max(spacing < SPACING_WIDE ? 7.5 : 9.5, halfSpan / (tanHalf * (w / h)) + 1.5);
    this.controls.maxDistance = Math.max(18, fit + 6);
    if (Math.abs(this.camera.position.distanceTo(this.controls.target) - fit) > 0.3 && !this.userMoved) {
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      this.camera.position.copy(this.controls.target).addScaledVector(dir, fit);
    }
    this.camera.updateProjectionMatrix();
  }

  private frame = () => {
    this.timer.update();
    const dt = this.timer.getDelta();
    for (const c of this.cast.values()) c.update(dt);
    this.controls.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.controls.dispose();
    for (const c of this.cast.values()) c.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.timer.dispose();
  }
}
