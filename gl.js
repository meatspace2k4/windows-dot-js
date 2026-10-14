'use strict';
// OpenGL 1.1 installable client driver for recompiled guest code, on WebGL2.
// Plays the role a vendor ICD played under Windows 95: the guest's opengl32 imports land
// here and are executed on the GPU. Fixed-function transform and lighting are implemented
// in shaders following the GL 1.1 equations; display lists keep their geometry in GPU buffers.
(() => {
const { def, dcOf, GuestError } = window.W95Win32;

// ---------------------------------------------------------------- argument decoding
// sig: one char per parameter: i = int32, u = uint32, f = float, d = double, p = pointer
const f32 = new Float32Array(1), u32v = new Uint32Array(f32.buffer);
const f64 = new Float64Array(1), u32d = new Uint32Array(f64.buffer);
const asF = v => { u32v[0] = v; return f32[0]; };
const asD = (lo, hi) => { u32d[0] = lo; u32d[1] = hi; return f64[0]; };
const FN = {};      // raw-argument entry points, for calls made from inside this driver
const fbits = v => { f32[0] = v; return u32v[0]; };
const dbits = v => { f64[0] = v; return [u32d[0], u32d[1]]; };
function gl(name, sig, fn) {
  const n = [...sig].reduce((a, c) => a + (c === 'd' ? 2 : 1), 0);
  def('OPENGL32', name, n, FN[name] = function (...raw) {
    const a = []; let k = 0;
    for (const c of sig) {
      if (c === 'd') { a.push(asD(raw[k], raw[k + 1])); k += 2; }
      else { const v = raw[k++]; a.push(c === 'f' ? asF(v) : c === 'i' ? v | 0 : v >>> 0); }
    }
    const ctx = this.glctx;
    if (!ctx && !name.startsWith('wgl')) return 0;
    return fn.call(this, ctx, ...a);
  });
}
const rdF = (p, a, n) => Array.from({ length: n }, (_, i) => p.dv.getFloat32(a + 4 * i, true));
const rdD = (p, a, n) => Array.from({ length: n }, (_, i) => p.dv.getFloat64(a + 8 * i, true));
const rdI = (p, a, n) => Array.from({ length: n }, (_, i) => p.dv.getInt32(a + 4 * i, true));

// ---------------------------------------------------------------- GL enums used here
const E = {
  POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6, QUADS: 7, QUAD_STRIP: 8, POLYGON: 9,
  COMPILE: 0x1300, COMPILE_AND_EXECUTE: 0x1301, MODELVIEW: 0x1700, PROJECTION: 0x1701, TEXTURE: 0x1702,
  FRONT: 0x404, BACK: 0x405, FRONT_AND_BACK: 0x408, POINT: 0x1B00, LINE: 0x1B01, FILL: 0x1B02, FLAT: 0x1D00, SMOOTH: 0x1D01,
  AMBIENT: 0x1200, DIFFUSE: 0x1201, SPECULAR: 0x1202, POSITION: 0x1203, SPOT_DIRECTION: 0x1204, SPOT_EXPONENT: 0x1205, SPOT_CUTOFF: 0x1206,
  CONSTANT_ATTENUATION: 0x1207, LINEAR_ATTENUATION: 0x1208, QUADRATIC_ATTENUATION: 0x1209, EMISSION: 0x1600, SHININESS: 0x1601, AMBIENT_AND_DIFFUSE: 0x1602,
  LIGHT_MODEL_LOCAL_VIEWER: 0x0B51, LIGHT_MODEL_TWO_SIDE: 0x0B52, LIGHT_MODEL_AMBIENT: 0x0B53,
  LIGHTING: 0x0B50, LIGHT0: 0x4000, CULL_FACE: 0x0B44, DEPTH_TEST: 0x0B71, NORMALIZE: 0x0BA1, TEXTURE_2D: 0x0DE1, TEXTURE_1D: 0x0DE0,
  COLOR_MATERIAL: 0x0B57, BLEND: 0x0BE2, SCISSOR_TEST: 0x0C11, AUTO_NORMAL: 0x0D80, DITHER: 0x0BD0, ALPHA_TEST: 0x0BC0, FOG: 0x0B60,
  TEXTURE_GEN_S: 0x0C60, TEXTURE_GEN_T: 0x0C61, TEXTURE_GEN_R: 0x0C62, TEXTURE_GEN_Q: 0x0C63, POLYGON_OFFSET_FILL: 0x8037,
  MAP2_VERTEX_3: 0x0DB7, MAP2_VERTEX_4: 0x0DB8, MAP2_NORMAL: 0x0DB2, MAP2_TEXTURE_COORD_2: 0x0DB4, MAP2_COLOR_4: 0x0DB0,
  MAP1_VERTEX_3: 0x0D97, MAP1_VERTEX_4: 0x0D98, MAP1_NORMAL: 0x0D92, MAP1_TEXTURE_COORD_2: 0x0D94,
  S: 0x2000, T: 0x2001, R: 0x2002, Q: 0x2003, TEXTURE_GEN_MODE: 0x2500, OBJECT_PLANE: 0x2501, EYE_PLANE: 0x2502,
  EYE_LINEAR: 0x2400, OBJECT_LINEAR: 0x2401, SPHERE_MAP: 0x2402,
  TEXTURE_ENV_MODE: 0x2200, TEXTURE_ENV_COLOR: 0x2201, MODULATE: 0x2100, DECAL: 0x2101, REPLACE: 0x1E01, BLEND_ENV: 0x0BE2,
  TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, CLAMP: 0x2900, REPEAT: 0x2901,
  UNPACK_ALIGNMENT: 0x0CF5, UNPACK_ROW_LENGTH: 0x0CF2, UNPACK_SKIP_ROWS: 0x0CF3, UNPACK_SKIP_PIXELS: 0x0CF4,
  COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100,
  VERTEX_ARRAY: 0x8074, NORMAL_ARRAY: 0x8075, COLOR_ARRAY: 0x8076, TEXTURE_COORD_ARRAY: 0x8078,
  BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406, DOUBLE: 0x140A,
  RGB: 0x1907, RGBA: 0x1908, LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190A, ALPHA: 0x1906, BGR_EXT: 0x80E0, BGRA_EXT: 0x80E1, COLOR_INDEX: 0x1900,
  V2F: 0x2A20, V3F: 0x2A21, C4UB_V2F: 0x2A22, C4UB_V3F: 0x2A23, C3F_V3F: 0x2A24, N3F_V3F: 0x2A25, C4F_N3F_V3F: 0x2A26, T2F_V3F: 0x2A27,
  T4F_V4F: 0x2A28, T2F_C4UB_V3F: 0x2A29, T2F_C3F_V3F: 0x2A2A, T2F_N3F_V3F: 0x2A2B, T2F_C4F_N3F_V3F: 0x2A2C, T4F_C4F_N3F_V4F: 0x2A2D,
  CW: 0x900, CCW: 0x901,
};

// ---------------------------------------------------------------- matrices (column-major, like GL)
const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
}
function rotate(ang, x, y, z) {
  const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
  const c = Math.cos(ang * Math.PI / 180), s = Math.sin(ang * Math.PI / 180), t = 1 - c;
  return [x * x * t + c, y * x * t + z * s, x * z * t - y * s, 0, x * y * t - z * s, y * y * t + c, y * z * t + x * s, 0,
    x * z * t + y * s, y * z * t - x * s, z * z * t + c, 0, 0, 0, 0, 1];
}
// normal matrix: transpose of the inverse of the upper 3x3 (column-major in and out)
function inverse3T(m) {
  const inv = invert4(m), out = new Array(9);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 3 + r] = inv[r * 4 + c];
  return out;
}
function xform(m, v) { return [0, 1, 2, 3].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]); }
function invert4(m) {
  const inv = new Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12] || 1;
  return inv.map(v => v / det);
}

