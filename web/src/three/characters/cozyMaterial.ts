import * as THREE from 'three';

/**
 * The cozy cast's material: a light version of the film's soft plush. A
 * Lambert surface with wrapped diffuse (light rolls softly round the stuffed
 * forms, with a warm glow at the terminator) and a fabric sheen at the
 * silhouette, vertex colours for every part, and the painted face projected
 * from the head centre by angle, as the film paints it. Hair stays matte. The
 * stage (close-ups) adds the knit and fabric weaves of the clothes; the map
 * leaves them out (they are smaller than a pixel there).
 *
 * One program for every person in a scene: each instance has its own uniforms
 * (which face cell shows, tints), all instances share the shader.
 */

export interface CastMaterialOptions {
  /** The face atlas (neutral, blink, happy side by side), or null for no painted face. */
  face: THREE.Texture | null;
  /** Head centre in the bind pose (model units). */
  faceCenter: THREE.Vector3;
  /** The model's 16-bit positions: bind position = stored * half + centre. */
  dequant: { centre: [number, number, number]; half: number };
  faceSpan: [number, number];
  cells: number;
  /** Where the camera is, in the world the person stands in (the map's view matrix is not a camera's). */
  view: { value: THREE.Vector3 };
  /** Knit and fabric weaves on the clothes (close-ups only). */
  weave: boolean;
}

export interface CastUniforms {
  uFace: { value: THREE.Texture | null };
  uFaceCenter: { value: THREE.Vector3 };
  uFaceSpan: { value: THREE.Vector2 };
  uCell: { value: number };
  uCells: { value: number };
  uTintHair: { value: THREE.Color };
  uTintTop: { value: THREE.Color };
  uTintBottom: { value: THREE.Color };
  uView: { value: THREE.Vector3 };
  uWrap: { value: number };
  uWrapTint: { value: THREE.Color };
  uSheen: { value: number };
  uDeqCentre: { value: THREE.Vector3 };
  uDeqHalf: { value: number };
}

const WRAP = /* glsl */ `
	float yRaw = dot( geometryNormal, directLight.direction );
	float dotNL = saturate( ( yRaw + uWrap ) / ( 1.0 + uWrap ) );
	vec3 irradiance = dotNL * directLight.color * mix( uWrapTint, vec3( 1.0 ), smoothstep( -0.05, 0.55, yRaw ) );`;

const LAMBERT = THREE.ShaderChunk.lights_lambert_pars_fragment.replace(
  /float dotNL = saturate\( dot\( geometryNormal, directLight\.direction \) \);\s*vec3 irradiance = dotNL \* directLight\.color;/,
  WRAP,
);
if (LAMBERT === THREE.ShaderChunk.lights_lambert_pars_fragment) throw new Error('cast material: the Lambert lighting chunk changed; the wrap patch did not apply');

const COMMON_FRAG = /* glsl */ `
uniform sampler2D uFace;
uniform vec3 uFaceCenter;
uniform vec2 uFaceSpan;
uniform float uCell;
uniform float uCells;
uniform vec3 uTintHair;
uniform vec3 uTintTop;
uniform vec3 uTintBottom;
uniform vec3 uView;
uniform float uWrap;
uniform vec3 uWrapTint;
uniform float uSheen;
varying vec3 vBind;
varying vec3 vBindN;
varying vec3 vWorldP;
varying vec3 vWorldN;
varying vec4 vCast;
#ifdef CAST_WEAVE
float yRib( vec2 q ) { float s = cos( ( fract( q.x ) - 0.5 ) * 3.14159 ); return s * s; }
float yKnit( vec2 q ) {
  float s = fract( q.x ) - 0.5;
  float t = q.y * 1.15 + abs( s ) * 1.1;
  float col = cos( s * 3.14159 );
  col *= col;
  return col * ( 0.4 + 0.6 * ( 0.5 + 0.5 * cos( fract( t ) * 6.28318 ) ) );
}
float yTwill( vec2 q ) { return 0.5 + 0.5 * sin( ( q.x + q.y ) * 6.28318 ); }
float yWaffle( vec2 q ) { vec2 f = abs( fract( q ) - 0.5 ); return 1.0 - smoothstep( 0.28, 0.5, max( f.x, f.y ) ); }
float yCanvas( vec2 q ) { return 0.5 + 0.25 * ( sin( q.x * 6.28318 ) + sin( q.y * 6.28318 ) ); }
float yPattern( float kind, vec2 q ) {
  if ( kind < 1.5 ) return 0.5 + 0.25 * sin( q.x * 2.1 + q.y * 3.3 ) * sin( q.y * 2.7 - q.x * 1.3 );
  if ( kind < 2.5 ) return yKnit( q );
  if ( kind < 3.5 ) return yRib( q );
  if ( kind < 4.5 ) return yTwill( q );
  if ( kind < 5.5 ) return yWaffle( q );
  return yCanvas( q );
}
#endif
`;

