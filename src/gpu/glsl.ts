// WGSL → GLSL ES 3.00 for the op library (PLAN-DEVICES.md §5, level C).
//
// Not a general translator: it understands the dialect the ops are written in (typed, no pointers,
// no atomics, no compute) and checks types as it goes, because GLSL ES has no `let`/`var` inference
// and no implicit int → float. Entry points and bindings are not translated: the WebGL2 engine
// supplies its own header and `main` (see gl-engine.ts); this only turns declarations and functions.

type Ty = string; // GLSL type text: float, vec3, uint, float[16], sampler2D, a struct name; 'aint' = abstract int literal

interface Expr {
  t: Ty;
  /** GLSL text; `want` is the scalar type an abstract int should become. */
  c: (want?: Ty) => string;
}

interface Tok {
  k: 'num' | 'id' | 'op' | 'eof';
  v: string;
  line: number;
}

const RESERVED = new Set(
  (
    'attribute const uniform varying break continue do for while if else in out inout float int uint void bool true false ' +
    'lowp mediump highp precision invariant discard return mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 ' +
    'vec2 vec3 vec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 bvec2 bvec3 bvec4 sampler2D sampler3D samplerCube struct centroid flat smooth layout ' +
    'asm class union enum typedef template this packed goto inline noinline volatile public static extern external interface long short ' +
    'double half fixed unsigned superp input output filter sizeof cast namespace using sample common partition active resource patch ' +
    'subroutine buffer shared coherent restrict readonly writeonly main texture2D'
  ).split(' '),
);

/** A user name that is a GLSL keyword gets a suffix; `__` is reserved too. */
const ident = (n: string) => {
  const s = n.replace(/__+/g, '_');
  return RESERVED.has(s) || s.startsWith('gl_') ? s + '_' : s;
};

const SCALARS: Record<string, Ty> = { f32: 'float', i32: 'int', u32: 'uint', bool: 'bool', f16: 'float' };
const SUFFIX: Record<string, string> = { f: '', i: 'i', u: 'u' };
const SWIZZLE = /^[xyzw]{1,4}$|^[rgba]{1,4}$|^[stpq]{1,4}$/;

const dim = (t: Ty) => (/^[ibu]?vec([234])$/.exec(t)?.[1] ? Number(/^[ibu]?vec([234])$/.exec(t)![1]) : 0);
const isMat = (t: Ty) => /^mat[234]$/.test(t);
const isArr = (t: Ty) => t.includes('[');
const arrElem = (t: Ty) => t.slice(0, t.indexOf('['));
const arrLen = (t: Ty) => Number(t.slice(t.indexOf('[') + 1, -1));

function scalarOf(t: Ty): Ty {
  if (t === 'aint') return 'int';
  if (isMat(t)) return 'float';
  const m = /^([ibu]?)vec/.exec(t);
  if (!m) return t;
  return m[1] === 'i' ? 'int' : m[1] === 'u' ? 'uint' : m[1] === 'b' ? 'bool' : 'float';
}
const vecOf = (scalar: Ty, n: number): Ty => {
  const p = scalar === 'int' ? 'i' : scalar === 'uint' ? 'u' : scalar === 'bool' ? 'b' : '';
  return `${p}vec${n}`;
};