// ---------------------------------------------------------------- shaders
const VS = `#version 300 es
precision highp float;
in vec4 aPos; in vec3 aNrm; in vec4 aCol; in vec4 aTex;
uniform mat4 uMV, uP, uTM; uniform mat3 uNM;
uniform bool uLighting, uNormalize, uTwoSide, uLocal, uColorMat;
uniform int uCMFace, uCMMode;
uniform vec4 uLMAmb;
uniform vec4 uMat[8];     // front amb dif spec emi, back amb dif spec emi
uniform float uShin[2];
uniform bool uLOn[8];
uniform vec4 uLPos[8], uLAmb[8], uLDif[8], uLSpec[8];
uniform vec4 uLSpot[8];   // dir.xyz, exponent
uniform vec4 uLAtt[8];    // k0 k1 k2 cutoff(deg)
uniform ivec4 uTGMode;    // per coord S T R Q: 0 off, 1 object, 2 eye, 3 sphere
uniform vec4 uTGObj[4], uTGEye[4];
OUTQ vec4 vFront; OUTQ vec4 vBack; out vec4 vTex;
vec4 shade(vec3 P, vec3 N, int f) {
  vec4 ma = uMat[f * 4], md = uMat[f * 4 + 1], ms = uMat[f * 4 + 2], me = uMat[f * 4 + 3];
  if (uColorMat && (uCMFace == 2 || uCMFace == f)) {
    if (uCMMode == 0 || uCMMode == 1) ma = aCol;
    if (uCMMode == 0 || uCMMode == 2) md = aCol;
    if (uCMMode == 3) ms = aCol;
    if (uCMMode == 4) me = aCol;
  }
  vec3 c = me.rgb + ma.rgb * uLMAmb.rgb;
  for (int i = 0; i < 8; i++) {
    if (!uLOn[i]) continue;
    vec3 L; float att = 1.0;
    if (uLPos[i].w == 0.0) L = normalize(uLPos[i].xyz);
    else {
      vec3 d = uLPos[i].xyz / uLPos[i].w - P; float dl = length(d); L = d / max(dl, 1e-6);
      att = 1.0 / max(uLAtt[i].x + uLAtt[i].y * dl + uLAtt[i].z * dl * dl, 1e-6);
    }
    if (uLAtt[i].w != 180.0) {
      float cs = dot(-L, normalize(uLSpot[i].xyz));
      att *= cs < cos(radians(uLAtt[i].w)) ? 0.0 : pow(max(cs, 0.0), uLSpot[i].w);
    }
    float nl = dot(N, L);
    vec3 col = uLAmb[i].rgb * ma.rgb + max(nl, 0.0) * uLDif[i].rgb * md.rgb;
    if (nl > 0.0) {
      vec3 H = normalize(L + (uLocal ? normalize(-P) : vec3(0.0, 0.0, 1.0)));
      float nh = max(dot(N, H), 0.0);
      col += (uShin[f] == 0.0 ? 1.0 : pow(nh, uShin[f])) * uLSpec[i].rgb * ms.rgb;
    }
    c += att * col;
  }
  return vec4(clamp(c, 0.0, 1.0), clamp(md.a, 0.0, 1.0));
}
float tg(int m, vec4 obj, vec4 eye, vec4 P, vec3 N, int axis, float src) {
  if (m == 1) return dot(aPos, obj);
  if (m == 2) return dot(P, eye);
  if (m == 3) {
    vec3 u = normalize(P.xyz); vec3 r = reflect(u, N);
    float k = 2.0 * sqrt(r.x * r.x + r.y * r.y + (r.z + 1.0) * (r.z + 1.0));
    return (axis == 0 ? r.x : r.y) / k + 0.5;
  }
  return src;
}
void main() {
  vec4 P = uMV * aPos;
  vec3 N = uNM * aNrm;
  if (uNormalize) N = normalize(N);
  if (uLighting) { vFront = shade(P.xyz, N, 0); vBack = uTwoSide ? shade(P.xyz, -N, 1) : vFront; }
  else { vFront = aCol; vBack = aCol; }
  vec4 t = aTex;
  t.s = tg(uTGMode.x, uTGObj[0], uTGEye[0], P, normalize(N), 0, t.s);
  t.t = tg(uTGMode.y, uTGObj[1], uTGEye[1], P, normalize(N), 1, t.t);
  vTex = uTM * t;
  gl_Position = uP * P;
  gl_PointSize = 1.0;
}`;
const FS = `#version 300 es
precision highp float;
INQ vec4 vFront; INQ vec4 vBack; in vec4 vTex;
uniform bool uTexOn, uTwoSide; uniform int uTexEnv; uniform vec4 uTexEnvColor; uniform sampler2D uTex;
uniform int uTexFmt;  // 0 rgba 1 rgb 2 luminance 3 luminance_alpha 4 alpha
out vec4 o;
void main() {
  vec4 c = (!uTwoSide || gl_FrontFacing) ? vFront : vBack;
  if (uTexOn) {
    vec4 t = texture(uTex, vTex.st / (vTex.q == 0.0 ? 1.0 : vTex.q));
    if (uTexEnv == 0) c = c * t;                                     // MODULATE
    else if (uTexEnv == 1) c = vec4(mix(c.rgb, t.rgb, uTexFmt == 1 ? 1.0 : t.a), c.a); // DECAL
    else if (uTexEnv == 2) c = t;                                    // REPLACE
    else c = vec4(mix(c.rgb, uTexEnvColor.rgb, t.rgb), c.a * t.a);   // BLEND
  }
  o = c;
}`;

