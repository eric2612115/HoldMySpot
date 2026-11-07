import { MercatorCoordinate } from 'maplibre-gl';
import * as THREE from 'three';

/**
 * A local flat frame in metres around an origin: +x east, +z south, +y up.
 * Good for a few kilometres, which is all a walking game needs. three.js
 * scenes live in this frame and are placed on the map with `toMercator`.
 */
export class LocalFrame {
  readonly origin: MercatorCoordinate;
  /** Mercator units per metre at the origin. */
  readonly scale: number;
  readonly toMercator: THREE.Matrix4;

  constructor(lngLat: [number, number]) {
    this.origin = MercatorCoordinate.fromLngLat(lngLat, 0);
    this.scale = this.origin.meterInMercatorCoordinateUnits();
    // three.js is y-up; mercator is z-up with y pointing south.
    this.toMercator = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(this.scale, -this.scale, this.scale))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  }

  toLocal(lng: number, lat: number): { x: number; z: number } {
    const m = MercatorCoordinate.fromLngLat([lng, lat], 0);
    return { x: (m.x - this.origin.x) / this.scale, z: (m.y - this.origin.y) / this.scale };
  }

  toLngLat(x: number, z: number): [number, number] {
    const ll = new MercatorCoordinate(this.origin.x + x * this.scale, this.origin.y + z * this.scale, 0).toLngLat();
    return [ll.lng, ll.lat];
  }
}

/** Unit vectors on the ground for a map bearing (degrees clockwise from north). */
export function bearingAxes(bearingDeg: number) {
  const b = (bearingDeg * Math.PI) / 180;
  // Forward: the direction the camera looks along the ground. North is -z.
  const forward = { x: Math.sin(b), z: -Math.cos(b) };
  const right = { x: Math.cos(b), z: Math.sin(b) };
  return { forward, right };
}