function zeroOf(t: Ty): string {
  if (isArr(t)) return `${t}(${Array(arrLen(t)).fill(zeroOf(arrElem(t))).join(', ')})`;
  switch (scalarOf(t)) {
    case 'float':
      return t === 'float' ? '0.0' : `${t}(0.0)`;
    case 'int':
      return t === 'int' ? '0' : `${t}(0)`;
    case 'uint':
      return t === 'uint' ? '0u' : `${t}(0u)`;
    case 'bool':
      return t === 'bool' ? 'false' : `${t}(false)`;
  }
  throw new Error(`no zero value for ${t}`);
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const re =
    /(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(\d+\.\d*(?:[eE][+-]?\d+)?[fh]?|\.\d+(?:[eE][+-]?\d+)?[fh]?|\d+[eE][+-]?\d+[fh]?|0[xX][0-9a-fA-F]+[ui]?|\d+[uif]?)|([A-Za-z_][A-Za-z0-9_]*)|(<<=|>>=|==|!=|<=|>=|&&|\|\||<<|>>|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\+\+|--|->|[-+*/%&|^!~<>=(){}[\];:,.@])/y;
  let line = 1;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`glsl: unexpected "${src.slice(i, i + 12)}" at line ${line}`);
    i = re.lastIndex;
    if (m[1] !== undefined) line += (m[1].match(/\n/g) ?? []).length;
    else if (m[2] !== undefined) toks.push({ k: 'num', v: m[2], line });
    else if (m[3] !== undefined) toks.push({ k: 'id', v: m[3], line });
    else toks.push({ k: 'op', v: m[4], line });
  }
  toks.push({ k: 'eof', v: '', line });
  return toks;
}

interface FnSig {
  params: Ty[];
  ret: Ty;
}

const COMPONENTWISE = new Set([
  'abs', 'sign', 'floor', 'ceil', 'fract', 'round', 'trunc', 'sqrt', 'inverseSqrt', 'exp', 'exp2', 'log', 'log2', 'sin', 'cos', 'tan',
  'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'normalize', 'dpdx', 'dpdy', 'fwidth', 'degrees', 'radians',
]);
const NARY = new Set(['pow', 'min', 'max', 'clamp', 'mix', 'smoothstep', 'step', 'fma', 'atan2', 'reflect']);

const HELPERS = `
float _fmod(float a, float b) { return a - b * trunc(a / b); }
vec2 _fmod(vec2 a, vec2 b) { return a - b * trunc(a / b); }
vec3 _fmod(vec3 a, vec3 b) { return a - b * trunc(a / b); }
vec4 _fmod(vec4 a, vec4 b) { return a - b * trunc(a / b); }
vec2 _fmod(vec2 a, float b) { return a - b * trunc(a / b); }
vec3 _fmod(vec3 a, float b) { return a - b * trunc(a / b); }
vec4 _fmod(vec4 a, float b) { return a - b * trunc(a / b); }
`;

class Translator {
  private toks: Tok[];
  private p = 0;
  private scopes: Map<string, Ty>[] = [new Map()];
  private fns = new Map<string, FnSig>();
  private structs = new Map<string, Map<string, Ty>>();
  private consts = new Map<string, number>();
  private usesFmod = false;

  private decls: string[] = [];
  private protos: string[] = [];
  private defs: string[] = [];

  constructor(src: string) {
    this.toks = lex(src);
    const g = this.scopes[0];
    this.structs.set('Globals', new Map([['time', 'float'], ['dt', 'float'], ['res', 'vec2'], ['camFit', 'vec4']]));
    g.set('G', 'Globals');
    g.set('P', 'vec4[64]');
    g.set('samp', 'sampler');
    // defined by the engine's header, not translated
    this.fns.set('sampleCam', { params: ['vec2'], ret: 'vec4' });
    for (const n of ['T0', 'T1', 'T2', 'T3', 't_cam', 't_o0', 't_o1', 't_o2', 't_o3', 't_glyphs']) g.set(n, 'sampler2D');
  }

  // ---- token helpers
  private get tok() {
    return this.toks[this.p];
  }
  private peek(n = 1) {
    return this.toks[Math.min(this.p + n, this.toks.length - 1)];
  }
  private fail(msg: string): never {
    throw new Error(`glsl: ${msg} at line ${this.tok.line} (near "${this.tok.v}")`);
  }
  private is(v: string) {
    return this.tok.v === v && this.tok.k !== 'num';
  }
  private eat(v: string) {
    if (!this.is(v)) this.fail(`expected "${v}"`);
    return this.toks[this.p++];
  }
  private maybe(v: string) {
    if (this.is(v)) {
      this.p++;
      return true;
    }
    return false;
  }
  private name() {
    if (this.tok.k !== 'id') this.fail('expected a name');
    return this.toks[this.p++].v;
  }