// ---------------------------------------------------------------- context
const STRIDE = 15;  // pos4 nrm3 col4 tex4
class Context {
  constructor(proc, dc) {
    this.p = proc;
    const w = Math.max(1, dc.w), h = Math.max(1, dc.h);
    this.canvas = document.createElement('canvas'); this.canvas.width = w; this.canvas.height = h;
    const g = this.g = this.canvas.getContext('webgl2', { antialias: false, depth: true, stencil: false, alpha: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!g) throw new GuestError('WebGL2 is not available');
    this.progs = { smooth: this.program('out', 'in'), flat: this.program('flat out', 'flat in') };
    this.vbo = g.createBuffer(); this.vao = g.createVertexArray();
    g.bindVertexArray(this.vao); g.bindBuffer(g.ARRAY_BUFFER, this.vbo);
    const loc = this.progs.smooth.attr;
    [['aPos', 4, 0], ['aNrm', 3, 4], ['aCol', 4, 7], ['aTex', 4, 11]].forEach(([n, sz, off]) => {
      g.enableVertexAttribArray(loc[n]); g.vertexAttribPointer(loc[n], sz, g.FLOAT, false, STRIDE * 4, off * 4);
    });
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    this.reset(w, h);
  }
  program(o, i) {
    const g = this.g, mk = (t, src) => { const s = g.createShader(t); g.shaderSource(s, src); g.compileShader(s); if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s)); return s; };
    const p = g.createProgram();
    g.attachShader(p, mk(g.VERTEX_SHADER, VS.replace(/OUTQ/g, o)));
    g.attachShader(p, mk(g.FRAGMENT_SHADER, FS.replace(/INQ/g, i)));
    ['aPos', 'aNrm', 'aCol', 'aTex'].forEach((n, k) => g.bindAttribLocation(p, k, n));
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p));
    const u = {}, n = g.getProgramParameter(p, g.ACTIVE_UNIFORMS);
    for (let k = 0; k < n; k++) { const info = g.getActiveUniform(p, k), nm = info.name.replace(/\[0\]$/, ''); u[nm] = g.getUniformLocation(p, nm); }
    return { p, u, attr: { aPos: 0, aNrm: 1, aCol: 2, aTex: 3 } };
  }
  reset(w, h) {
    this.mv = [ident()]; this.pj = [ident()]; this.tx = [ident()]; this.mode = E.MODELVIEW;
    this.cap = new Set([E.DITHER]);
    this.normal = [0, 0, 1]; this.color = [1, 1, 1, 1]; this.tex = [0, 0, 0, 1];
    this.mat = [[0.2, 0.2, 0.2, 1], [0.8, 0.8, 0.8, 1], [0, 0, 0, 1], [0, 0, 0, 1], [0.2, 0.2, 0.2, 1], [0.8, 0.8, 0.8, 1], [0, 0, 0, 1], [0, 0, 0, 1]];
    this.shin = [0, 0];
    this.lights = Array.from({ length: 8 }, (_, i) => ({ amb: [0, 0, 0, 1], dif: i ? [0, 0, 0, 1] : [1, 1, 1, 1], spec: i ? [0, 0, 0, 1] : [1, 1, 1, 1],
      pos: [0, 0, 1, 0], dir: [0, 0, -1], exp: 0, cut: 180, att: [1, 0, 0] }));
    this.lmAmb = [0.2, 0.2, 0.2, 1]; this.twoSide = false; this.local = false;
    this.cmFace = E.FRONT_AND_BACK; this.cmMode = E.AMBIENT_AND_DIFFUSE;
    this.shade = E.SMOOTH; this.polyMode = [E.FILL, E.FILL]; this.cullFace = E.BACK; this.frontFace = E.CCW;
    this.depthFunc = 0x201; this.blend = [1, 0];
    this.clearColor = [0, 0, 0, 0]; this.clearDepth = 1;
    this.viewport = [0, 0, w, h]; this.scissor = [0, 0, w, h];
    this.texEnv = E.MODULATE; this.texEnvColor = [0, 0, 0, 0];
    this.tgMode = [E.EYE_LINEAR, E.EYE_LINEAR, E.EYE_LINEAR, E.EYE_LINEAR];
    this.tgObj = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]; this.tgEye = this.tgObj.map(v => v.slice());
    this.textures = new Map(); this.texBound = 0; this.nextTex = 1;
    this.lists = new Map(); this.nextList = 1; this.listBase = 0; this.compiling = null; this.compileMode = 0;
    this.prim = null; this.unpack = { align: 4, row: 0, skipRows: 0, skipPixels: 0 };
    // all pixel-store parameters, GL defaults: SWAP_BYTES, LSB_FIRST, ROW_LENGTH, SKIP_ROWS, SKIP_PIXELS, ALIGNMENT for unpack (0x0CF0..) and pack (0x0D00..)
    this.pixelStore = { 0x0CF0: 0, 0x0CF1: 0, 0x0CF2: 0, 0x0CF3: 0, 0x0CF4: 0, 0x0CF5: 4, 0x0D00: 0, 0x0D01: 0, 0x0D02: 0, 0x0D03: 0, 0x0D04: 0, 0x0D05: 4 };
    this.arrays = { v: null, n: null, c: null, t: null, on: new Set() };
    this.maps = new Map(); this.grid1 = [1, 0, 1]; this.grid2 = [1, 0, 1, 1, 0, 1];
    this.attribStack = [];
  }
  get M() { return this.mode === E.MODELVIEW ? this.mv : this.mode === E.PROJECTION ? this.pj : this.tx; }
  top() { const s = this.M; return s[s.length - 1]; }
  setTop(m) { const s = this.M; s[s.length - 1] = m; }
  // record into the display list being compiled; returns true if the call should not run now
  rec(fn, ...args) {
    if (!this.compiling) return false;
    this.compiling.push([fn, args]);
    return this.compileMode === E.COMPILE;
  }
  // ---- drawing
  emit(mode, verts) {
    // verts: array of {p:[4], n:[3], c:[4], t:[4]} -> triangles/lines in a flat Float32Array
    const out = [], push = v => out.push(...v.p, ...v.n, ...v.c, ...v.t);
    const fillMode = this.polyMode[0], isPoly = mode >= E.TRIANGLES;
    let prim = 'tri';
    const tri = (a, b, c) => { push(verts[a]); push(verts[b]); push(verts[c]); };
    const edge = (a, b) => { push(verts[a]); push(verts[b]); };
    const n = verts.length;
    if (isPoly && fillMode !== E.FILL) {
      prim = fillMode === E.LINE ? 'line' : 'point';
      const ring = (ids) => { if (prim === 'point') ids.forEach(i => push(verts[i])); else ids.forEach((id, k) => edge(id, ids[(k + 1) % ids.length])); };
      if (mode === E.TRIANGLES) for (let i = 0; i + 2 < n; i += 3) ring([i, i + 1, i + 2]);
      else if (mode === E.TRIANGLE_STRIP) for (let i = 0; i + 2 < n; i++) ring([i, i + 1, i + 2]);
      else if (mode === E.TRIANGLE_FAN) for (let i = 1; i + 1 < n; i++) ring([0, i, i + 1]);
      else if (mode === E.QUADS) for (let i = 0; i + 3 < n; i += 4) ring([i, i + 1, i + 2, i + 3]);
      else if (mode === E.QUAD_STRIP) for (let i = 0; i + 3 < n; i += 2) ring([i, i + 1, i + 3, i + 2]);
      else ring([...Array(n).keys()]);
      return { prim, data: new Float32Array(out) };
    }
    switch (mode) {
      case E.POINTS: prim = 'point'; verts.forEach(push); break;
      case E.LINES: prim = 'line'; for (let i = 0; i + 1 < n; i += 2) edge(i, i + 1); break;
      case E.LINE_STRIP: prim = 'line'; for (let i = 0; i + 1 < n; i++) edge(i, i + 1); break;
      case E.LINE_LOOP: prim = 'line'; for (let i = 0; i < n && n > 1; i++) edge(i, (i + 1) % n); break;
      case E.TRIANGLES: for (let i = 0; i + 2 < n; i += 3) tri(i, i + 1, i + 2); break;
      case E.TRIANGLE_STRIP: for (let i = 0; i + 2 < n; i++) (i & 1) ? tri(i + 1, i, i + 2) : tri(i, i + 1, i + 2); break;
      case E.TRIANGLE_FAN: for (let i = 1; i + 1 < n; i++) tri(0, i, i + 1); break;
      case E.QUADS: for (let i = 0; i + 3 < n; i += 4) { tri(i, i + 1, i + 3); tri(i + 1, i + 2, i + 3); } break;
      case E.QUAD_STRIP: for (let i = 0; i + 3 < n; i += 2) { tri(i, i + 1, i + 3); tri(i + 2, i, i + 3); } break;
      case E.POLYGON: for (let i = 1; i + 1 < n; i++) tri(i, i + 1, 0); break;
    }
    return { prim, data: new Float32Array(out) };
  }
  fitDrawable() {
    const w = this.dc && this.dc.win();
    if (w && (w.w !== this.canvas.width || w.h !== this.canvas.height) && w.w > 0 && w.h > 0) { this.canvas.width = w.w; this.canvas.height = w.h; }
  }
  draw(geo) {
    if (!geo.data.length) return;
    const g = this.g, P = this.shade === E.FLAT ? this.progs.flat : this.progs.smooth, u = P.u;
    g.useProgram(P.p);
    const mv = this.mv[this.mv.length - 1];
    g.uniformMatrix4fv(u.uMV, false, mv); g.uniformMatrix4fv(u.uP, false, this.pj[this.pj.length - 1]); g.uniformMatrix4fv(u.uTM, false, this.tx[this.tx.length - 1]);
    g.uniformMatrix3fv(u.uNM, false, inverse3T(mv));
    const on = c => this.cap.has(c);
    g.uniform1i(u.uLighting, on(E.LIGHTING)); g.uniform1i(u.uNormalize, on(E.NORMALIZE)); g.uniform1i(u.uTwoSide, this.twoSide && on(E.LIGHTING));
    g.uniform1i(u.uLocal, this.local); g.uniform1i(u.uColorMat, on(E.COLOR_MATERIAL));
    g.uniform1i(u.uCMFace, this.cmFace === E.FRONT ? 0 : this.cmFace === E.BACK ? 1 : 2);
    g.uniform1i(u.uCMMode, { [E.AMBIENT_AND_DIFFUSE]: 0, [E.AMBIENT]: 1, [E.DIFFUSE]: 2, [E.SPECULAR]: 3, [E.EMISSION]: 4 }[this.cmMode] ?? 0);
    g.uniform4fv(u.uLMAmb, this.lmAmb); g.uniform4fv(u.uMat, this.mat.flat()); g.uniform1fv(u.uShin, this.shin);
    if (on(E.LIGHTING)) {
      const L = this.lights;
      g.uniform1iv(u.uLOn, L.map((l, i) => on(E.LIGHT0 + i) ? 1 : 0));
      g.uniform4fv(u.uLPos, L.flatMap(l => l.pos)); g.uniform4fv(u.uLAmb, L.flatMap(l => l.amb));
      g.uniform4fv(u.uLDif, L.flatMap(l => l.dif)); g.uniform4fv(u.uLSpec, L.flatMap(l => l.spec));
      g.uniform4fv(u.uLSpot, L.flatMap(l => [...l.dir, l.exp])); g.uniform4fv(u.uLAtt, L.flatMap(l => [...l.att, l.cut]));
    }
    const tgm = [E.TEXTURE_GEN_S, E.TEXTURE_GEN_T, E.TEXTURE_GEN_R, E.TEXTURE_GEN_Q].map((c, i) => on(c) ? { [E.OBJECT_LINEAR]: 1, [E.EYE_LINEAR]: 2, [E.SPHERE_MAP]: 3 }[this.tgMode[i]] : 0);
    g.uniform4iv(u.uTGMode, tgm); g.uniform4fv(u.uTGObj, this.tgObj.flat()); g.uniform4fv(u.uTGEye, this.tgEye.flat());
    const tex = on(E.TEXTURE_2D) && this.textures.get(this.texBound);
    g.uniform1i(u.uTexOn, !!(tex && tex.ready));
    if (tex && tex.ready) {
      g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, tex.t); g.uniform1i(u.uTex, 0); g.uniform1i(u.uTexFmt, tex.fmt);
      g.uniform1i(u.uTexEnv, { [E.MODULATE]: 0, [E.DECAL]: 1, [E.REPLACE]: 2, [E.BLEND_ENV]: 3 }[this.texEnv] ?? 0); g.uniform4fv(u.uTexEnvColor, this.texEnvColor);
    }
    this.applyState();
    g.bindVertexArray(this.vao);
    if (geo.buf) g.bindBuffer(g.ARRAY_BUFFER, geo.buf);
    else { g.bindBuffer(g.ARRAY_BUFFER, this.vbo); g.bufferData(g.ARRAY_BUFFER, geo.data, g.STREAM_DRAW); }
    [['aPos', 4, 0], ['aNrm', 3, 4], ['aCol', 4, 7], ['aTex', 4, 11]].forEach(([n, sz, off], k) => g.vertexAttribPointer(k, sz, g.FLOAT, false, STRIDE * 4, off * 4));
    g.drawArrays(geo.prim === 'tri' ? g.TRIANGLES : geo.prim === 'line' ? g.LINES : g.POINTS, 0, geo.data.length / STRIDE);
  }
  applyState() {
    const g = this.g, on = c => this.cap.has(c);
    on(E.DEPTH_TEST) ? g.enable(g.DEPTH_TEST) : g.disable(g.DEPTH_TEST);
    g.depthFunc(this.depthFunc);
    on(E.CULL_FACE) ? g.enable(g.CULL_FACE) : g.disable(g.CULL_FACE);
    g.cullFace(this.cullFace); g.frontFace(this.frontFace);
    on(E.BLEND) ? g.enable(g.BLEND) : g.disable(g.BLEND);
    g.blendFunc(this.blend[0], this.blend[1]);
    on(E.SCISSOR_TEST) ? g.enable(g.SCISSOR_TEST) : g.disable(g.SCISSOR_TEST);
    g.scissor(...this.scissor); g.viewport(...this.viewport);
  }
  vertex(p) {
    if (this.prim) this.prim.verts.push({ p, n: this.normal.slice(), c: this.color.slice(), t: this.tex.slice() });
  }
  end() {
    const pr = this.prim; this.prim = null; if (!pr) return;
    const geo = this.emit(pr.mode, pr.verts);
    if (this.compiling) {
      this.compiling.push(['geo', [geo]]);
      if (this.compileMode === E.COMPILE) return;
    }
    this.draw(geo);
  }
  callList(id) {
    const L = this.lists.get(id); if (!L) return;
    for (const [fn, args] of L) {
      if (fn === 'geo') {
        const geo = args[0];
        if (!geo.buf && geo.data.length) { geo.buf = this.g.createBuffer(); this.g.bindBuffer(this.g.ARRAY_BUFFER, geo.buf); this.g.bufferData(this.g.ARRAY_BUFFER, geo.data, this.g.STATIC_DRAW); }
        if (this.compiling) { this.compiling.push(['geo', [geo]]); if (this.compileMode === E.COMPILE) continue; }
        this.draw(geo);
      } else OPS[fn].apply(this, args);
    }
  }
  // Copy the rendered frame into the window's current rectangle on its GDI surface.
  present() {
    const dc = this.dc; if (!dc || !dc.ctx) return;
    this.g.flush();
    const g = dc.pre(); g.drawImage(this.canvas, 0, 0); dc.post(); dc.touch();
    if (dc.bitmap && dc.bitmap.dib) window.W95Win32.dibOut(this.p, dc.bitmap);
  }
}

