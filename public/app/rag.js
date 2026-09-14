/* =============================================================================
   rag.js — GraphRAG por consulta estructurada
   ETUL 4 S.A. · MVP

   El ciclo que implementa, para una pregunta en lenguaje natural:

     1. RECUPERAR   índice léxico (TF-IDF con coseno) sobre las plantillas de
                    consulta y sobre las etiquetas de las entidades del grafo.
                    Devuelve candidatas, no una respuesta.
     2. SELECCIONAR elegir plantilla y rellenar parámetros. Dos modos:
                    determinista (sin clave, funciona siempre) o con modelo de
                    lenguaje a través de la función servidor, si está desplegada.
     3. EJECUTAR    correr la plantilla contra el grafo. Datos exactos, no similitud.
     4. FUNDAMENTAR redactar la respuesta usando solo las filas obtenidas, y
                    devolver los individuos citados.

   Si la recuperación no alcanza el umbral de confianza, el sistema se abstiene.
   Abstenerse es un resultado válido y se mide: es la diferencia entre un sistema
   fundamentado y uno que improvisa.
============================================================================= */

import { E, corto } from "./grafo.js";
import { CONSULTAS, ejecutar, porId } from "./consultas.js";

const UMBRAL = 0.12;

/* ------------------------ normalización y tokenizado ---------------------- */
const VACIAS = new Set(("de la el los las un una unos unas y o a en que se para por con del al es " +
  "esta este cual cuales cuanto cuantos cuantas como donde cuando me mi mis lo le su sus " +
  "hay tiene tienen tengo puedo qué cuál cuánto cómo dónde sí no ya").split(" "));

export function normalizar(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !VACIAS.has(t));
}