const COLOR = /* glsl */ `
#include <color_fragment>
{
  // Recoloured slots (the player's hair, top and trousers).
  float sl = vCast.x;
  vec3 tint = vec3( 1.0 );
  tint = mix( tint, uTintHair, step( 1.5, sl ) * step( sl, 2.5 ) );
  tint = mix( tint, uTintTop, step( 2.5, sl ) * step( sl, 3.5 ) );
  tint = mix( tint, uTintBottom, step( 3.5, sl ) * step( sl, 4.5 ) );
  diffuseColor.rgb *= tint;
  // The painted face: angles from the head centre, exactly as the film projects it.
  vec3 fp = vBind - uFaceCenter;
  vec2 fuv = vec2( atan( fp.x, fp.z ) / uFaceSpan.x + 0.5, atan( fp.y, length( fp.xz ) ) / uFaceSpan.y + 0.5 );
  float inside = step( 0.0, fuv.x ) * step( fuv.x, 1.0 ) * step( 0.0, fuv.y ) * step( fuv.y, 1.0 ) * step( 0.5, sl ) * step( sl, 1.5 );
  vec2 cuv = vec2( ( uCell + clamp( fuv.x, 0.002, 0.998 ) ) / uCells, clamp( fuv.y, 0.0, 1.0 ) );
  vec4 fc = texture2D( uFace, cuv );
  diffuseColor.rgb = mix( diffuseColor.rgb, fc.rgb, fc.a * inside );
#ifdef CAST_WEAVE
  // Stitch and thread spacing per weave (fleece, knit, rib, denim, waffle, canvas), in figure units.
  float kind = vCast.y;
  float cell = kind < 1.5 ? 0.0034 : kind < 2.5 ? 0.0088 : kind < 3.5 ? 0.0062 : kind < 4.5 ? 0.0046 : kind < 5.5 ? 0.0085 : 0.0036;
  vec3 q = vBind / cell;
  // Out of the branch: derivatives need every pixel of the quad. The weave fades out before it could shimmer.
  float fade = 1.0 - smoothstep( 0.22, 0.55, length( fwidth( q ) ) );
  if ( kind > 0.5 && fade > 0.0 ) {
    float shade = kind < 1.5 ? 0.04 : kind < 2.5 ? 0.12 : kind < 3.5 ? 0.1 : kind < 4.5 ? 0.09 : kind < 5.5 ? 0.1 : 0.06;
    vec3 n = normalize( vBindN );
    vec3 w = pow( abs( n ), vec3( 4.0 ) );
    w /= ( w.x + w.y + w.z + 1e-5 );
    float h = w.z * yPattern( kind, q.xy ) + w.x * yPattern( kind, q.zy ) + w.y * yPattern( kind, q.xz );
    vec3 qr = vBind / ( cell * 0.72 );
    float r = w.z * yRib( qr.xy ) + w.x * yRib( qr.zy ) + w.y * yRib( qr.xz );
    h = mix( h, r, vCast.z );
    diffuseColor.rgb *= 1.0 + ( mix( 0.55, h, fade ) - 0.55 ) * shade * 2.0;
  }
#endif
}`;

const SHEEN = /* glsl */ `
vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
{
  // A soft fabric sheen where the surface turns away (hair keeps it faint: matte).
  vec3 V = normalize( uView - vWorldP );
  float rim = pow( 1.0 - saturate( dot( normalize( vWorldN ), V ) ), 3.0 );
  float hair = step( 1.5, vCast.x ) * step( vCast.x, 2.5 );
  outgoingLight += mix( diffuseColor.rgb, vec3( 1.0 ), 0.45 ) * rim * uSheen * mix( 1.0, 0.35, hair );
}`;

export function castMaterial(o: CastMaterialOptions): THREE.MeshLambertMaterial & { userData: { cast: CastUniforms } } {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const uniforms: CastUniforms = {
    uFace: { value: o.face },
    uFaceCenter: { value: o.faceCenter.clone() },
    uFaceSpan: { value: new THREE.Vector2(...o.faceSpan) },
    uCell: { value: 0 },
    uCells: { value: o.cells },
    uTintHair: { value: new THREE.Color(1, 1, 1) },
    uTintTop: { value: new THREE.Color(1, 1, 1) },
    uTintBottom: { value: new THREE.Color(1, 1, 1) },
    uView: o.view,
    uWrap: { value: 0.38 },
    uWrapTint: { value: new THREE.Color('#ffd2c4') },
    uSheen: { value: 0.22 },
    uDeqCentre: { value: new THREE.Vector3(...o.dequant.centre) },
    uDeqHalf: { value: o.dequant.half },
  };
  mat.userData.cast = uniforms;
  if (o.weave) (mat as unknown as { defines: Record<string, string> }).defines = { CAST_WEAVE: '' };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 castData;\nuniform vec3 uDeqCentre;\nuniform float uDeqHalf;\nvarying vec3 vBind;\nvarying vec3 vBindN;\nvarying vec3 vWorldP;\nvarying vec3 vWorldN;\nvarying vec4 vCast;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position * uDeqHalf + uDeqCentre;\nvBindN = normal;\nvCast = vec4( castData.x, castData.y, castData.z / 255.0, castData.w );')
      .replace('#include <skinning_vertex>', '#include <skinning_vertex>\nvWorldP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvWorldN = normalize( ( modelMatrix * vec4( objectNormal, 0.0 ) ).xyz );');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON_FRAG}`)
      .replace('#include <lights_lambert_pars_fragment>', LAMBERT)
      .replace('#include <color_fragment>', COLOR)
      .replace('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', SHEEN);
  };
  mat.customProgramCacheKey = () => `cozy-cast-${o.weave ? 'weave' : 'plain'}`;
  return mat as THREE.MeshLambertMaterial & { userData: { cast: CastUniforms } };
}