// ---------------------------------------------------------------- operations (also replayed from display lists)
const OPS = {
  matrixMode(m) { this.mode = m; },
  loadIdentity() { this.setTop(ident()); },
  loadMatrix(m) { this.setTop(m); },
  multMatrix(m) { this.setTop(mul(this.top(), m)); },
  pushMatrix() { const s = this.M; s.push(s[s.length - 1].slice()); },
  popMatrix() { const s = this.M; if (s.length > 1) s.pop(); },
  rotate(a, x, y, z) { this.setTop(mul(this.top(), rotate(a, x, y, z))); },
  translate(x, y, z) { this.setTop(mul(this.top(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1])); },
  scale(x, y, z) { this.setTop(mul(this.top(), [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1])); },
  frustum(l, r, b, t, n, f) { this.setTop(mul(this.top(), [2 * n / (r - l), 0, 0, 0, 0, 2 * n / (t - b), 0, 0, (r + l) / (r - l), (t + b) / (t - b), -(f + n) / (f - n), -1, 0, 0, -2 * f * n / (f - n), 0])); },
  ortho(l, r, b, t, n, f) { this.setTop(mul(this.top(), [2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1])); },
  enable(c) { this.cap.add(c); },
  disable(c) { this.cap.delete(c); },
  begin(m) { this.prim = { mode: m, verts: [] }; },
  normal(x, y, z) { this.normal = [x, y, z]; },
  color(r, g, b, a) { this.color = [r, g, b, a]; },
  texCoord(s, t, r, q) { this.tex = [s, t, r, q]; },
  vertex(x, y, z, w) { this.vertex([x, y, z, w]); },
  material(face, pname, v) {
    const faces = face === E.FRONT ? [0] : face === E.BACK ? [1] : [0, 1];
    for (const f of faces) {
      if (pname === E.SHININESS) { this.shin[f] = v[0]; continue; }
      const k = { [E.AMBIENT]: [0], [E.DIFFUSE]: [1], [E.SPECULAR]: [2], [E.EMISSION]: [3], [E.AMBIENT_AND_DIFFUSE]: [0, 1] }[pname] || [];
      for (const i of k) this.mat[f * 4 + i] = v.slice(0, 4);
    }
  },
  light(i, pname, v) {
    const l = this.lights[i - E.LIGHT0]; if (!l) return;
    if (pname === E.POSITION) l.pos = xform(this.mv[this.mv.length - 1], v);
    else if (pname === E.SPOT_DIRECTION) { const m = this.mv[this.mv.length - 1]; l.dir = [0, 1, 2].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2]); }
    else if (pname === E.AMBIENT) l.amb = v.slice(0, 4); else if (pname === E.DIFFUSE) l.dif = v.slice(0, 4); else if (pname === E.SPECULAR) l.spec = v.slice(0, 4);
    else if (pname === E.SPOT_EXPONENT) l.exp = v[0]; else if (pname === E.SPOT_CUTOFF) l.cut = v[0];
    else if (pname === E.CONSTANT_ATTENUATION) l.att[0] = v[0]; else if (pname === E.LINEAR_ATTENUATION) l.att[1] = v[0]; else if (pname === E.QUADRATIC_ATTENUATION) l.att[2] = v[0];
  },
  lightModel(pname, v) {
    if (pname === E.LIGHT_MODEL_AMBIENT) this.lmAmb = v.slice(0, 4);
    else if (pname === E.LIGHT_MODEL_TWO_SIDE) this.twoSide = !!v[0];
    else if (pname === E.LIGHT_MODEL_LOCAL_VIEWER) this.local = !!v[0];
  },
  colorMaterial(face, mode) { this.cmFace = face; this.cmMode = mode; },
  shadeModel(m) { this.shade = m; },
  polygonMode(face, m) { if (face !== E.BACK) this.polyMode[0] = m; if (face !== E.FRONT) this.polyMode[1] = m; },
  cullFace(m) { this.cullFace = m; },
  frontFace(m) { this.frontFace = m; },
  depthFunc(f) { this.depthFunc = f; },
  blendFunc(s, d) { this.blend = [s, d]; },
  bindTexture(t, id) { this.texBound = id; if (!this.textures.has(id)) this.textures.set(id, { t: this.g.createTexture(), ready: false, fmt: 0, params: {} }); },
  texEnv(pname, v) { if (pname === E.TEXTURE_ENV_MODE) this.texEnv = v[0]; else if (pname === E.TEXTURE_ENV_COLOR) this.texEnvColor = v.slice(0, 4); },
  texGen(coord, pname, v) {
    const i = coord - E.S;
    if (pname === E.TEXTURE_GEN_MODE) this.tgMode[i] = v[0];
    else if (pname === E.OBJECT_PLANE) this.tgObj[i] = v.slice(0, 4);
    else if (pname === E.EYE_PLANE) this.tgEye[i] = xform(invert4(this.mv[this.mv.length - 1]).map((_, k, a) => a[(k % 4) * 4 + (k >> 2)]), v);
  },
  texParam(pname, v) { this.texParamSet(pname, v); },
  callList(id) { this.callList(id); },
};

// ---------------------------------------------------------------- texture upload
function texParamSet(ctx, pname, v) {
  const id = ctx.texBound; if (!ctx.textures.has(id)) OPS.bindTexture.call(ctx, E.TEXTURE_2D, id);
  const t = ctx.textures.get(id), g = ctx.g;
  g.bindTexture(g.TEXTURE_2D, t.t);
  const map = x => x === E.CLAMP ? g.CLAMP_TO_EDGE : x;
  if (pname === E.TEXTURE_MIN_FILTER) { t.params.min = v; g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, t.levels > 1 || v === g.LINEAR || v === g.NEAREST ? v : g.LINEAR); }
  else if (pname === E.TEXTURE_MAG_FILTER) g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, v);
  else if (pname === E.TEXTURE_WRAP_S) g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, map(v));
  else if (pname === E.TEXTURE_WRAP_T) g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, map(v));
}
Context.prototype.texParamSet = function (pname, v) { texParamSet(this, pname, v); };
function texImage(ctx, p, level, internal, w, h, format, type, ptr) {
  const g = ctx.g, id = ctx.texBound;
  if (!ctx.textures.has(id)) OPS.bindTexture.call(ctx, E.TEXTURE_2D, id);
  const t = ctx.textures.get(id);
  const comps = { [E.RGB]: 3, [E.BGR_EXT]: 3, [E.RGBA]: 4, [E.BGRA_EXT]: 4, [E.LUMINANCE]: 1, [E.LUMINANCE_ALPHA]: 2, [E.ALPHA]: 1 }[format] || 4;
  const bpc = { [E.UNSIGNED_BYTE]: 1, [E.BYTE]: 1, [E.UNSIGNED_SHORT]: 2, [E.SHORT]: 2, [E.FLOAT]: 4, [E.INT]: 4, [E.UNSIGNED_INT]: 4 }[type] || 1;
  const u = ctx.unpack, rowLen = u.row || w, rowBytes = rowLen * comps * bpc, stride = Math.ceil(rowBytes / u.align) * u.align;
  const out = new Uint8Array(w * h * 4);
  if (ptr) {
    const dv = p.dv;
    const comp = (a) => type === E.FLOAT ? Math.round(Math.min(1, Math.max(0, dv.getFloat32(a, true))) * 255) : bpc === 2 ? dv.getUint16(a, true) >> 8 : dv.getUint8(a);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = ptr + (y + u.skipRows) * stride + (x + u.skipPixels) * comps * bpc, o = (y * w + x) * 4;
      const c = []; for (let k = 0; k < comps; k++) c.push(comp(a + k * bpc));
      let r, gg, b, al = 255;
      if (format === E.LUMINANCE) r = gg = b = c[0];
      else if (format === E.LUMINANCE_ALPHA) { r = gg = b = c[0]; al = c[1]; }
      else if (format === E.ALPHA) { r = gg = b = 255; al = c[0]; }
      else if (format === E.BGR_EXT || format === E.BGRA_EXT) { b = c[0]; gg = c[1]; r = c[2]; if (comps === 4) al = c[3]; }
      else { r = c[0]; gg = c[1]; b = c[2]; if (comps === 4) al = c[3]; }
      out[o] = r; out[o + 1] = gg; out[o + 2] = b; out[o + 3] = al;
    }
  }
  g.bindTexture(g.TEXTURE_2D, t.t);
  g.texImage2D(g.TEXTURE_2D, level, g.RGBA, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, out);
  if (level === 0) {
    t.ready = true; t.w = w; t.h = h; t.levels = 1;
    const ic = internal <= 4 ? internal : { [E.RGB]: 3, [E.LUMINANCE]: 1, [E.LUMINANCE_ALPHA]: 2, [E.ALPHA]: 1 }[internal] || 4;
    t.fmt = ic === 3 ? 1 : ic === 1 ? 2 : ic === 2 ? 3 : 0;
    if (!t.params.min) g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  } else t.levels = Math.max(t.levels || 1, level + 1);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAX_LEVEL, Math.max(0, (t.levels || 1) - 1));
  if (t.params.min) g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, t.levels > 1 ? t.params.min : (t.params.min === g.NEAREST ? g.NEAREST : g.LINEAR));
}