/* ------------------------------ índice léxico ----------------------------- */
class Indice {
  constructor(docs) {
    this.docs = docs;                        // [{id, tipo, texto, ref}]
    this.df = new Map();
    this.vecs = docs.map((d) => {
      const tf = new Map();
      for (const t of normalizar(d.texto)) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      return tf;
    });
    this.N = docs.length;
    this.vecs = this.vecs.map((tf) => this._pesar(tf));
  }
  _pesar(tf) {
    const v = new Map();
    let n = 0;
    for (const [t, f] of tf) {
      const idf = Math.log((this.N + 1) / ((this.df.get(t) || 0) + 1)) + 1;
      const w = (1 + Math.log(f)) * idf;
      v.set(t, w);
      n += w * w;
    }
    n = Math.sqrt(n) || 1;
    for (const [t, w] of v) v.set(t, w / n);
    return v;
  }
  buscar(consulta, k = 5) {
    const tf = new Map();
    for (const t of normalizar(consulta)) tf.set(t, (tf.get(t) || 0) + 1);
    const q = this._pesar(tf);
    const puntos = this.vecs.map((v, i) => {
      let s = 0;
      for (const [t, w] of q) if (v.has(t)) s += w * v.get(t);
      return { doc: this.docs[i], score: s };
    });
    return puntos.filter((p) => p.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }
}

/* ------------------------ construcción de los índices --------------------- */
export function construirIndices(g) {
  const docsConsulta = CONSULTAS.map((c) => ({
    id: c.id, tipo: "consulta", ref: c,
    texto: [c.titulo, c.pregunta, ...(c.frases || [])].join(" "),
  }));

  const docsEntidad = [];
  const clasesInteres = ["Vehiculo", "Ruta", "Repuesto", "ReglaExperto", "Falla", "OrdenTrabajo",
                         "Conductor", "Tecnico", "DocumentoVehicular", "FuenteTextual"];
  for (const cl of clasesInteres) {
    for (const i of g.individuos(E(cl))) {
      const partes = [g.etiqueta(i), corto(i)];
      for (const p of ["placa", "codigoInterno", "codigoRuta", "denominacionRuta",
                       "codigoRepuesto", "textoOriginal", "descripcionFalla", "nombreCompleto"]) {
        const v = g.lit(i, E(p));
        if (v) partes.push(v);
      }
      docsEntidad.push({ id: corto(i), tipo: "entidad", ref: { iri: i, clase: cl },
                         texto: partes.join(" ") });
    }
  }
  return { consultas: new Indice(docsConsulta), entidades: new Indice(docsEntidad) };
}

/* --------------------- relleno determinista de parámetros ----------------- */
function valoresCatalogo(g, clase) {
  return g.individuos(E(clase)).map((i) => ({ id: corto(i), etiqueta: g.etiqueta(i), iri: i }));
}

function rellenar(g, consulta, pregunta, entidades) {
  const p = {};
  const norm = normalizar(pregunta).join(" ");
  for (const d of consulta.params) {
    if (d.tipo === "numero") {
      const m = pregunta.match(/\b(\d{1,4})\b/);
      p[d.n] = m ? Number(m[1]) : d.def ?? null;
      continue;
    }
    if (!d.cat) continue;
    let elegido = null;
    // 1. coincidencia por token discriminante del catálogo.
    //    Los tokens comunes a casi todas las opciones ("ruta" en «Ruta 1100», «Ruta 1054»...)
    //    no distinguen nada: si se usaran, cualquier pregunta que diga "ruta" elegiría la primera.
    const opciones = valoresCatalogo(g, d.cat).map((o) => ({
      ...o, tokens: [...new Set([...normalizar(o.etiqueta), ...normalizar(o.id)])],
    }));
    const frec = new Map();
    for (const o of opciones) for (const t of o.tokens) frec.set(t, (frec.get(t) || 0) + 1);
    const limite = Math.max(1, Math.floor(opciones.length / 2));
    let mejor = 0;
    for (const o of opciones) {
      const puntos = o.tokens.filter(
        (t) => t.length > 2 && frec.get(t) <= limite && norm.split(" ").includes(t)
      ).length;
      if (puntos > mejor) { mejor = puntos; elegido = o.id; }
    }
    // 2. si es ruta, aceptar el número suelto (1100, 1098...)
    if (!elegido && d.cat === "Ruta") {
      const m = pregunta.match(/\b(1100|1098|1054|1488)\b/);
      if (m) {
        const r = g.individuos(E("Ruta")).find((x) => g.lit(x, E("codigoRuta")) === m[1]);
        if (r) elegido = corto(r);
      }
    }
    // 3. deducir desde una entidad recuperada
    if (!elegido && entidades.length) {
      for (const e of entidades) {
        if (d.cat === "Ruta" && e.doc.ref.clase === "Ruta") { elegido = e.doc.id; break; }
        if (d.cat === "CategoriaVehiculo" && e.doc.ref.clase === "Vehiculo") {
          elegido = corto(g.uno(e.doc.ref.iri, E("categoria")));
          break;
        }
      }
    }
    p[d.n] = elegido ?? d.def ?? null;
    if (!p[d.n] && !d.opcional) {
      const primeros = valoresCatalogo(g, d.cat);
      p[d.n] = primeros.length ? primeros[0].id : null;
      p["_supuesto_" + d.n] = true;
    }
  }
  return p;
}

/* ------------------------------ redacción --------------------------------- */
const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(1)) : String(v ?? "—"));