  // ---- scope
  private lookup(n: string): Ty | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const t = this.scopes[i].get(n);
      if (t !== undefined) return t;
    }
    return undefined;
  }
  private declare(n: string, t: Ty) {
    this.scopes[this.scopes.length - 1].set(n, t);
  }

  // ---- types
  private typeFromName(n: string, generic?: Ty): Ty | undefined {
    if (n in SCALARS) return SCALARS[n];
    let m = /^vec([234])([fiuh])$/.exec(n);
    if (m) return vecOf(m[2] === 'i' ? 'int' : m[2] === 'u' ? 'uint' : 'float', Number(m[1]));
    m = /^vec([234])$/.exec(n);
    if (m) return vecOf(generic ?? 'float', Number(m[1]));
    m = /^mat([234])x\1(?:[fh])?$/.exec(n);
    if (m) return `mat${m[1]}`;
    if (n === 'texture_2d') return 'sampler2D';
    if (n === 'sampler') return 'sampler';
    if (this.structs.has(n)) return n;
    return undefined;
  }

  private parseType(): Ty {
    const n = this.name();
    if (n === 'array') {
      this.eat('<');
      const elem = this.parseType();
      let len = 0;
      if (this.maybe(',')) {
        const s = this.toks[this.p++];
        len = s.k === 'num' ? Number.parseInt(s.v, 10) : (this.consts.get(s.v) ?? this.fail(`array size "${s.v}" is not a known constant`));
      }
      this.eat('>');
      return `${elem}[${len}]`;
    }
    let generic: Ty | undefined;
    if (this.is('<')) {
      this.p++;
      generic = this.parseType();
      this.eat('>');
    }
    const t = this.typeFromName(n, generic);
    if (!t) this.fail(`unknown type "${n}"`);
    return t;
  }

  // ---- expressions
  private lit(): Expr {
    const v = this.toks[this.p++].v;
    if (/^0[xX]/.test(v)) {
      const u = /[ui]$/.test(v);
      return { t: v.endsWith('u') ? 'uint' : u ? 'int' : 'aint', c: (w) => (v.endsWith('u') || w === 'uint' ? `${v.replace(/[ui]$/, '')}u` : v.replace(/[ui]$/, '')) };
    }
    const suffix = /[fhui]$/.exec(v)?.[0];
    const body = suffix ? v.slice(0, -1) : v;
    const isFloat = /[.eE]/.test(body) || suffix === 'f' || suffix === 'h';
    if (isFloat) {
      const s = /[.eE]/.test(body) ? (body.endsWith('.') ? body + '0' : body.startsWith('.') ? '0' + body : body) : body + '.0';
      return { t: 'float', c: () => s };
    }
    if (suffix === 'u') return { t: 'uint', c: () => `${body}u` };
    if (suffix === 'i') return { t: 'int', c: () => body };
    return { t: 'aint', c: (w) => (w === 'float' ? `${body}.0` : w === 'uint' ? `${body}u` : body) };
  }

  private coerce(x: Expr, to: Ty): string {
    return x.t === 'aint' ? x.c(scalarOf(to)) : x.c();
  }

  private parseExpr(minPrec = 0): Expr {
    let left = this.parseUnary();
    for (;;) {
      const op = this.tok.k === 'op' ? this.tok.v : '';
      const prec = PREC[op];
      if (prec === undefined || prec < minPrec) return left;
      this.p++;
      const right = this.parseExpr(prec + 1);
      left = this.binary(op, left, right);
    }
  }

  private binary(op: string, a: Expr, b: Expr): Expr {
    if (op === '&&' || op === '||') return { t: 'bool', c: () => `(${a.c()} ${op} ${b.c()})` };
    const wa = (w?: Ty) => (a.t === 'aint' ? (b.t === 'aint' ? w : scalarOf(b.t)) : undefined);
    const wb = (w?: Ty) => (b.t === 'aint' ? (a.t === 'aint' ? w : scalarOf(a.t)) : undefined);
    const ca = (w?: Ty) => a.c(wa(w));
    const cb = (w?: Ty) => b.c(wb(w));
    const cmp = ['==', '!=', '<', '>', '<=', '>='].includes(op);
    if (cmp) {
      const vec = dim(a.t) > 0 || dim(b.t) > 0;
      if (vec) {
        const fn = { '==': 'equal', '!=': 'notEqual', '<': 'lessThan', '>': 'greaterThan', '<=': 'lessThanEqual', '>=': 'greaterThanEqual' }[op]!;
        return { t: `bvec${dim(a.t) || dim(b.t)}`, c: () => `${fn}(${ca()}, ${cb()})` };
      }
      return { t: 'bool', c: () => `(${ca()} ${op} ${cb()})` };
    }
    // result type
    let t: Ty;
    if (a.t === 'aint' && b.t === 'aint') t = 'aint';
    else if (a.t === 'aint') t = b.t;
    else if (b.t === 'aint') t = a.t;
    else if (op === '*' && isMat(a.t) && dim(b.t)) t = b.t;
    else if (op === '*' && dim(a.t) && isMat(b.t)) t = a.t;
    else if (dim(a.t) && !dim(b.t) && !isMat(b.t)) t = a.t;
    else if (dim(b.t) && !dim(a.t) && !isMat(a.t)) t = b.t;
    else t = a.t;
    if (op === '%' && scalarOf(t) === 'float') {
      this.usesFmod = true;
      return { t, c: (w) => `_fmod(${ca(w)}, ${cb(w)})` };
    }
    if ((op === '&' || op === '|') && t === 'bool') return { t, c: () => `(${ca()} ${op === '&' ? '&&' : '||'} ${cb()})` };
    return { t, c: (w) => `(${ca(w)} ${op} ${cb(w)})` };
  }

  private parseUnary(): Expr {
    if (this.tok.k === 'op' && (this.tok.v === '-' || this.tok.v === '!' || this.tok.v === '~')) {
      const op = this.toks[this.p++].v;
      const x = this.parseUnary();
      return { t: op === '!' ? 'bool' : x.t, c: (w) => `(${op}${x.c(w)})` };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let x = this.parsePrimary();
    for (;;) {
      if (this.is('.')) {
        this.p++;
        const f = this.name();
        const base = x;
        const st = this.structs.get(base.t);
        if (st) {
          const ft = st.get(f);
          if (ft === undefined) this.fail(`"${base.t}" has no field "${f}"`);
          x = { t: ft, c: () => `${base.c()}.${f}` };
        } else if (dim(base.t) && SWIZZLE.test(f)) {
          x = { t: f.length === 1 ? scalarOf(base.t) : vecOf(scalarOf(base.t), f.length), c: () => `${base.c()}.${f}` };
        } else this.fail(`cannot read ".${f}" of ${base.t}`);
      } else if (this.is('[')) {
        this.p++;
        const idx = this.parseExpr();
        this.eat(']');
        const base = x;
        const t = isArr(base.t) ? arrElem(base.t) : isMat(base.t) ? `vec${base.t.slice(3)}` : dim(base.t) ? scalarOf(base.t) : this.fail(`cannot index ${base.t}`);
        x = { t, c: () => `${base.c()}[${idx.c('int')}]` };
      } else return x;
    }
  }

  private parsePrimary(): Expr {
    const tk = this.tok;
    if (tk.k === 'num') return this.lit();
    if (this.is('(')) {
      this.p++;
      const x = this.parseExpr();
      this.eat(')');
      return { t: x.t, c: (w) => `(${x.c(w)})` };
    }
    if (tk.k !== 'id') this.fail('expected an expression');
    const n = this.name();
    if (n === 'true' || n === 'false') return { t: 'bool', c: () => n };
    // generic constructors: array<f32, 4>(…), vec2<f32>(…)
    if ((n === 'array' || /^(vec[234]|mat[234]x[234])$/.test(n)) && this.is('<')) {
      this.p--;
      const t = this.parseType();
      return this.construct(t);
    }
    if (this.is('(')) {
      const ct = this.fns.has(n) || this.lookup(n) ? undefined : this.typeFromName(n);
      if (ct !== undefined) return this.construct(ct);
      return this.call(n);
    }
    const t = this.lookup(n);
    if (t === undefined) this.fail(`unknown name "${n}"`);
    return { t, c: () => ident(n) };
  }

  private args(): Expr[] {
    this.eat('(');
    const out: Expr[] = [];
    while (!this.is(')')) {
      out.push(this.parseExpr());
      if (!this.maybe(',')) break;
    }
    this.eat(')');
    return out;
  }

  private construct(t: Ty): Expr {
    const a = this.args();
    if (a.length === 0) return { t, c: () => zeroOf(t) };
    const want = isArr(t) ? arrElem(t) : scalarOf(t);
    const parts = a.map((x) => (x.t === 'aint' ? x.c(scalarOf(want)) : x.c()));
    return { t, c: () => `${t}(${parts.join(', ')})` };
  }

  private call(n: string): Expr {
    const a = this.args();
    const unify = (xs: Expr[]): Ty => {
      const v = xs.find((x) => dim(x.t) > 0);
      if (v) return v.t;
      const s = xs.find((x) => x.t !== 'aint');
      return s ? s.t : 'aint';
    };
    const withWant = (xs: Expr[], t: Ty) => xs.map((x) => (x.t === 'aint' ? x.c(scalarOf(t)) : x.c()));

    const user = this.fns.get(n);
    if (user) {
      const parts = a.map((x, i) => this.coerce(x, user.params[i] ?? 'float'));
      return { t: user.ret, c: () => `${ident(n)}(${parts.join(', ')})` };
    }
    if (COMPONENTWISE.has(n)) {
      const t = unify(a);
      return { t: t === 'aint' ? 'int' : t, c: () => `${n}(${withWant(a, t).join(', ')})` };
    }
    if (NARY.has(n)) {
      const t = unify(a);
      const out = n === 'atan2' ? 'atan' : n;
      // a scalar edge/bound with a vector value stays legal in GLSL for step/smoothstep/clamp/min/max/mix
      const parts = a.map((x) => (x.t === 'aint' ? x.c(scalarOf(t)) : x.c()));
      return { t: t === 'aint' ? 'int' : t, c: () => `${out}(${parts.join(', ')})` };
    }
    switch (n) {
      case 'length':
      case 'distance':
      case 'dot': {
        const parts = withWant(a, unify(a));
        return { t: scalarOf(unify(a)), c: () => `${n}(${parts.join(', ')})` };
      }
      case 'cross':
        return { t: 'vec3', c: () => `cross(${a.map((x) => x.c()).join(', ')})` };
      case 'any':
      case 'all':
        return { t: 'bool', c: () => `${n}(${a[0].c()})` };
      case 'saturate': {
        const t = unify(a);
        return { t, c: () => `clamp(${a[0].c()}, ${zeroOf(t)}, ${t === 'float' ? '1.0' : `${t}(1.0)`})` };
      }
      case 'select': {
        const t = unify([a[0], a[1]]);
        const [f, tr] = withWant([a[0], a[1]], t);
        const cond = a[2];
        return { t: t === 'aint' ? 'int' : t, c: () => (dim(cond.t) > 0 ? `mix(${f}, ${tr}, ${cond.c()})` : `(${cond.c()} ? ${tr} : ${f})`) };
      }
      case 'textureSampleLevel':
      case 'textureSampleLevelCompare': {
        const lod = a[3].t === 'aint' ? a[3].c('float') : a[3].c();
        return { t: 'vec4', c: () => `textureLod(${a[0].c()}, ${a[2].c()}, ${lod})` };
      }
      case 'textureLoad':
        return { t: 'vec4', c: () => `texelFetch(${a[0].c()}, ${dim(a[1].t) && scalarOf(a[1].t) === 'uint' ? `ivec2(${a[1].c()})` : a[1].c()}, ${a[2].c('int')})` };
      case 'textureDimensions':
        return { t: 'uvec2', c: () => `uvec2(textureSize(${a[0].c()}, 0))` };
    }
    this.fail(`unsupported function "${n}"`);
  }

  // ---- statements
  /** A declaration, assignment, increment or call, without its `;`. */
  private simple(ret?: Ty): string {
    if (this.is('let') || this.is('var') || this.is('const')) {
      this.p++;
      if (this.is('<')) {
        // var<private> inside a function is not valid WGSL; skip a storage class if present
        this.fail('storage class inside a function');
      }
      const n = this.name();
      let t: Ty | undefined;
      if (this.maybe(':')) t = this.parseType();
      let init: Expr | undefined;
      if (this.maybe('=')) init = this.parseExpr();
      const type = t ?? (init ? (init.t === 'aint' ? 'int' : init.t) : this.fail('a variable needs a type or a value'));
      this.declare(n, type);
      const value = init ? this.coerce(init, type) : zeroOf(type);
      return `${type} ${ident(n)} = ${value}`;
    }
    if (this.is('return')) {
      this.p++;
      if (this.is(';')) return 'return';
      const x = this.parseExpr();
      return `return ${this.coerce(x, ret ?? x.t)}`;
    }
    if (this.is('break') || this.is('continue') || this.is('discard')) return this.toks[this.p++].v;
    const lhs = this.parseExpr();
    if (this.is('++') || this.is('--')) return `${lhs.c()}${this.toks[this.p++].v}`;
    const op = this.tok.v;
    if (this.tok.k === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='].includes(op)) {
      this.p++;
      const rhs = this.parseExpr();
      const r = rhs.t === 'aint' ? rhs.c(scalarOf(lhs.t)) : rhs.c();
      if (op === '%=' && scalarOf(lhs.t) === 'float') {
        this.usesFmod = true;
        return `${lhs.c()} = _fmod(${lhs.c()}, ${r})`;
      }
      return `${lhs.c()} ${op} ${r}`;
    }
    return lhs.c();
  }

  private statement(ret?: Ty): string {
    if (this.is('{')) return this.braced(ret);
    if (this.is('if')) {
      this.p++;
      const cond = this.parseExpr();
      let s = `if (${cond.c()}) ${this.braced(ret)}`;
      if (this.is('else')) {
        this.p++;
        s += this.is('if') ? ` else ${this.statement(ret)}` : ` else ${this.braced(ret)}`;
      }
      return s;
    }
    if (this.is('for')) {
      this.p++;
      this.eat('(');
      this.scopes.push(new Map());
      const init = this.is(';') ? '' : this.simple();
      this.eat(';');
      const cond = this.is(';') ? '' : this.parseExpr().c();
      this.eat(';');
      const step = this.is(')') ? '' : this.simple();
      this.eat(')');
      const body = this.braced(ret);
      this.scopes.pop();
      return `for (${init}; ${cond}; ${step}) ${body}`;
    }
    if (this.is('while')) {
      this.p++;
      const cond = this.parseExpr();
      return `while (${cond.c()}) ${this.braced(ret)}`;
    }
    const s = this.simple(ret);
    this.eat(';');
    return `${s};`;
  }

  /** A { … } block; `ret` is the enclosing function's return type, for its `return` statements. */
  private braced(ret?: Ty): string {
    this.eat('{');
    this.scopes.push(new Map());
    const out: string[] = [];
    while (!this.is('}')) out.push(this.statement(ret));
    this.eat('}');
    this.scopes.pop();
    return `{\n${out.join('\n')}\n}`;
  }

  // ---- top level
  private skipBody() {
    let depth = 0;
    do {
      if (this.is('{')) depth++;
      else if (this.is('}')) depth--;
      this.p++;
    } while (depth > 0 && this.tok.k !== 'eof');
  }

  translate(): string {
    // pass 1: constants, globals, structs and function signatures (bodies are skipped)
    const bodies: { name: string; start: number; params: { n: string; t: Ty }[]; ret: Ty }[] = [];
    while (this.tok.k !== 'eof') {
      if (this.is('@')) this.fail('entry points and attributes are not translated');
      if (this.is('const')) {
        this.p++;
        const n = this.name();
        let t: Ty | undefined;
        if (this.maybe(':')) t = this.parseType();
        this.eat('=');
        const init = this.parseExpr();
        this.eat(';');
        const type = t ?? (init.t === 'aint' ? 'int' : init.t);
        this.declare(n, type);
        const code = this.coerce(init, type);
        if (/^-?\d+u?$/.test(code)) this.consts.set(n, Number.parseInt(code, 10));
        this.decls.push(`const ${isArr(type) ? `${arrElem(type)}[${arrLen(type)}]` : type} ${ident(n)} = ${code};`);
      } else if (this.is('var')) {
        this.p++;
        if (this.maybe('<')) {
          const space = this.name();
          if (space !== 'private') this.fail(`"${space}" variables are not translated`);
          this.eat('>');
        }
        const n = this.name();
        let t: Ty | undefined;
        if (this.maybe(':')) t = this.parseType();
        let init: Expr | undefined;
        if (this.maybe('=')) init = this.parseExpr();
        this.eat(';');
        const type = t ?? (init ? (init.t === 'aint' ? 'int' : init.t) : this.fail('a variable needs a type'));
        this.declare(n, type);
        this.decls.push(`${type} ${ident(n)} = ${init ? this.coerce(init, type) : zeroOf(type)};`);
      } else if (this.is('struct')) {
        this.p++;
        const n = this.name();
        this.eat('{');
        const fields = new Map<string, Ty>();
        while (!this.is('}')) {
          while (this.is('@')) {
            this.p++;
            this.name();
            if (this.maybe('(')) while (!this.maybe(')')) this.p++;
          }
          const f = this.name();
          this.eat(':');
          fields.set(f, this.parseType());
          if (!this.maybe(',')) break;
        }
        this.eat('}');
        this.structs.set(n, fields);
        this.decls.push(`struct ${n} {\n${[...fields].map(([f, t]) => `${t} ${f};`).join('\n')}\n};`);
      } else if (this.is('fn')) {
        this.p++;
        const n = this.name();
        this.eat('(');
        const params: { n: string; t: Ty }[] = [];
        while (!this.is(')')) {
          const pn = this.name();
          this.eat(':');
          params.push({ n: pn, t: this.parseType() });
          if (!this.maybe(',')) break;
        }
        this.eat(')');
        const ret = this.maybe('->') ? this.parseType() : 'void';
        this.fns.set(n, { params: params.map((x) => x.t), ret });
        this.protos.push(`${ret} ${ident(n)}(${params.map((x) => x.t).join(', ')});`);
        bodies.push({ name: n, start: this.p, params, ret });
        this.skipBody();
      } else this.fail('unexpected top-level item');
    }

    // pass 2: function bodies, now that every signature is known
    for (const f of bodies) {
      this.p = f.start;
      this.scopes.push(new Map(f.params.map((x) => [x.n, x.t])));
      const body = this.braced(f.ret === 'void' ? undefined : f.ret);
      this.scopes.pop();
      this.defs.push(`${f.ret} ${ident(f.name)}(${f.params.map((x) => `${x.t} ${ident(x.n)}`).join(', ')}) ${body}`);
    }

    return [this.usesFmod ? HELPERS : '', ...this.decls, ...this.protos, ...this.defs].join('\n');
  }
}

const PREC: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

/** Declarations and functions of a WGSL module as GLSL ES 3.00 (no header, no entry point). */
export function wgslToGlsl(wgsl: string): string {
  return new Translator(wgsl).translate();
}