// ---------------------------------------------------------------- evaluators (GL 1.1 section 5.1)
function bern(n, i, t) { let c = 1; for (let k = 0; k < i; k++) c = c * (n - k) / (k + 1); return c * Math.pow(t, i) * Math.pow(1 - t, n - i); }
function dbern(n, i, t) { return n * ((i > 0 ? bern(n - 1, i - 1, t) : 0) - (i < n ? bern(n - 1, i, t) : 0)); }
function evalMap2(m, u, v, deriv) {
  const uu = (u - m.u1) / (m.u2 - m.u1), vv = (v - m.v1) / (m.v2 - m.v1), out = new Array(m.k).fill(0);
  for (let i = 0; i < m.uo; i++) for (let j = 0; j < m.vo; j++) {
    const w = (deriv === 'u' ? dbern(m.uo - 1, i, uu) : bern(m.uo - 1, i, uu)) * (deriv === 'v' ? dbern(m.vo - 1, j, vv) : bern(m.vo - 1, j, vv));
    for (let k = 0; k < m.k; k++) out[k] += w * m.pts[(i * m.vo + j) * m.k + k];
  }
  return out;
}
function evalCoord2(ctx, u, v) {
  const on = c => ctx.cap.has(c), maps = ctx.maps;
  if (on(E.MAP2_NORMAL) && maps.get(E.MAP2_NORMAL)) ctx.normal = evalMap2(maps.get(E.MAP2_NORMAL), u, v);
  if (on(E.MAP2_TEXTURE_COORD_2) && maps.get(E.MAP2_TEXTURE_COORD_2)) { const t = evalMap2(maps.get(E.MAP2_TEXTURE_COORD_2), u, v); ctx.tex = [t[0], t[1], 0, 1]; }
  if (on(E.MAP2_COLOR_4) && maps.get(E.MAP2_COLOR_4)) ctx.color = evalMap2(maps.get(E.MAP2_COLOR_4), u, v);
  const vt = on(E.MAP2_VERTEX_4) ? E.MAP2_VERTEX_4 : on(E.MAP2_VERTEX_3) ? E.MAP2_VERTEX_3 : 0;
  const m = vt && maps.get(vt); if (!m) return;
  let p = evalMap2(m, u, v); if (p.length === 3) p = [...p, 1];
  if (on(E.AUTO_NORMAL)) {
    const du = evalMap2(m, u, v, 'u'), dv = evalMap2(m, u, v, 'v');
    const n = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
    const l = Math.hypot(...n) || 1; ctx.normal = n.map(x => x / l);
  }
  ctx.vertex(p);
}

// ---------------------------------------------------------------- vertex arrays
function arrayVertex(ctx, p, i) {
  const A = ctx.arrays, dv = p.dv, rd = (a, k) => {
    const base = a.ptr + i * (a.stride || a.size * a.bytes);
    return Array.from({ length: k }, (_, j) => a.type === E.FLOAT ? dv.getFloat32(base + 4 * j, true) : a.type === E.DOUBLE ? dv.getFloat64(base + 8 * j, true)
      : a.type === E.INT ? dv.getInt32(base + 4 * j, true) : a.type === E.SHORT ? dv.getInt16(base + 2 * j, true) : a.type === E.UNSIGNED_BYTE ? dv.getUint8(base + j) / 255 : dv.getInt8(base + j));
  };
  if (A.on.has(E.NORMAL_ARRAY) && A.n) ctx.normal = rd(A.n, 3);
  if (A.on.has(E.COLOR_ARRAY) && A.c) { const c = rd(A.c, A.c.size); ctx.color = [c[0], c[1], c[2], A.c.size === 4 ? c[3] : 1]; }
  if (A.on.has(E.TEXTURE_COORD_ARRAY) && A.t) { const t = rd(A.t, A.t.size); ctx.tex = [t[0], t[1] ?? 0, t[2] ?? 0, t[3] ?? 1]; }
  if (A.on.has(E.VERTEX_ARRAY) && A.v) { const v = rd(A.v, A.v.size); ctx.vertex([v[0], v[1], A.v.size > 2 ? v[2] : 0, A.v.size > 3 ? v[3] : 1]); }
}
const TBYTES = { [E.FLOAT]: 4, [E.DOUBLE]: 8, [E.INT]: 4, [E.SHORT]: 2, [E.UNSIGNED_BYTE]: 1, [E.BYTE]: 1 };