function redactar(g, consulta, params, filas) {
  if (!filas.length) {
    return { texto: `Consulté el grafo con la plantilla ${consulta.id} (${consulta.titulo.toLowerCase()}) ` +
      `y no hay ningún resultado que cumpla esas condiciones. No voy a completar la respuesta con ` +
      `suposiciones: si esperaba ver algo aquí, probablemente falten datos por cargar.`,
      sinDatos: true, citados: [] };
  }
  const citados = [...new Set(filas.flatMap((f) => f._iri || []))];
  const col = consulta.columnas;
  let texto = "";

  switch (consulta.id) {
    case "Q01": {
      const v = filas.filter((f) => f.Situación === "VENCIDO");
      const px = filas.filter((f) => f.Situación === "PRÓXIMO");
      const sh = filas.filter((f) => f.Situación === "SIN HISTORIAL");
      texto = v.length
        ? `Hay ${v.length} ${v.length === 1 ? "tarea vencida" : "tareas vencidas"}: ` +
          v.slice(0, 5).map((f) => `padrón ${f.Padrón} (${f.Placa}), ${f.Tarea.toLowerCase()}, ${Math.abs(f.Restante)} km de exceso`).join("; ") + "."
        : "Ninguna tarea está vencida por kilometraje.";
      if (px.length) texto += ` ${px.length} ${px.length === 1 ? "está próxima" : "están próximas"} a vencer.`;
      if (sh.length) texto += ` Además, ${sh.length} combinaciones aparecen sin historial: falta registrar el último servicio de esas unidades, así que su vencimiento no se puede calcular.`;
      break;
    }
    case "Q02": {
      const t = filas.find((f) => f.Categoría === "Flota completa");
      texto = `Ahora mismo hay ${t.Disponibles} unidades disponibles de ${t.Total} (${t["%"]} %). ` +
        filas.filter((f) => f.Categoría !== "Flota completa" && f["%"] < 100)
          .map((f) => `En ${f.Categoría.toLowerCase()}: ${f.Disponibles} de ${f.Total}`).join(". ") + ".";
      break;
    }
    case "Q04":
      texto = `${filas.length} ${filas.length === 1 ? "unidad acumula" : "unidades acumulan"} fallas repetidas: ` +
        filas.map((f) => `padrón ${f.Padrón} (${f.Placa}), ${f.Fallas} fallas de ${f.Componente.toLowerCase()} entre el ${f.Primera} y el ${f.Última}`).join("; ") +
        `. Conviene revisar la causa raíz antes de volver a reparar.`;
      break;
    case "Q06":
      texto = `${filas.length} ${filas.length === 1 ? "orden está bloqueada" : "órdenes están bloqueadas"} por falta de repuesto: ` +
        filas.map((f) => `${f.Orden} (padrón ${f.Padrón}) necesita ${f.Falta} de «${f.Repuesto}», con ${f["Reposición (días)"]} días de reposición`).join("; ") + ".";
      break;
    case "Q13":
      texto = `${filas.length} repuestos están bajo el stock mínimo: ` +
        filas.map((f) => `${f.Repuesto} (reponer ${f["A reponer"]})`).join(", ") + ".";
      break;
    case "Q16": {
      const v = filas.filter((f) => f.Situación === "VENCIDO");
      texto = v.length
        ? `${v.length} ${v.length === 1 ? "unidad tiene" : "unidades tienen"} documento vencido: ` +
          v.map((f) => `padrón ${f.Padrón}, ${f.Documento.toLowerCase()} desde el ${f.Vence}`).join("; ") + ". "
        : "Ninguna unidad tiene documentos vencidos. ";
      const pv = filas.filter((f) => f.Situación === "POR VENCER");
      if (pv.length) texto += `Por vencer: ` + pv.map((f) => `padrón ${f.Padrón} el ${f.Vence} (${f.Días} días)`).join("; ") + ".";
      break;
    }
    case "Q17": {
      const r = filas.filter((f) => f.Situación === "EN RIESGO");
      texto = r.length
        ? `${r.length} ${r.length === 1 ? "ruta está" : "rutas están"} en riesgo: ` +
          r.map((f) => `${f.Ruta} tiene ${f.Disponibles} unidades disponibles y requiere ${f.Requeridas}`).join("; ") +
          `. Las demás están cubiertas.`
        : "Todas las rutas tienen las unidades que requieren.";
      break;
    }
    case "Q19": {
      const h = filas.filter((f) => f["¿Es habitual?"] === "Sí");
      const o = filas.filter((f) => f["¿Es habitual?"] === "No");
      texto = `Hay ${filas.length} unidades disponibles autorizadas para esa ruta. ` +
        (h.length ? `Habituales: ${h.map((f) => "padrón " + f.Padrón).join(", ")}. ` : "") +
        (o.length ? `Y otras ${o.length} que operan en otra ruta pero pueden cubrirla por categoría: ${o.map((f) => "padrón " + f.Padrón).join(", ")}.` : "");
      break;
    }
    case "Q15":
      texto = filas.map((f) =>
        f["Pueden ingresar"] <= 0
          ? `En ${f.Ruta} no puede entrar ninguna unidad al taller: hay ${f.Disponibles} disponibles y la regla ${f.Regla} exige un mínimo de ${f.Mínimo}. El experto lo dijo así: «${f["Texto de la regla"]}».`
          : `En ${f.Ruta} pueden entrar hasta ${f["Pueden ingresar"]} unidades sin bajar del mínimo de ${f.Mínimo} que fija la regla ${f.Regla}.`
      ).join(" ");
      break;
    case "Q09":
      texto = `Hay ${filas.length} reglas aprobadas: ` +
        filas.map((f) => `${f.ID} (${f.Tipo.toLowerCase()}), «${f["Texto original"]}»`).join("; ") + ".";
      break;
    case "Q11":
      texto = filas.map((f) => `${f.Categoría}: ${f.Preventivas} preventivas y ${f.Correctivas} correctivas sobre ${f.Total} órdenes, ${f["% preventivo"]} % preventivo`).join(". ") + ".";
      break;
    case "Q24": {
      const t = filas.find((f) => f["Tipo de fuente"] === "Total");
      texto = `De ${t.Propuestos} hechos propuestos por el modelo, ${t.Aceptados} fueron aceptados y ${t.Rechazados} rechazados: ${t["Precisión %"]} % de precisión. ` +
        filas.filter((f) => f["Tipo de fuente"] !== "Total")
          .map((f) => `${f["Tipo de fuente"]}: ${f["Precisión %"]} %`).join(", ") +
        `. Con esta cantidad de casos la cifra es ilustrativa, no concluyente.`;
      break;
    }
    case "Q28":
      texto = `${filas.length} reglas del grafo tienen su origen trazado hasta el texto: ` +
        filas.map((f) => `${f.Regla} proviene de «${f.Fuente}», con el fragmento «${f["Fragmento que la sustenta"]}»`).join("; ") + ".";
      break;
    case "Q29":
      texto = `${filas.length} individuos del grafo fueron creados a partir de una extracción automática revisada: ` +
        filas.map((f) => `${f.Individuo} (${f.Clase}, confianza ${f.Confianza})`).join(", ") +
        `. El resto se cargó a mano.`;
      break;
    case "Q30": {
      const tot = filas.reduce((a, f) => a + f.Casos, 0);
      texto = `Sobre ${tot} respuestas evaluadas: ` +
        filas.map((f) => `${f.Casos} ${f.Veredicto.toLowerCase()}`).join(", ") + ".";
      break;
    }
    default:
      texto = `La consulta ${consulta.id} devolvió ${filas.length} filas.`;
  }
  return { texto, sinDatos: false, citados };
}

