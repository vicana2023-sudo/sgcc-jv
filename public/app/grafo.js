/* =============================================================================
   grafo.js — analizador Turtle, índice y razonador ligero
   ETUL 4 S.A. · MVP

   Carga el .ttl completo (ontología + datos) en el navegador y construye:
     - un índice de triples por sujeto, por predicado y por objeto
     - la jerarquía de clases
     - la clasificación de las clases definidas con owl:equivalentClass

   El razonador cubre los patrones que usa esta ontología: hasValue,
   someValuesFrom sobre una enumeración, someValuesFrom sobre una clase, y
   cardinalidad mínima 1 o máxima 0. No es un razonador OWL DL completo:
   para eso está HermiT sobre el mismo archivo. Aquí basta para que la demo
   muestre las clases inferidas sin backend.
============================================================================= */

export const NS = {
  etul: "http://example.org/tesis/etul4#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
};
const A = NS.rdf + "type";
const LABEL = NS.rdfs + "label";

/* ------------------------------- analizador ------------------------------ */
const TOKEN = new RegExp(
  [
    "(?<ws>\\s+)",
    "(?<comment>#[^\\n]*)",
    "(?<iri><[^>\\s]*>)",
    '(?<longstr>"""[\\s\\S]*?""")',
    '(?<str>"(?:[^"\\\\\\n]|\\\\.)*")',
    "(?<lang>@[a-zA-Z]+(?:-[a-zA-Z0-9]+)*)",
    "(?<dt>\\^\\^)",
    "(?<num>[+-]?\\d+(?:\\.\\d+)?)",
    "(?<bool>\\b(?:true|false)\\b)",
    "(?<pname>[A-Za-z][\\w-]*:(?:[A-Za-z0-9_](?:[\\w.-]*[\\w-])?)?|:[\\w-]*)",
    "(?<a>\\ba\\b)",
    "(?<bnode>_:[A-Za-z0-9_][\\w.-]*)",
    "(?<punct>[.;,\\[\\]()])",
  ].join("|"),
  "y"
);

function tokenizar(texto) {
  const out = [];
  let pos = 0;
  while (pos < texto.length) {
    if (texto.startsWith("@prefix", pos)) { out.push(["prefix", "@prefix"]); pos += 7; continue; }
    if (texto.startsWith("@base", pos)) { out.push(["base", "@base"]); pos += 5; continue; }
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(texto);
    if (!m) {
      const linea = texto.slice(0, pos).split("\n").length;
      throw new SyntaxError(`Turtle inválido en la línea ${linea}: ${JSON.stringify(texto.slice(pos, pos + 40))}`);
    }
    pos = TOKEN.lastIndex;
    const g = m.groups;
    for (const k of Object.keys(g)) {
      if (g[k] === undefined) continue;
      if (k === "ws" || k === "comment") break;
      out.push([k, g[k]]);
      break;
    }
  }
  return out;
}

function desescapar(s) {
  return s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, x) => {
    if (x[0] === "u" || x[0] === "U") return String.fromCodePoint(parseInt(x.slice(1), 16));
    return { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "'": "'", "\\": "\\" }[x] ?? x;
  });
}

class Analizador {
  constructor(toks) { this.t = toks; this.i = 0; this.pref = {}; this.triples = []; this.bn = 0; }
  ver() { return this.t[this.i] || [null, null]; }
  sig() { return this.t[this.i++] || [null, null]; }
  esperar(v) { const [, x] = this.sig(); if (x !== v) throw new SyntaxError(`Se esperaba ${v} y llegó ${x}`); }
  nuevoBN() { return `_:g${++this.bn}`; }
  iri(k, v) {
    if (k === "iri") return v.slice(1, -1);
    if (k === "bnode") return v;
    if (k === "a") return A;
    if (k === "pname") {
      const j = v.indexOf(":");
      const p = v.slice(0, j), l = v.slice(j + 1);
      if (!(p in this.pref)) throw new SyntaxError(`Prefijo no declarado: ${p}`);
      return this.pref[p] + l;
    }
    throw new SyntaxError(`Se esperaba un IRI y llegó ${v}`);
  }
  analizar() {
    while (this.ver()[0]) {
      const [k] = this.ver();
      if (k === "prefix") {
        this.sig();
        const [, pn] = this.sig(), [, ir] = this.sig();
        this.esperar(".");
        this.pref[pn.slice(0, -1)] = ir.slice(1, -1);
      } else if (k === "base") {
        this.sig(); this.sig(); this.esperar(".");
      } else {
        const s = this.sujeto();
        if (this.ver()[1] === ".") { this.sig(); continue; }
        this.predObj(s);
        this.esperar(".");
      }
    }
    return this.triples;
  }
  sujeto() {
    const [k, v] = this.ver();
    if (v === "[") {
      this.sig();
      const b = this.nuevoBN();
      if (this.ver()[1] !== "]") this.predObj(b);
      this.esperar("]");
      return b;
    }
    this.sig();
    return this.iri(k, v);
  }
  predObj(s) {
    for (;;) {
      const [k, v] = this.sig();
      const p = this.iri(k, v);
      for (;;) {
        this.triples.push([s, p, this.objeto()]);
        if (this.ver()[1] === ",") { this.sig(); continue; }
        break;
      }
      if (this.ver()[1] === ";") {
        this.sig();
        const n = this.ver()[1];
        if (n === "." || n === "]" || n === null) return;
        continue;
      }
      return;
    }
  }
  objeto() {
    const [k, v] = this.sig();
    if (v === "[") {
      const b = this.nuevoBN();
      if (this.ver()[1] !== "]") this.predObj(b);
      this.esperar("]");
      return b;
    }
    if (v === "(") {
      const items = [];
      while (this.ver()[1] !== ")") items.push(this.objeto());
      this.sig();
      return { lista: items };
    }
    if (k === "str" || k === "longstr") {
      const lex = k === "longstr" ? v.slice(3, -3) : desescapar(v.slice(1, -1));
      if (this.ver()[0] === "lang") { this.sig(); return { lit: lex, tipo: "lang" }; }
      if (this.ver()[0] === "dt") { this.sig(); const [k2, v2] = this.sig(); return { lit: lex, tipo: this.iri(k2, v2) }; }
      return { lit: lex, tipo: NS.xsd + "string" };
    }
    if (k === "num") return { lit: v, tipo: NS.xsd + (v.includes(".") ? "decimal" : "integer") };
    if (k === "bool") return { lit: v, tipo: NS.xsd + "boolean" };
    return this.iri(k, v);
  }
}