// ---------------------------------------------------------------- entry points
const run = (name, ...a) => function (c) { if (c.rec(name, ...a)) return; OPS[name].apply(c, a); };
const op = (name) => function (c, ...a) { if (c.rec(name, ...a)) return; OPS[name].apply(c, a); };
gl('glMatrixMode', 'u', op('matrixMode'));
gl('glLoadIdentity', '', op('loadIdentity'));
gl('glLoadMatrixf', 'p', function (c, m) { const v = rdF(this, m, 16); if (!c.rec('loadMatrix', v)) OPS.loadMatrix.call(c, v); });
gl('glLoadMatrixd', 'p', function (c, m) { const v = rdD(this, m, 16); if (!c.rec('loadMatrix', v)) OPS.loadMatrix.call(c, v); });
gl('glMultMatrixf', 'p', function (c, m) { const v = rdF(this, m, 16); if (!c.rec('multMatrix', v)) OPS.multMatrix.call(c, v); });
gl('glMultMatrixd', 'p', function (c, m) { const v = rdD(this, m, 16); if (!c.rec('multMatrix', v)) OPS.multMatrix.call(c, v); });
gl('glPushMatrix', '', op('pushMatrix'));
gl('glPopMatrix', '', op('popMatrix'));
gl('glRotatef', 'ffff', op('rotate')); gl('glRotated', 'dddd', op('rotate'));
gl('glTranslatef', 'fff', op('translate')); gl('glTranslated', 'ddd', op('translate'));
gl('glScalef', 'fff', op('scale')); gl('glScaled', 'ddd', op('scale'));
gl('glFrustum', 'dddddd', op('frustum'));
gl('glOrtho', 'dddddd', op('ortho'));
gl('glEnable', 'u', op('enable'));
gl('glDisable', 'u', op('disable'));
gl('glIsEnabled', 'u', function (c, cap) { return c.cap.has(cap) ? 1 : 0; });
gl('glBegin', 'u', function (c, m) { OPS.begin.call(c, m); });
gl('glEnd', '', function (c) { c.end(); });
const vtx = (c, x, y, z = 0, w = 1) => { if (c.prim) c.vertex([x, y, z, w]); };
gl('glVertex2f', 'ff', vtx); gl('glVertex2d', 'dd', vtx); gl('glVertex2i', 'ii', vtx);
gl('glVertex3f', 'fff', vtx); gl('glVertex3d', 'ddd', vtx); gl('glVertex3i', 'iii', vtx);
gl('glVertex4f', 'ffff', vtx); gl('glVertex4d', 'dddd', vtx);
gl('glVertex2fv', 'p', function (c, p) { vtx(c, ...rdF(this, p, 2)); });
gl('glVertex3fv', 'p', function (c, p) { vtx(c, ...rdF(this, p, 3)); });
gl('glVertex4fv', 'p', function (c, p) { vtx(c, ...rdF(this, p, 4)); });
gl('glVertex2dv', 'p', function (c, p) { vtx(c, ...rdD(this, p, 2)); });
gl('glVertex3dv', 'p', function (c, p) { vtx(c, ...rdD(this, p, 3)); });
const nrm = function (c, x, y, z) { if (c.prim) c.normal = [x, y, z]; else if (!c.rec('normal', x, y, z)) OPS.normal.call(c, x, y, z); };
gl('glNormal3f', 'fff', nrm); gl('glNormal3d', 'ddd', nrm);
gl('glNormal3fv', 'p', function (c, p) { nrm.call(this, c, ...rdF(this, p, 3)); });
gl('glNormal3dv', 'p', function (c, p) { nrm.call(this, c, ...rdD(this, p, 3)); });
const col = function (c, r, g, b, a = 1) { if (c.prim) c.color = [r, g, b, a]; else if (!c.rec('color', r, g, b, a)) OPS.color.call(c, r, g, b, a); };
gl('glColor3f', 'fff', col); gl('glColor4f', 'ffff', col); gl('glColor3d', 'ddd', col); gl('glColor4d', 'dddd', col);
gl('glColor3fv', 'p', function (c, p) { col.call(this, c, ...rdF(this, p, 3)); });
gl('glColor4fv', 'p', function (c, p) { col.call(this, c, ...rdF(this, p, 4)); });
gl('glColor3ub', 'uuu', function (c, r, g, b) { col.call(this, c, (r & 255) / 255, (g & 255) / 255, (b & 255) / 255); });
gl('glColor4ub', 'uuuu', function (c, r, g, b, a) { col.call(this, c, (r & 255) / 255, (g & 255) / 255, (b & 255) / 255, (a & 255) / 255); });
gl('glColor3ubv', 'p', function (c, p) { col.call(this, c, this.r8(p) / 255, this.r8(p + 1) / 255, this.r8(p + 2) / 255); });
const tc = function (c, s, t = 0, r = 0, q = 1) { if (c.prim) c.tex = [s, t, r, q]; else if (!c.rec('texCoord', s, t, r, q)) OPS.texCoord.call(c, s, t, r, q); };
gl('glTexCoord2f', 'ff', tc); gl('glTexCoord2d', 'dd', tc); gl('glTexCoord1f', 'f', tc);
gl('glTexCoord2fv', 'p', function (c, p) { tc.call(this, c, ...rdF(this, p, 2)); });
gl('glMaterialf', 'uuf', function (c, f, n, v) { if (!c.rec('material', f, n, [v])) OPS.material.call(c, f, n, [v]); });
gl('glMateriali', 'uui', function (c, f, n, v) { if (!c.rec('material', f, n, [v])) OPS.material.call(c, f, n, [v]); });
gl('glMaterialfv', 'uup', function (c, f, n, p) { const v = rdF(this, p, n === E.SHININESS ? 1 : 4); if (!c.rec('material', f, n, v)) OPS.material.call(c, f, n, v); });
gl('glLightf', 'uuf', function (c, l, n, v) { if (!c.rec('light', l, n, [v])) OPS.light.call(c, l, n, [v]); });
gl('glLightfv', 'uup', function (c, l, n, p) { const k = n === E.SPOT_DIRECTION ? 3 : n >= E.SPOT_EXPONENT && n <= E.QUADRATIC_ATTENUATION ? 1 : 4; const v = rdF(this, p, k); if (k === 3) v.push(0); if (!c.rec('light', l, n, v)) OPS.light.call(c, l, n, v); });
gl('glLightModeli', 'ui', function (c, n, v) { if (!c.rec('lightModel', n, [v])) OPS.lightModel.call(c, n, [v]); });
gl('glLightModelf', 'uf', function (c, n, v) { if (!c.rec('lightModel', n, [v])) OPS.lightModel.call(c, n, [v]); });
gl('glLightModelfv', 'up', function (c, n, p) { const v = rdF(this, p, n === E.LIGHT_MODEL_AMBIENT ? 4 : 1); if (!c.rec('lightModel', n, v)) OPS.lightModel.call(c, n, v); });
gl('glColorMaterial', 'uu', op('colorMaterial'));
gl('glShadeModel', 'u', op('shadeModel'));
gl('glPolygonMode', 'uu', op('polygonMode'));
gl('glCullFace', 'u', op('cullFace'));
gl('glFrontFace', 'u', op('frontFace'));
gl('glDepthFunc', 'u', op('depthFunc'));
gl('glDepthMask', 'u', function (c, f) { c.g.depthMask(!!f); });
gl('glBlendFunc', 'uu', op('blendFunc'));
gl('glHint', 'uu', () => 0);
gl('glClearColor', 'ffff', function (c, r, g, b, a) { c.clearColor = [r, g, b, a]; });
gl('glClearDepth', 'd', function (c, d) { c.clearDepth = d; });
gl('glClear', 'u', function (c, m) {
  if (c.rec('clear', m)) return;
  OPS.clear.call(c, m);
});
OPS.clear = function (m) {
  this.fitDrawable();
  const g = this.g; this.applyState();
  g.clearColor(...this.clearColor); g.clearDepth(this.clearDepth); g.depthMask(true);
  g.clear((m & E.COLOR_BUFFER_BIT ? g.COLOR_BUFFER_BIT : 0) | (m & E.DEPTH_BUFFER_BIT ? g.DEPTH_BUFFER_BIT : 0));
};
gl('glViewport', 'iiii', function (c, x, y, w, h) { c.viewport = [x, y, w, h]; });
gl('glScissor', 'iiii', function (c, x, y, w, h) { c.scissor = [x, y, w, h]; });
gl('glFlush', '', function (c) { c.present(); });
gl('glFinish', '', function (c) { c.present(); });
gl('glGetError', '', () => 0);
gl('glPixelStorei', 'ui', function (c, n, v) { if (n in c.pixelStore) c.pixelStore[n] = v; if (n === E.UNPACK_ALIGNMENT) c.unpack.align = v || 1; else if (n === E.UNPACK_ROW_LENGTH) c.unpack.row = v; else if (n === E.UNPACK_SKIP_ROWS) c.unpack.skipRows = v; else if (n === E.UNPACK_SKIP_PIXELS) c.unpack.skipPixels = v; });
gl('glGetString', 'u', function (c, n) {
  const s = { 0x1F00: 'Win95 WebGL ICD', 0x1F01: 'WebGL2', 0x1F02: '1.1.0', 0x1F03: '' }[n]; if (s === undefined) return 0;
  this.glstr = this.glstr || {}; if (!this.glstr[n]) { this.glstr[n] = this.alloc(s.length + 1); this.writeA(this.glstr[n], s); }
  return this.glstr[n];
});
const intState = (c, n) => (n in c.pixelStore ? [c.pixelStore[n]] : null) || ({ 0x0D33: [1024], 0x0BA2: c.viewport, 0x0C10: c.scissor, 0x0B70: [0], 0x0D32: [8], 0x0D31: [32], 0x0BA0: [c.mode], 0x0B54: [c.shade],
  0x0D36: [32], 0x0D38: [2], 0x0D50: [8], 0x0D52: [8], 0x0D53: [8], 0x0D54: [8], 0x0D55: [8], 0x0D56: [16], 0x0B21: [1], 0x0D35: [8] }[n]);