/* -------------------------------- pipeline -------------------------------- */
export async function responder(g, indices, pregunta, opciones = {}) {
  const traza = [];
  const t0 = performance.now();

  /* El rol se aplica ANTES del umbral, no después de elegir: si no, el sistema
     elegiría una plantilla vedada y luego tendría que callarse, y la traza
     mentiría sobre qué consideró. Se recupera sobre el catálogo entero y se
     descarta lo que el rol no tiene; así una plantilla permitida peor
     posicionada sigue teniendo su oportunidad. */
  const permitidas = opciones.permitidas ? new Set(opciones.permitidas) : null;
  const brutos = indices.consultas.buscar(pregunta, permitidas ? CONSULTAS.length : 4);
  const cands = (permitidas ? brutos.filter((c) => permitidas.has(c.doc.id)) : brutos).slice(0, 4);
  const vetadas = permitidas ? brutos.filter((c) => !permitidas.has(c.doc.id)) : [];

  const ents = indices.entidades.buscar(pregunta, 5);
  traza.push({ paso: "Recuperar",
    detalle: cands.length
      ? `Plantillas candidatas: ${cands.map((c) => `${c.doc.id} (${c.score.toFixed(2)})`).join(", ")}`
      : vetadas.length
        ? "Ninguna plantilla de las permitidas al rol coincidió con la pregunta"
        : "Ninguna plantilla superó el umbral léxico" });
  if (permitidas) {
    traza.push({ paso: "Filtrar por rol",
      detalle: `${permitidas.size} de ${CONSULTAS.length} plantillas disponibles para este rol` +
        (vetadas.length ? `; descartadas por rol: ${vetadas.slice(0, 4).map((c) => c.doc.id).join(", ")}` : "") });
  }
  if (ents.length) traza.push({ paso: "Entidades", detalle: `Mencionadas: ${ents.slice(0, 4).map((e) => e.doc.id).join(", ")}` });

  if (!cands.length || cands[0].score < UMBRAL) {
    /* Dos abstenciones distintas, y conviene no confundirlas en la evaluación:
       no haber entendido la pregunta, y haberla entendido sin permiso para
       responderla. */
    const porRol = vetadas.length > 0 && vetadas[0].score >= UMBRAL &&
                   (!cands.length || vetadas[0].score > cands[0].score);
    traza.push({ paso: "Abstención",
      detalle: porRol
        ? `La mejor coincidencia (${vetadas[0].doc.id}) no está permitida para este rol`
        : `La mejor coincidencia (${cands[0]?.score.toFixed(2) ?? "0.00"}) está por debajo del umbral ${UMBRAL}` });
    return {
      abstencion: true, abstencionPorRol: porRol, traza, citados: [], filas: [], consulta: null,
      texto: porRol
        ? "Esa pregunta la responde una consulta que su rol no tiene asignada. No es que el dato " +
          "no exista: es que este perfil no la consulta. Cambie de rol en la cabecera si le " +
          "corresponde, o pruebe con una de las preguntas de abajo."
        : "No tengo una consulta validada que responda eso. El sistema solo responde con datos " +
          "del grafo, así que prefiero decirle que no lo sé antes que improvisar. Pruebe con otra " +
          "formulación, o revise abajo las preguntas que sí puedo responder.",
      sugerencias: CONSULTAS.filter((c) => !permitidas || permitidas.has(c.id))
        .slice(0, 6).map((c) => ({ id: c.id, pregunta: c.pregunta })),
    };
  }

  let elegida = cands[0].doc.ref;
  let params = rellenar(g, elegida, pregunta, ents);
  let via = "determinista";

  if (opciones.usarModelo && opciones.endpoint) {
    try {
      const r = await seleccionarConModelo(opciones.endpoint, pregunta, cands.map((c) => c.doc.ref), g);
      /* El modelo solo recibió las plantillas permitidas, pero puede devolver
         cualquier identificador: el permiso se vuelve a comprobar aquí. Nunca
         se confía en que la salida del modelo respete lo que se le pidió. */
      if (r && permitidas && r.consultaId && !permitidas.has(r.consultaId)) {
        traza.push({ paso: "Selección con modelo",
          detalle: `Devolvió ${r.consultaId}, no permitida para este rol; se usó la selección determinista` });
      } else if (r && porId(r.consultaId)) {
        elegida = porId(r.consultaId);
        params = { ...rellenar(g, elegida, pregunta, ents), ...(r.parametros || {}) };
        via = "modelo de lenguaje";
        traza.push({ paso: "Selección con modelo", detalle: `${r.consultaId}. ${r.motivo || ""}` });
      }
    } catch (e) {
      traza.push({ paso: "Selección con modelo", detalle: `Falló (${e.message}); se usó la selección determinista` });
    }
  }
  if (via === "determinista") {
    traza.push({ paso: "Seleccionar", detalle: `Plantilla ${elegida.id} por coincidencia léxica, sin modelo de lenguaje` });
  }

  const usados = Object.entries(params).filter(([k, v]) => !k.startsWith("_") && v !== null);
  traza.push({ paso: "Parámetros",
    detalle: usados.length ? usados.map(([k, v]) => `${k} = ${v}`).join(", ") : "sin parámetros" });

  const res = ejecutar(g, elegida.id, params);
  traza.push({ paso: "Ejecutar", detalle: `${res.filas.length} filas devueltas por el grafo` });

  const red = redactar(g, elegida, params, res.filas);
  traza.push({ paso: "Fundamentar",
    detalle: red.sinDatos ? "Sin filas: el sistema declara que no tiene el dato"
                          : `${red.citados.length} individuos citados como evidencia` });

  /* ------------------------ la «G» de GraphRAG ---------------------------
     Hasta aquí hay recuperación sobre el grafo y una redacción determinista:
     un `switch` con una plantilla escrita a mano por consulta. Eso es sólido y
     auditable, pero NO es generación: ningún modelo escribe.

     Con el agente disponible se añade el paso que faltaba. El modelo recibe
     SOLO las filas que devolvió el grafo y la orden de no salirse de ellas; no
     ve la ontología, ni el grafo, ni tiene forma de consultar nada. Y la
     redacción determinista NO se descarta: se conserva en `textoDeterminista`,
     porque tener las dos lado a lado sobre la misma pregunta es lo que permite
     medir cuánto aporta el modelo y si alguna vez añadió algo que no estaba en
     las filas. Esa comparación es el experimento, no un detalle.            */
  let texto = red.texto;
  let textoDeterminista = null;
  let redactadoPor = "plantilla determinista";

  if (opciones.usarModelo && opciones.endpoint && res.filas.length) {
    try {
      const r = await redactarConModelo(opciones.endpoint, pregunta, elegida, res.filas);
      if (r && r.respuesta) {
        textoDeterminista = red.texto;
        texto = r.respuesta;
        redactadoPor = `${r.proveedor || "modelo"} · ${r.modelo || ""}`.trim();
        traza.push({ paso: "Redactar",
          detalle: `${redactadoPor}, sobre las ${res.filas.length} filas y nada más` +
                   (r.suficiente === false ? ". El modelo declara que las filas no bastan" : "") });
      }
    } catch (e) {
      /* Que falle el redactor no puede dejar al usuario sin respuesta: ya hay
         una, fundamentada, escrita por la plantilla. */
      traza.push({ paso: "Redactar", detalle: `Falló (${e.message}); queda la redacción determinista` });
    }
  }

  return {
    abstencion: false, consulta: elegida, params, filas: res.filas, columnas: res.columnas,
    texto, textoDeterminista, redactadoPor,
    sinDatos: red.sinDatos, citados: red.citados, traza, via,
    ms: Math.round(performance.now() - t0),
  };
}