/* --------------------------------- índice -------------------------------- */
export class Grafo {
  constructor(triples) {
    this.triples = triples;
    this._indexar();
    this.inversasAgregadas = this._materializarInversas();
    if (this.inversasAgregadas) this._indexar();
    this.superclases = this._jerarquia();
    this.definidas = this._leerDefinidas();
    this.inferido = new Map();   // individuo -> Set(clases inferidas)
    this._clasificar();
  }

  _indexar() {
    this.porSujeto = new Map();
    this.porPredicado = new Map();
    this.porObjeto = new Map();
    for (const t of this.triples) {
      const [s, p, o] = t;
      push(this.porSujeto, s, t);
      push(this.porPredicado, p, t);
      if (typeof o === "string") push(this.porObjeto, o, t);
    }
  }

  /* Un razonador OWL deriva la inversa automáticamente; aquí hay que materializarla.
     Sin esto, reglas como «tiene alguna orden en curso» no encuentran nada, porque los
     datos solo declaran ordenDeVehiculo y nunca su inversa tieneOrden. */
  _materializarInversas() {
    const inv = new Map();
    for (const t of this.porPredicado.get(NS.owl + "inverseOf") || []) {
      if (typeof t[0] !== "string" || typeof t[2] !== "string") continue;
      inv.set(t[0], t[2]);
      inv.set(t[2], t[0]);
    }
    if (!inv.size) return 0;
    const existe = new Set();
    for (const [s, p, o] of this.triples) if (typeof o === "string") existe.add(s + "\u0000" + p + "\u0000" + o);
    let n = 0;
    for (const [s, p, o] of [...this.triples]) {
      const q = inv.get(p);
      if (!q || typeof o !== "string") continue;
      const clave = o + "\u0000" + q + "\u0000" + s;
      if (existe.has(clave)) continue;
      existe.add(clave);
      this.triples.push([o, q, s]);
      n++;
    }
    return n;
  }

  /* --- accesores --- */
  obj(s, p) { return (this.porSujeto.get(s) || []).filter((t) => t[1] === p).map((t) => t[2]); }
  uno(s, p) { const v = this.obj(s, p); return v.length ? v[0] : null; }
  suj(p, o) { return (this.porPredicado.get(p) || []).filter((t) => eq(t[2], o)).map((t) => t[0]); }
  lit(s, p) { const v = this.uno(s, p); return v && v.lit !== undefined ? v.lit : null; }
  num(s, p) { const v = this.lit(s, p); return v === null ? null : Number(v); }
  bool(s, p) { const v = this.lit(s, p); return v === null ? null : v === "true"; }
  etiqueta(x) {
    if (!x) return "";
    if (typeof x !== "string") return String(x.lit ?? "");
    return this.lit(x, LABEL) || corto(x);
  }
  tipos(s) { return this.obj(s, A).filter((x) => typeof x === "string"); }
  esA(s, clase) {
    const cs = this.tipos(s);
    if (cs.includes(clase)) return true;
    for (const c of cs) if ((this.superclases.get(c) || new Set()).has(clase)) return true;
    return (this.inferido.get(s) || new Set()).has(clase);
  }
  individuos(clase) {
    const salida = [];
    for (const s of this.porSujeto.keys()) {
      if (s.startsWith("_:")) continue;
      if (this.esA(s, clase)) salida.push(s);
    }
    return salida.sort();
  }
  inferidasDe(s) { return [...(this.inferido.get(s) || new Set())]; }