gl('glGetIntegerv', 'up', function (c, n, p) { const v = intState(c, n) || [0]; v.forEach((x, i) => this.w32(p + 4 * i, x)); });
gl('glGetFloatv', 'up', function (c, n, p) {
  const m = { 0x0BA6: c.mv[c.mv.length - 1], 0x0BA7: c.pj[c.pj.length - 1], 0x0BA8: c.tx[c.tx.length - 1] }[n] || (intState(c, n) || [0]);
  m.forEach((x, i) => this.dv.setFloat32(p + 4 * i, x, true));
});
gl('glGetDoublev', 'up', function (c, n, p) {
  const m = { 0x0BA6: c.mv[c.mv.length - 1], 0x0BA7: c.pj[c.pj.length - 1], 0x0BA8: c.tx[c.tx.length - 1] }[n] || (intState(c, n) || [0]);
  m.forEach((x, i) => this.dv.setFloat64(p + 8 * i, x, true));
});
gl('glGetTexEnviv', 'uup', function (c, t, n, p) { this.w32(p, c.texEnv); });
gl('glPushAttrib', 'u', function (c) { c.attribStack.push({ cap: new Set(c.cap), poly: c.polyMode.slice(), shade: c.shade, tex: c.texBound, color: c.color.slice() }); });
gl('glPopAttrib', '', function (c) { const s = c.attribStack.pop(); if (s) { c.cap = s.cap; c.polyMode = s.poly; c.shade = s.shade; c.texBound = s.tex; c.color = s.color; } });
// textures
gl('glGenTextures', 'ip', function (c, n, p) { for (let i = 0; i < n; i++) this.w32(p + 4 * i, c.nextTex++); });
gl('glDeleteTextures', 'ip', function (c, n, p) { for (let i = 0; i < n; i++) { const id = this.r32(p + 4 * i), t = c.textures.get(id); if (t) { c.g.deleteTexture(t.t); c.textures.delete(id); } } });
gl('glBindTexture', 'uu', op('bindTexture'));
gl('glTexImage2D', 'uiiiiiuup', function (c, tgt, level, internal, w, h, border, format, type, ptr) { texImage(c, this, level, internal, w, h, format, type, ptr); });
gl('glTexImage1D', 'uiiiiuup', function (c, tgt, level, internal, w, border, format, type, ptr) { texImage(c, this, level, internal, w, 1, format, type, ptr); });
gl('glTexParameteri', 'uui', function (c, t, n, v) { if (!c.rec('texParam', n, v)) texParamSet(c, n, v); });
gl('glTexParameterf', 'uuf', function (c, t, n, v) { if (!c.rec('texParam', n, v)) texParamSet(c, n, v); });
gl('glTexEnvi', 'uui', function (c, t, n, v) { if (!c.rec('texEnv', n, [v])) OPS.texEnv.call(c, n, [v]); });
gl('glTexEnvf', 'uuf', function (c, t, n, v) { if (!c.rec('texEnv', n, [v])) OPS.texEnv.call(c, n, [v]); });
gl('glTexEnvfv', 'uup', function (c, t, n, p) { const v = rdF(this, p, 4); if (!c.rec('texEnv', n, v)) OPS.texEnv.call(c, n, v); });
gl('glTexGeni', 'uui', function (c, co, n, v) { if (!c.rec('texGen', co, n, [v])) OPS.texGen.call(c, co, n, [v]); });
gl('glTexGenfv', 'uup', function (c, co, n, p) { const v = n === E.TEXTURE_GEN_MODE ? [this.dv.getFloat32(p, true)] : rdF(this, p, 4); if (!c.rec('texGen', co, n, v)) OPS.texGen.call(c, co, n, v); });
// display lists
gl('glGenLists', 'i', function (c, n) { const b = c.nextList; c.nextList += n; for (let i = 0; i < n; i++) c.lists.set(b + i, []); return b; });
gl('glNewList', 'uu', function (c, id, mode) { c.compiling = []; c.compilingId = id; c.compileMode = mode; });
gl('glEndList', '', function (c) { if (c.compiling) c.lists.set(c.compilingId, c.compiling); c.compiling = null; });
gl('glCallList', 'u', function (c, id) { if (c.rec('callList', id)) return; c.callList(id); });
gl('glCallLists', 'iup', function (c, n, type, p) {
  for (let i = 0; i < n; i++) {
    const id = c.listBase + (type === E.UNSIGNED_BYTE ? this.r8(p + i) : type === E.UNSIGNED_SHORT ? this.r16(p + 2 * i) : this.r32(p + 4 * i));
    if (!c.rec('callList', id)) c.callList(id);
  }
});
gl('glListBase', 'u', function (c, b) { c.listBase = b; });
gl('glIsList', 'u', function (c, id) { return c.lists.has(id) ? 1 : 0; });
gl('glDeleteLists', 'ui', function (c, id, n) { for (let i = 0; i < n; i++) { const L = c.lists.get(id + i); if (L) for (const [fn, a] of L) if (fn === 'geo' && a[0].buf) c.g.deleteBuffer(a[0].buf); c.lists.delete(id + i); } });
// evaluators
const map2 = function (c, target, u1, u2, us, uo, v1, v2, vs, vo, p, dbl) {
  const k = { [E.MAP2_VERTEX_3]: 3, [E.MAP2_VERTEX_4]: 4, [E.MAP2_NORMAL]: 3, [E.MAP2_TEXTURE_COORD_2]: 2, [E.MAP2_COLOR_4]: 4 }[target] || 3;
  const pts = [], sz = dbl ? 8 : 4;
  for (let i = 0; i < uo; i++) for (let j = 0; j < vo; j++) for (let q = 0; q < k; q++) {
    const a = p + ((i * us + j * vs) + q) * sz; pts.push(dbl ? this.dv.getFloat64(a, true) : this.dv.getFloat32(a, true));
  }
  c.maps.set(target, { u1, u2, v1, v2, uo, vo, k, pts });
};
gl('glMap2f', 'uffiiffiip', function (c, ...a) { map2.call(this, c, ...a, false); });
gl('glMap2d', 'uddiiddiip', function (c, ...a) { map2.call(this, c, ...a, true); });
gl('glMapGrid2f', 'iffiff', function (c, un, u1, u2, vn, v1, v2) { c.grid2 = [un, u1, u2, vn, v1, v2]; });
gl('glMapGrid2d', 'iddidd', function (c, un, u1, u2, vn, v1, v2) { c.grid2 = [un, u1, u2, vn, v1, v2]; });
gl('glEvalCoord2f', 'ff', function (c, u, v) { evalCoord2(c, u, v); });
gl('glEvalPoint2', 'ii', function (c, i, j) { const [un, u1, u2, vn, v1, v2] = c.grid2; evalCoord2(c, u1 + i * (u2 - u1) / un, v1 + j * (v2 - v1) / vn); });
gl('glEvalMesh2', 'uiiii', function (c, mode, i1, i2, j1, j2) {
  const [un, u1, u2, vn, v1, v2] = c.grid2, du = (u2 - u1) / un, dv = (v2 - v1) / vn;
  if (mode === E.FILL) {
    for (let j = j1; j < j2; j++) {
      OPS.begin.call(c, E.QUAD_STRIP);
      for (let i = i1; i <= i2; i++) { evalCoord2(c, u1 + i * du, v1 + j * dv); evalCoord2(c, u1 + i * du, v1 + (j + 1) * dv); }
      c.end();
    }
  } else {
    const lm = mode === E.POINT ? E.POINTS : E.LINE_STRIP;
    for (let j = j1; j <= j2; j++) { OPS.begin.call(c, lm); for (let i = i1; i <= i2; i++) evalCoord2(c, u1 + i * du, v1 + j * dv); c.end(); }
    if (mode !== E.POINT) for (let i = i1; i <= i2; i++) { OPS.begin.call(c, lm); for (let j = j1; j <= j2; j++) evalCoord2(c, u1 + i * du, v1 + j * dv); c.end(); }
  }
});
// vertex arrays
const arr = (key) => function (c, size, type, stride, ptr) { c.arrays[key] = { size, type, stride, ptr, bytes: TBYTES[type] || 4 }; };
gl('glVertexPointer', 'iuip', arr('v'));
gl('glNormalPointer', 'uip', function (c, type, stride, ptr) { c.arrays.n = { size: 3, type, stride, ptr, bytes: TBYTES[type] || 4 }; });
gl('glColorPointer', 'iuip', arr('c'));
gl('glTexCoordPointer', 'iuip', arr('t'));
gl('glEnableClientState', 'u', function (c, a) { c.arrays.on.add(a); });
gl('glDisableClientState', 'u', function (c, a) { c.arrays.on.delete(a); });
gl('glArrayElement', 'i', function (c, i) { arrayVertex(c, this, i); });
gl('glDrawArrays', 'uii', function (c, mode, first, n) { OPS.begin.call(c, mode); for (let i = first; i < first + n; i++) arrayVertex(c, this, i); c.end(); });
gl('glDrawElements', 'uiup', function (c, mode, n, type, p) {
  OPS.begin.call(c, mode);
  for (let i = 0; i < n; i++) arrayVertex(c, this, type === E.UNSIGNED_BYTE ? this.r8(p + i) : type === E.UNSIGNED_SHORT ? this.r16(p + 2 * i) : this.r32(p + 4 * i));
  c.end();
});
gl('glInterleavedArrays', 'uip', function (c, fmt, stride, p) {
  // GL 1.1 table 2.5
  const L = { [E.V2F]: [0, 0, 0, 2, 0, 0, 0], [E.V3F]: [0, 0, 0, 3, 0, 0, 0], [E.C4UB_V2F]: [0, 4, 1, 2, 0, 4, 0], [E.C4UB_V3F]: [0, 4, 1, 3, 0, 4, 0],
    [E.C3F_V3F]: [0, 3, 0, 3, 0, 12, 0], [E.N3F_V3F]: [0, 0, 0, 3, 1, 12, 0], [E.C4F_N3F_V3F]: [0, 4, 0, 3, 1, 28, 16], [E.T2F_V3F]: [2, 0, 0, 3, 0, 8, 0],
    [E.T4F_V4F]: [4, 0, 0, 4, 0, 16, 0], [E.T2F_C4UB_V3F]: [2, 4, 1, 3, 0, 12, 0], [E.T2F_C3F_V3F]: [2, 3, 0, 3, 0, 20, 0], [E.T2F_N3F_V3F]: [2, 0, 0, 3, 1, 20, 8],
    [E.T2F_C4F_N3F_V3F]: [2, 4, 0, 3, 1, 36, 24], [E.T4F_C4F_N3F_V4F]: [4, 4, 0, 4, 1, 44, 32] }[fmt];
  if (!L) return;
  const [et, ec, cub, ev, en, pv, pn] = L, pc = et * 4;
  const size = pv + ev * 4, st = stride || size;
  c.arrays.on = new Set([E.VERTEX_ARRAY]);
  if (et) { c.arrays.on.add(E.TEXTURE_COORD_ARRAY); c.arrays.t = { size: et, type: E.FLOAT, stride: st, ptr: p, bytes: 4 }; }
  if (ec) { c.arrays.on.add(E.COLOR_ARRAY); c.arrays.c = { size: ec, type: cub ? E.UNSIGNED_BYTE : E.FLOAT, stride: st, ptr: p + pc, bytes: cub ? 1 : 4 }; }
  if (en) { c.arrays.on.add(E.NORMAL_ARRAY); c.arrays.n = { size: 3, type: E.FLOAT, stride: st, ptr: p + pn, bytes: 4 }; }
  c.arrays.v = { size: ev, type: E.FLOAT, stride: st, ptr: p + pv, bytes: 4 };
});
gl('glPolygonOffset', 'ff', () => 0);
gl('glLineWidth', 'f', () => 0);
gl('glPointSize', 'f', () => 0);
gl('glRasterPos2f', 'ff', () => 0);
gl('glPixelZoom', 'ff', () => 0);
gl('glDrawBuffer', 'u', () => 0);
gl('glReadBuffer', 'u', () => 0);
gl('glColorMask', 'uuuu', function (c, r, g, b, a) { c.g.colorMask(!!r, !!g, !!b, !!a); });

// ---------------------------------------------------------------- wgl and pixel formats
gl('wglCreateContext', 'u', function (c, hdc) {
  const dc = dcOf(this, hdc);
  const ctx = new Context(this, dc); ctx.dc = dc;
  return this.newHandle({ kind: 'glrc', ctx });
});
gl('wglMakeCurrent', 'uu', function (c, hdc, h) {
  if (!h) { this.glctx = null; return 1; }
  const o = this.obj(h); if (!o) return 0;
  this.glctx = o.ctx; o.ctx.dc = dcOf(this, hdc); this.glHdc = hdc; this.glrc = h; return 1;
});
gl('wglDeleteContext', 'u', function (c, h) { const o = this.obj(h); if (o && this.glctx === o.ctx) this.glctx = null; this.handles.delete(h); return 1; });
gl('wglGetCurrentContext', '', function () { return this.glctx ? this.glrc : 0; });
gl('wglGetCurrentDC', '', function () { return this.glctx ? this.glHdc : 0; });
gl('wglShareLists', 'uu', function (c, a, b) { const A = this.obj(a), B = this.obj(b); if (A && B) B.ctx.lists = A.ctx.lists; return 1; });
gl('wglGetProcAddress', 'p', () => 0);
gl('wglSwapBuffers', 'u', function (c) { if (c) { c.present(); this.swapWait = true; } return 1; });