/* ---------------- redacción con modelo, sobre las filas y nada más --------
   Se le manda la pregunta, qué consulta se ejecutó y las filas. Nada más. */
async function redactarConModelo(endpoint, pregunta, consulta, filas) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tarea: "redactar",
      pregunta,
      consulta: { id: consulta.id, titulo: consulta.titulo },
      /* Tope de filas: además del coste, con cien filas en el prompt comprobar
         a ojo que la respuesta no inventó nada deja de ser posible, y esa
         comprobación es justamente el aporte de la tesis. */
      filas: filas.slice(0, 40).map((f) => {
        const { _iri, ...resto } = f;
        return resto;
      }),
    }),
  });
  if (!r.ok) {
    let detalle = "estado " + r.status;
    try { const j = await r.json(); if (j.error) detalle = j.error; } catch (e) {}
    throw new Error(detalle);
  }
  return await r.json();
}

/* ------------------- selección con modelo (función servidor) -------------- */
async function seleccionarConModelo(endpoint, pregunta, candidatas, g) {
  const catalogo = candidatas.map((c) => ({
    id: c.id, titulo: c.titulo,
    parametros: c.params.map((p) => ({
      nombre: p.n, opcional: !!p.opcional,
      valores: p.cat ? g.individuos(E(p.cat)).map((i) => corto(i)) : p.tipo,
    })),
  }));
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tarea: "seleccionar", pregunta, catalogo }),
  });
  if (!r.ok) throw new Error("estado " + r.status);
  return await r.json();
}

export { UMBRAL };