  /* --- jerarquía de clases --- */
  _jerarquia() {
    const directo = new Map();
    for (const t of this.porPredicado.get(NS.rdfs + "subClassOf") || []) {
      if (typeof t[2] !== "string" || t[2].startsWith("_:")) continue;
      if (!directo.has(t[0])) directo.set(t[0], new Set());
      directo.get(t[0]).add(t[2]);
    }
    const cerrado = new Map();
    const subir = (c, vistos) => {
      if (cerrado.has(c)) return cerrado.get(c);
      const out = new Set();
      for (const p of directo.get(c) || []) {
        if (vistos.has(p)) continue;
        out.add(p);
        vistos.add(p);
        for (const q of subir(p, vistos)) out.add(q);
      }
      cerrado.set(c, out);
      return out;
    };
    for (const c of directo.keys()) subir(c, new Set([c]));
    return cerrado;
  }

  /* --- clases definidas --- */
  _leerDefinidas() {
    const out = [];
    for (const t of this.porPredicado.get(NS.owl + "equivalentClass") || []) {
      const clase = t[0], nodo = t[2];
      if (typeof nodo !== "string") continue;
      const inter = this.uno(nodo, NS.owl + "intersectionOf");
      if (!inter || !inter.lista) continue;
      const [base, restr] = inter.lista;
      if (typeof base !== "string" || typeof restr !== "string") continue;
      const prop = this.uno(restr, NS.owl + "onProperty");
      if (!prop) continue;
      const hasValue = this.uno(restr, NS.owl + "hasValue");
      const some = this.uno(restr, NS.owl + "someValuesFrom");
      const minC = this.lit(restr, NS.owl + "minCardinality");
      const maxC = this.lit(restr, NS.owl + "maxCardinality");
      let regla = null;
      if (hasValue) regla = { tipo: "valor", prop, valor: hasValue };
      else if (some && typeof some === "string") {
        const oneOf = this.uno(some, NS.owl + "oneOf");
        if (oneOf && oneOf.lista) regla = { tipo: "enum", prop, valores: new Set(oneOf.lista) };
        else regla = { tipo: "clase", prop, clase: some };
      } else if (minC !== null && Number(minC) >= 1) regla = { tipo: "existe", prop };
      else if (maxC !== null && Number(maxC) === 0) regla = { tipo: "ninguno", prop };
      if (regla) out.push({ clase, base, regla });
    }
    return out;
  }

  _clasificar() {
    // dos pasadas: la segunda deja que reglas de tipo "clase" vean lo inferido en la primera
    for (let pasada = 0; pasada < 2; pasada++) {
      for (const { clase, base, regla } of this.definidas) {
        for (const s of this.porSujeto.keys()) {
          if (s.startsWith("_:")) continue;
          if (!this.esA(s, base)) continue;
          const vals = this.obj(s, regla.prop);
          let ok = false;
          switch (regla.tipo) {
            case "valor": ok = vals.some((v) => eq(v, regla.valor)); break;
            case "enum": ok = vals.some((v) => typeof v === "string" && regla.valores.has(v)); break;
            case "clase": ok = vals.some((v) => typeof v === "string" && this.esA(v, regla.clase)); break;
            case "existe": ok = vals.length > 0; break;
            case "ninguno": ok = vals.length === 0; break;
          }
          if (ok) {
            if (!this.inferido.has(s)) this.inferido.set(s, new Set());
            this.inferido.get(s).add(clase);
          }
        }
      }
    }
  }

  /* --- estadísticas para la portada --- */
  estadisticas() {
    const clases = this.suj(A, NS.owl + "Class").filter((c) => !c.startsWith("_:"));
    const indiv = this.suj(A, NS.owl + "NamedIndividual");
    let inferidas = 0;
    for (const v of this.inferido.values()) inferidas += v.size;
    return {
      triples: this.triples.length,
      clases: clases.length,
      objectProps: this.suj(A, NS.owl + "ObjectProperty").length,
      dataProps: this.suj(A, NS.owl + "DatatypeProperty").length,
      individuos: indiv.length,
      inversas: this.inversasAgregadas,
      definidas: this.definidas.length,
      inferencias: inferidas,
    };
  }
}

function push(m, k, v) { if (!m.has(k)) m.set(k, []); m.get(k).push(v); }
function eq(a, b) {
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (!a || !b) return false;
  return a.lit === b.lit;
}
export function corto(iri) {
  if (typeof iri !== "string") return String(iri?.lit ?? "");
  const i = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return i >= 0 ? iri.slice(i + 1) : iri;
}
export const E = (n) => NS.etul + n;

/* --------------------------------- carga --------------------------------- */
export async function cargarGrafo(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo cargar ${url} (estado ${r.status})`);
  const texto = await r.text();
  return new Grafo(new Analizador(tokenizar(texto)).analizar());
}
export function grafoDesdeTexto(texto) {
  return new Grafo(new Analizador(tokenizar(texto)).analizar());
}