// wglUseFontOutlines: one display list per character, built from the font's native TrueType outlines
// (GetGlyphOutline, GGO_NATIVE) in em units, faces tessellated by GLU32, sides extruded toward -z.
const GLU = { BEGIN: 100100, VERTEX: 100101, END: 100102, COMBINE: 100105, WINDING_RULE: 100140, NONZERO: 100131 };
def('OPENGL32', 'wglUseFontOutlines$combine', 4, function (coords, data, weight, out) {   // GLU_TESS_COMBINE
  const v = this.alloc(24); this.u8.copyWithin(v, coords, coords + 24); (this.tessTemp || []).push(v); this.w32(out, v);
});
function glyphContours(p, buf, size, em, dev) {
  const fx = a => p.i32(a) / 65536 / em, out = [];
  for (let o = buf; o < buf + size;) {
    const cb = p.r32(o), pts = [[fx(o + 8), fx(o + 12)]];
    for (let c = o + 16; c < o + cb;) {
      const type = p.r16(c), k = p.r16(c + 2), q = [];
      for (let j = 0; j < k; j++) q.push([fx(c + 4 + 8 * j), fx(c + 8 + 8 * j)]);
      if (type === 2) {   // TT_PRIM_QSPLINE: off-curve points with implied on-curve midpoints
        for (let j = 0; j < k - 1; j++) {
          const a = pts[pts.length - 1], b = q[j], e = j === k - 2 ? q[k - 1] : [(q[j][0] + q[j + 1][0]) / 2, (q[j][1] + q[j + 1][1]) / 2];
          const d = Math.hypot(a[0] - 2 * b[0] + e[0], a[1] - 2 * b[1] + e[1]), n = Math.max(1, Math.ceil(Math.sqrt(d / (4 * dev))));
          for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; pts.push([u * u * a[0] + 2 * u * t * b[0] + t * t * e[0], u * u * a[1] + 2 * u * t * b[1] + t * t * e[1]]); }
        }
      } else pts.push(...q);
      c += 4 + 8 * k;
    }
    const f = pts[0], l = pts[pts.length - 1];
    if (pts.length > 1 && f[0] === l[0] && f[1] === l[1]) pts.pop();
    if (pts.length > 2) out.push(pts);
    o += cb;
  }
  return out;
}
gl('wglUseFontOutlinesA', 'uuuuffip', function (c, hdc, first, count, base, dev, ext, format, gmf) {
  if (!c) return 0;
  const font = dcOf(this, hdc).font, n = this.nativeFontDC && this.nativeFontDC(font); if (!n) return 0;
  const otm = this.alloc(256); n.call('GetOutlineTextMetricsA', [n.hdc, 256, otm]);
  const em = this.r32(otm + 92) || 2048; this.free(otm);
  // the outlines are taken from the same face at one pixel per font unit
  const big = { kind: 'font', lf: { ...font.lf, height: -em }, raw: font.raw && font.raw.slice() };
  if (big.raw) new DataView(big.raw.buffer).setInt32(0, -em, true);
  this.nativeFontDC(big);
  if (!(dev > 0)) dev = 1 / em;
  let glu = this.byName.get('GLU32');
  if (!glu) { glu = this.loadDll('GLU32'); if (this.runPendingInits) this.runPendingInits(); }
  const G = (nm, args) => this.call(glu.exports.get(nm), args);
  const gm = this.alloc(20), mat = this.alloc(16); this.w32(mat, 0x10000); this.w32(mat + 12, 0x10000);
  const L = (nm, ...a) => FN[nm].apply(this, a);
  const tess = format === 1 && glu ? G('gluNewTess', []) : 0;
  if (tess) {
    G('gluTessCallback', [tess, GLU.BEGIN, this.thunkFor('OPENGL32', 'glBegin')]);
    G('gluTessCallback', [tess, GLU.VERTEX, this.thunkFor('OPENGL32', 'glVertex3dv')]);
    G('gluTessCallback', [tess, GLU.END, this.thunkFor('OPENGL32', 'glEnd')]);
    G('gluTessCallback', [tess, GLU.COMBINE, this.thunkFor('OPENGL32', 'wglUseFontOutlines$combine')]);
    G('gluTessProperty', [tess, GLU.WINDING_RULE, ...dbits(GLU.NONZERO)]);
  }
  const face = (contours, z, nz) => {   // one tessellated cap at depth z, facing nz
    let total = 0; for (const k of contours) total += k.length;
    const v = this.alloc(24 * total); let a = v;
    L('glNormal3f', 0, 0, fbits(nz));
    G('gluTessNormal', [tess, ...dbits(0), ...dbits(0), ...dbits(nz)]);
    G('gluTessBeginPolygon', [tess, 0]);
    for (const k of contours) {
      G('gluTessBeginContour', [tess]);
      for (const [x, y] of k) { this.dv.setFloat64(a, x, true); this.dv.setFloat64(a + 8, y, true); this.dv.setFloat64(a + 16, z, true); G('gluTessVertex', [tess, a, a]); a += 24; }
      G('gluTessEndContour', [tess]);
    }
    G('gluTessEndPolygon', [tess]);
    this.free(v);
  };
  this.tessTemp = [];
  let ok = 1;
  for (let i = 0; i < count; i++) {
    const ch = first + i;
    const need = n.call('GetGlyphOutlineA', [n.hdc, ch, 2, gm, 0, 0, mat]);
    if ((need | 0) === -1) { ok = 0; continue; }
    const buf = need ? this.alloc(need) : 0;
    if (need) n.call('GetGlyphOutlineA', [n.hdc, ch, 2, gm, need, buf, mat]);
    const contours = need ? glyphContours(this, buf, need, em, dev) : [];
    if (buf) this.free(buf);
    const incX = this.dv.getInt16(gm + 16, true) / em, incY = this.dv.getInt16(gm + 18, true) / em;
    if (gmf) {
      const g = gmf + 24 * i, f = (o, v) => this.dv.setFloat32(g + o, v, true);
      f(0, this.r32(gm) / em); f(4, this.r32(gm + 4) / em); f(8, this.i32(gm + 8) / em); f(12, this.i32(gm + 12) / em); f(16, incX); f(20, incY);
    }
    L('glNewList', base + i, E.COMPILE);
    if (format === 1 && tess) {
      if (contours.length) {
        face(contours, 0, 1);
        if (ext) {
          face(contours, -ext, -1);
          L('glBegin', E.QUADS);
          for (const k of contours) for (let j = 0; j < k.length; j++) {
            const [x0, y0] = k[j], [x1, y1] = k[(j + 1) % k.length], d = Math.hypot(x1 - x0, y1 - y0) || 1;
            L('glNormal3f', fbits((y0 - y1) / d), fbits((x1 - x0) / d), 0);
            L('glVertex3f', fbits(x0), fbits(y0), 0); L('glVertex3f', fbits(x1), fbits(y1), 0);
            L('glVertex3f', fbits(x1), fbits(y1), fbits(-ext)); L('glVertex3f', fbits(x0), fbits(y0), fbits(-ext));
          }
          L('glEnd');
        }
      }
    } else {
      for (const z of ext ? [0, -ext] : [0]) for (const k of contours) {
        L('glBegin', E.LINE_LOOP); for (const [x, y] of k) L('glVertex3f', fbits(x), fbits(y), fbits(z)); L('glEnd');
      }
      if (ext) { L('glBegin', E.LINES); for (const k of contours) for (const [x, y] of k) { L('glVertex3f', fbits(x), fbits(y), 0); L('glVertex3f', fbits(x), fbits(y), fbits(-ext)); } L('glEnd'); }
    }
    L('glTranslatef', fbits(incX), fbits(incY), 0);
    L('glEndList');
    for (const t of this.tessTemp) this.free(t); this.tessTemp = [];
  }
  if (tess) G('gluDeleteTess', [tess]);
  this.free(gm); this.free(mat);
  const hbig = this.nfonts.get(big); this.nfonts.delete(big);
  this.nativeFontDC(font); n.call('DeleteObject', [hbig]);
  return ok;
});

const PFD_FLAGS = 0x4 | 0x20 | 0x1 | 0x400;   // DRAW_TO_WINDOW | SUPPORT_OPENGL | DOUBLEBUFFER | SWAP_COPY
function writePFD(p, a) {
  p.u8.fill(0, a, a + 40);
  p.w16(a, 40); p.w16(a + 2, 1); p.w32(a + 4, PFD_FLAGS); p.u8[a + 8] = 0; p.u8[a + 9] = 24;
  p.u8[a + 10] = 8; p.u8[a + 11] = 16; p.u8[a + 12] = 8; p.u8[a + 13] = 8; p.u8[a + 14] = 8; p.u8[a + 15] = 0;
  p.u8[a + 23] = 16; p.u8[a + 26] = 0;
}
def('GDI32', 'ChoosePixelFormat', 2, function () { return 1; });
def('GDI32', 'SetPixelFormat', 3, function () { return 1; });
def('GDI32', 'GetPixelFormat', 1, function () { return 1; });
def('GDI32', 'DescribePixelFormat', 4, function (hdc, i, n, p) { if (p) writePFD(this, p); return 1; });
def('GDI32', 'SwapBuffers', 1, function () { if (this.glctx) { this.glctx.present(); this.swapWait = true; } return 1; });

window.W95GL = { Context, E };
})();
