import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/** Clear late-afternoon sky over Manhattan: physical sky dome, sun with a shadow box that follows the car, and a matching reflection map. */
export class CitySky {
  readonly sky = new Sky();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sunDir = new THREE.Vector3();
  env!: THREE.Texture;

  constructor(
    scene: THREE.Scene,
    private renderer: THREE.WebGLRenderer,
    elevationDeg = 32,
    azimuthDeg = 235,
  ) {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    this.sky.scale.setScalar(6000); // inside the camera's far plane (7 km)
    const u = this.sky.material.uniforms;
    u.turbidity.value = 3;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(this.sunDir);
    // pure background: drawn first, never depth-tested. Its "z = w" far-plane trick doesn't mix with the
    // logarithmic depth buffer, and without this it paints haze over buildings a few hundred metres away.
    // the physical sky is far brighter than the bloom threshold, so the whole sky glowed and smeared haze over
    // the city; scale it down (the sun disc stays bright enough to bloom)
    this.sky.material.fragmentShader = this.sky.material.fragmentShader.replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      'gl_FragColor = vec4( min( texColor * 0.34, vec3( 2.2 ) ), 1.0 );', // and cap the sun disc
    );
    this.sky.material.needsUpdate = true;
    this.sky.material.depthTest = false;
    this.sky.material.depthWrite = false;
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffe4c2, 3.0);
    this.sun.castShadow = true;
    const cam = this.sun.shadow.camera;
    cam.left = -130;
    cam.right = 130;
    cam.top = 130;
    cam.bottom = -130;
    cam.near = 10;
    cam.far = 1400;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xdfe5ec, 0x6b6259, 0.5);
    scene.add(this.hemi);

    scene.fog = new THREE.Fog(0xcbd3da, 1500, 6800);

    // reflections: render the sky alone into a PMREM
    const pm = new THREE.PMREMGenerator(renderer);
    const s = new THREE.Scene();
    const sky2 = new Sky();
    sky2.scale.setScalar(1000);
    Object.assign(sky2.material.uniforms, THREE.UniformsUtils.clone(this.sky.material.uniforms));
    sky2.material.uniforms.sunPosition.value.copy(this.sunDir);
    s.add(sky2);
    // a dim ground so reflections don't show sky underneath
    const g = new THREE.Mesh(new THREE.CircleGeometry(900, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3a3a3c }));
    g.position.y = -5;
    s.add(g);
    this.env = pm.fromScene(s, 0.02).texture;
    scene.environment = this.env;
    // the physical sky is very bright (it's meant for low exposure); scale its reflections down to match the sun
    scene.environmentIntensity = 0.28;
    pm.dispose();
  }

  /** keep the shadow box centred on the car, snapped to shadow texels so it doesn't shimmer */
  follow(p: THREE.Vector3, eye?: THREE.Vector3) {
    // the sky dome is 6 km across; keep it centred on the camera so the far ends of the island still have a sky
    if (eye) this.sky.position.copy(eye);
    const texel = 260 / this.sun.shadow.mapSize.x;
    const cx = Math.round(p.x / texel) * texel, cz = Math.round(p.z / texel) * texel;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx, 0, cz).addScaledVector(this.sunDir, 700);
    this.sun.target.updateMatrixWorld();
  }
}
