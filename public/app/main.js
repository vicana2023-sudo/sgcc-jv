/* =============================================================================
   main.js — interfaz del MVP
   ETUL 4 S.A.

   Une el motor de grafo, las consultas y el GraphRAG con la pantalla.
   Todo corre en el navegador; no hay servidor. Las propuestas pendientes de
   revisión se guardan en este navegador, igual que haría Firestore en producción.
============================================================================= */

import { cargarGrafo, E, corto, NS } from "./grafo.js";
import { CONSULTAS, ejecutar, opciones } from "./consultas.js";
import { construirIndices, responder } from "./rag.js";
import { crearVoz } from "./voz.js";
import { ROLES, rolActual, fijarRol, alCambiarRol, vistasPermitidas,
         consultasPermitidas } from "./auth.js";
import { crearValidacion } from "./validacion.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x !== undefined) n.textContent = x; return n; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nz = (n, d = 3) => String(n).padStart(d, "0");
const hoy = () => new Date().toISOString().slice(0, 10);
const ahora = () => new Date().toISOString().slice(0, 16).replace("T", " ");

let G = null, IX = null, BANCO = null, HIST = null, VAL = null;
const ENDPOINT_MODELO = "/api/agente";     // función servidor, si está desplegada
const CLAVE_PROP = "etul4_propuestas_v1";
const CLAVE_SES = "etul4_entrevista_v1";

/* --------------------------- almacenamiento local ------------------------- */
let ALMACEN = true;
try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); } catch (e) { ALMACEN = false; }
const leer = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch (e) { return def; } };
const escribir = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

/* ================================= arranque ============================== */
(async function arrancar() {
  try {
    const [g, banco, hist] = await Promise.all([
      cargarGrafo("datos/etul4_completa.ttl"),
      fetch("datos/banco.json").then((r) => r.json()),
      fetch("datos/historias.json").then((r) => r.json()),
    ]);
    G = g; BANCO = banco; HIST = hist;
    IX = construirIndices(G);
    const s = G.estadisticas();
    $("#estado").textContent = `${s.triples.toLocaleString("es")} triples · ${s.individuos} individuos · ${s.inferencias} inferencias`;
    pintarSelectorRol();
    pintarEstadisticas(s);
    pintarSelectorClases();
    pintarReportar();
    pintarRevision();
    VAL = crearValidacion($("#validacion-app"), HIST, { rol: rolActual, irA, descargar });
    /* aplicarRol pinta lo que depende del rol: ejemplos, catálogo de consultas,
       entrevista y validación. Llamarlas antes sería pintarlas dos veces. */
    aplicarRol();
  } catch (e) {
    $("#estado").textContent = "error al cargar";
    $("#v-preguntar").insertAdjacentHTML("beforeend",
      `<div class="err"><strong>No se pudo cargar el grafo.</strong> ${esc(e.message)}<br>
       Si abrió este archivo con doble clic, el navegador bloquea la lectura de datos.
       Sírvalo con <code>python -m http.server 8000</code> y entre por <code>http://localhost:8000</code>.</div>`);
    throw e;
  }
})();

/* ================================== pestañas ============================== */
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  $$("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $$("main > section").forEach((s) => s.classList.toggle("hide", s.id !== "v-" + b.dataset.v));
  window.scrollTo(0, 0);
});
function irA(vista) { const b = $(`#tabs button[data-v="${vista}"]`); if (b) b.click(); }

/* =================================== ROL =================================
   Recordatorio, porque es la pregunta que va a caer en la defensa: esto no
   protege nada. Oculta. La comprobación de verdad va en el servidor, y aquí no
   hay servidor. Lo que sí se demuestra es el mapa de qué consulta corresponde a
   qué puesto, y que ese mapa alcanza también a la pregunta libre: el rol se
   aplica dentro del recuperador, no solo sobre las pestañas.               */
function pintarSelectorRol() {
  const sel = $("#rol");
  ROLES.forEach((r) => sel.add(new Option(r.nombre, r.id)));
  sel.value = rolActual().id;
  sel.onchange = () => fijarRol(sel.value);
  alCambiarRol(aplicarRol);
}

function aplicarRol() {
  const rol = rolActual();
  const sel = $("#rol");
  if (sel && sel.value !== rol.id) sel.value = rol.id;

  const permitidas = vistasPermitidas();
  $$("#tabs button[data-v]").forEach((b) => b.classList.toggle("hide", !permitidas.includes(b.dataset.v)));

  /* Si el rol nuevo no alcanza la pestaña abierta, hay que moverse: dejarla
     abierta sería mostrar justamente lo que se acaba de retirar. */
  const abierta = $("#tabs button.on");
  if (!abierta || !permitidas.includes(abierta.dataset.v)) irA(permitidas[0]);

  const nCons = consultasPermitidas(CONSULTAS).length;
  $("#rol-nota").textContent =
    `${rol.descripcion}  ·  ${permitidas.length} vistas y ${nCons} de ${CONSULTAS.length} consultas. ` +
    `El rol decide qué se ve; no es autenticación.`;

  pintarEjemplos();
  pintarConsultas();
  if (!ENT) pintarEntrevista();          // con sesión en curso no se toca nada
  if (VAL) VAL.pintar();
}

/* ================================= PREGUNTAR ============================== */
/* Cada ejemplo lleva la consulta a la que debería llegar, para no ofrecerle a un
   rol una pregunta que su propio filtro va a rechazar. El último no tiene
   ninguna a propósito: es la demostración de la abstención, y se ofrece siempre. */
const EJEMPLOS = [
  ["¿Cuántas unidades puedo meter al taller esta noche sin dejar la 1100 sin cobertura?", "Q15"],
  ["¿Qué buses tienen el servicio de motor vencido?", "Q01"],
  ["¿Qué se va a quedar sin revisión técnica este mes?", "Q16"],
  ["¿Qué rutas están en riesgo?", "Q17"],
  ["¿Qué repuestos tengo que comprar?", "Q13"],
  ["¿Qué bus vuelve a fallar de lo mismo?", "Q04"],
  ["¿De dónde salió la regla de las tres unidades?", "Q28"],
  ["¿Cuánto gastamos en combustible?", null],
];
function pintarEjemplos() {
  const c = $("#ejemplos");
  c.innerHTML = "";
  const permitidas = consultasPermitidas(CONSULTAS);
  EJEMPLOS.filter(([, q]) => !q || permitidas.includes(q)).forEach(([t]) => {
    const b = el("button", null, t.length > 52 ? t.slice(0, 50) + "…" : t);
    b.title = t;
    b.onclick = () => { $("#q").value = t; preguntar(); };
    c.appendChild(b);
  });
}

$("#b-preguntar").onclick = preguntar;
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") preguntar(); });

async function preguntar() {
  const texto = $("#q").value.trim();
  if (!texto || !G) return;
  const cont = $("#respuesta");
  cont.innerHTML = '<div class="card"><span class="note">Consultando el grafo…</span></div>';
  const r = await responder(G, IX, texto, {
    usarModelo: $("#usar-modelo").checked, endpoint: ENDPOINT_MODELO,
    permitidas: consultasPermitidas(CONSULTAS),
  });
  cont.innerHTML = "";
  const caja = el("div", "resp" + (r.abstencion ? " absten" : r.sinDatos ? " sindatos" : ""));

  const cab = el("div", "row");
  cab.style.justifyContent = "space-between";
  cab.appendChild(el("span", "tag" + (r.abstencion ? (r.abstencionPorRol ? " mal" : " esp") : " ok"),
    r.abstencion ? (r.abstencionPorRol ? "Consulta no permitida para este rol" : "Sin consulta aplicable")
                 : `${r.consulta.id} · ${r.consulta.titulo}`));
  if (!r.abstencion) cab.appendChild(el("span", "note", `${r.filas.length} filas · ${r.ms} ms · selección ${r.via}`));
  caja.appendChild(cab);

  const p = el("p", "texto", r.texto);
  caja.appendChild(p);

  if (r.abstencion && r.sugerencias) {
    const ch = el("div", "chips");
    r.sugerencias.forEach((s) => {
      const b = el("button", null, s.pregunta);
      b.onclick = () => { $("#q").value = s.pregunta; preguntar(); };
      ch.appendChild(b);
    });
    caja.appendChild(ch);
  }

  if (!r.abstencion && r.citados.length) {
    const d = el("div");
    d.style.marginTop = "14px";
    d.appendChild(el("div", "lbl", `Hechos del grafo que sustentan la respuesta (${r.citados.length})`));
    r.citados.slice(0, 40).forEach((iri) => {
      const b = el("span", "cita", corto(iri));
      b.title = G.etiqueta(iri);
      b.onclick = () => { irA("explorar"); mostrarDetalle(iri); };
      d.appendChild(b);
    });
    caja.appendChild(d);
  }

  if (!r.abstencion && r.filas.length) {
    const det = el("details");
    det.appendChild(el("summary", null, `Ver las ${r.filas.length} filas devueltas por el grafo`));
    det.appendChild(tabla(r.columnas, r.filas));
    caja.appendChild(det);

    const sq = el("details");
    sq.appendChild(el("summary", null, "Ver la consulta SPARQL equivalente"));
    const pre = el("pre", null, r.consulta.sparql);
    sq.appendChild(pre);
    caja.appendChild(sq);
  }

  const tz = el("div", "traza");
  tz.appendChild(el("div", "lbl", "Cómo se construyó esta respuesta"));
  const ol = el("ol");
  r.traza.forEach((t) => {
    const li = el("li");
    li.appendChild(el("b", null, t.paso + ": "));
    li.appendChild(document.createTextNode(t.detalle));
    ol.appendChild(li);
  });
  tz.appendChild(ol);
  caja.appendChild(tz);

  cont.appendChild(caja);
}

function tabla(cols, filas) {
  const c = el("div", "tabla-cont");
  const t = el("table");
  const tr = el("tr");
  cols.forEach((x) => tr.appendChild(el("th", null, x)));
  const th = el("thead"); th.appendChild(tr); t.appendChild(th);
  const tb = el("tbody");
  filas.forEach((f) => {
    const r = el("tr");
    cols.forEach((k) => {
      const td = el("td");
      const v = f[k];
      if (typeof v === "string" && /^(VENCIDO|EN RIESGO|Incorrecta)$/.test(v)) td.appendChild(el("span", "tag mal", v));
      else if (typeof v === "string" && /^(PRÓXIMO|POR VENCER|Parcialmente correcta)$/.test(v)) td.appendChild(el("span", "tag esp", v));
      else if (typeof v === "string" && /^(AL DÍA|CUBIERTA|Correcta|Sí)$/.test(v)) td.appendChild(el("span", "tag ok", v));
      else td.textContent = v === undefined || v === null ? "—" : String(v);
      r.appendChild(td);
    });
    tb.appendChild(r);
  });
  t.appendChild(tb); c.appendChild(t);
  return c;
}

/* dictado en la caja de preguntas */
const vozPregunta = crearVoz({
  onParcial: (t) => { $("#q").value = t; },
  onFinal: (t) => { $("#q").value = t; $("#b-mic").classList.remove("rec"); $("#b-mic").textContent = "Dictar"; vozPregunta.detener(); preguntar(); },
  onFin: () => { $("#b-mic").classList.remove("rec"); $("#b-mic").textContent = "Dictar"; },
  onError: (m) => { $("#b-mic").classList.remove("rec"); $("#b-mic").textContent = "Dictar"; alert(m); },
});
$("#b-mic").onclick = () => {
  if (!vozPregunta.disponible) { alert("Este navegador no tiene reconocimiento de voz. Use Chrome o Edge."); return; }
  if (vozPregunta.activo()) { vozPregunta.detener(); return; }
  $("#q").value = "";
  $("#b-mic").classList.add("rec");
  $("#b-mic").innerHTML = '<span class="dot"></span>Escuchando';
  vozPregunta.iniciar();
};

/* ================================= EXPLORAR =============================== */
function pintarEstadisticas(s) {
  const m = [["triples", s.triples], ["clases", s.clases], ["propiedades", s.objectProps + s.dataProps],
             ["individuos", s.individuos], ["clases definidas", s.definidas], ["inferencias", s.inferencias]];
  const c = $("#stats");
  m.forEach(([k, v]) => {
    const d = el("div", "stat");
    d.appendChild(el("b", null, v.toLocaleString("es")));
    d.appendChild(el("span", null, k));
    c.appendChild(d);
  });
}

function clasesConIndividuos() {
  const defin = new Set(G.definidas.map((d) => d.clase));
  const catalogos = new Set(G.individuos(E("Catalogo")).flatMap((i) => G.tipos(i)));
  const out = [];
  for (const c of G.suj(NS.rdf + "type", NS.owl + "Class")) {
    if (c.startsWith("_:")) continue;
    const n = G.individuos(c).length;
    if (!n) continue;
    const grupo = defin.has(c) ? "Clases inferidas por el razonador"
                : (catalogos.has(c) || c === E("Catalogo")) ? "Catálogos"
                : "Clases del dominio";
    out.push({ iri: c, etiqueta: G.etiqueta(c), n, grupo });
  }
  return out;
}

function pintarSelectorClases() {
  const sel = $("#clase-sel");
  const todas = clasesConIndividuos();
  for (const grupo of ["Clases del dominio", "Clases inferidas por el razonador", "Catálogos"]) {
    const g = todas.filter((c) => c.grupo === grupo).sort((a, b) => b.n - a.n);
    if (!g.length) continue;
    const og = document.createElement("optgroup");
    og.label = grupo;
    g.forEach((c) => og.appendChild(new Option(`${c.etiqueta} (${c.n})`, c.iri)));
    sel.appendChild(og);
  }
  const porDefecto = [...sel.options].find((o) => o.value === E("Vehiculo"));
  if (porDefecto) sel.value = porDefecto.value;
  sel.onchange = pintarIndividuos;
  $("#filtro").oninput = pintarIndividuos;
  pintarIndividuos();
}

function pintarIndividuos() {
  const clase = $("#clase-sel").value;
  const f = $("#filtro").value.trim().toLowerCase();
  const cont = $("#lista-indiv");
  cont.innerHTML = "";
  const lista = G.individuos(clase).filter((i) => {
    if (!f) return true;
    return (corto(i) + " " + G.etiqueta(i)).toLowerCase().includes(f);
  });
  if (!lista.length) { cont.appendChild(el("div", "item", "Sin resultados")); return; }
  lista.slice(0, 300).forEach((i) => {
    const d = el("div", "item");
    d.appendChild(el("b", null, corto(i)));
    d.appendChild(el("span", null, G.etiqueta(i)));
    const infs = G.inferidasDe(i);
    if (infs.length) d.appendChild(el("span", "tag inf", `${infs.length} inferidas`));
    d.onclick = () => mostrarDetalle(i);
    cont.appendChild(d);
  });
}

function mostrarDetalle(iri) {
  const c = $("#detalle");
  c.innerHTML = "";
  const caja = el("div", "card");
  caja.appendChild(el("div", "lbl", corto(iri)));
  caja.appendChild(el("h2", "serif h2", G.etiqueta(iri)));

  const tipos = G.tipos(iri).filter((t) => t !== NS.owl + "NamedIndividual");
  const infs = G.inferidasDe(iri);
  const fila = el("div", "row");
  fila.style.margin = "4px 0 12px";
  tipos.forEach((t) => fila.appendChild(el("span", "tag", G.etiqueta(t))));
  infs.forEach((t) => {
    const s = el("span", "tag inf", G.etiqueta(t));
    s.title = "Clase inferida por el razonador; ningún dato la declara";
    fila.appendChild(s);
  });
  caja.appendChild(fila);

  const t = el("table", "props");
  const tb = el("tbody");
  for (const [, p, o] of (G.porSujeto.get(iri) || [])) {
    if (p === NS.rdf + "type") continue;
    const tr = el("tr");
    tr.appendChild(el("td", null, G.etiqueta(p) || corto(p)));
    const td = el("td");
    if (typeof o === "string" && !o.startsWith("_:")) {
      const a = el("span", "cita", corto(o) + (G.etiqueta(o) !== corto(o) ? " · " + G.etiqueta(o) : ""));
      a.onclick = () => { mostrarDetalle(o); c.scrollIntoView({ behavior: "smooth", block: "start" }); };
      td.appendChild(a);
    } else td.textContent = o && o.lit !== undefined ? o.lit : corto(o);
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  caja.appendChild(t);

  const entrantes = (G.porObjeto.get(iri) || []).filter(([s, p]) => p !== NS.rdf + "type" && !s.startsWith("_:"));
  if (entrantes.length) {
    const d = el("details");
    d.appendChild(el("summary", null, `Referencias entrantes (${entrantes.length})`));
    const ul = el("div", "lista");
    entrantes.slice(0, 60).forEach(([s, p]) => {
      const it = el("div", "item");
      it.appendChild(el("b", null, corto(s)));
      it.appendChild(el("span", null, `${G.etiqueta(p) || corto(p)} → ${G.etiqueta(s)}`));
      it.onclick = () => { mostrarDetalle(s); c.scrollIntoView({ behavior: "smooth", block: "start" }); };
      ul.appendChild(it);
    });
    d.appendChild(ul);
    caja.appendChild(d);
  }
  c.appendChild(caja);
  caja.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ================================= CONSULTAS ============================== */
function pintarConsultas() {
  const cont = $("#lista-consultas");
  cont.innerHTML = "";
  const permitidas = consultasPermitidas(CONSULTAS);
  const visibles = CONSULTAS.filter((c) => permitidas.includes(c.id));
  if (visibles.length < CONSULTAS.length) {
    cont.appendChild(Object.assign(el("div", "aviso"), { textContent:
      `Se muestran ${visibles.length} de las ${CONSULTAS.length} plantillas del catálogo: ` +
      `las demás no corresponden al rol «${rolActual().nombre}».` }));
  }
  visibles.forEach((c) => {
    const caja = el("div", "card");
    const cab = el("div", "row");
    cab.style.justifyContent = "space-between";
    cab.appendChild(el("span", "tag", c.id));
    cab.appendChild(el("span", "note", `${c.params.length} parámetros`));
    caja.appendChild(cab);
    caja.appendChild(el("h2", "serif h2", c.titulo));
    caja.appendChild(el("p", "note", c.pregunta));

    const form = el("div", "grid");
    const campos = {};
    c.params.forEach((p) => {
      const d = el("div");
      d.appendChild(el("label", "lbl", p.etiqueta || p.n));
      let inp;
      if (p.cat) {
        inp = el("select");
        if (p.opcional) inp.add(new Option("(todas)", ""));
        opciones(G, p.cat).forEach((o) => inp.add(new Option(o.etiqueta, o.id)));
      } else {
        inp = el("input");
        inp.type = "number";
        inp.value = p.def ?? "";
      }
      campos[p.n] = inp;
      d.appendChild(inp);
      form.appendChild(d);
    });
    if (c.params.length) caja.appendChild(form);

    const bar = el("div", "row");
    bar.style.marginTop = "13px";
    const b = el("button", null, "Ejecutar");
    const salida = el("div");
    b.onclick = () => {
      const p = {};
      for (const k in campos) { const v = campos[k].value; p[k] = v === "" ? null : v; }
      const r = ejecutar(G, c.id, p);
      salida.innerHTML = "";
      salida.appendChild(el("div", "lbl", `${r.filas.length} filas`));
      if (r.filas.length) salida.appendChild(tabla(r.columnas, r.filas));
      else salida.appendChild(el("p", "note", "Sin resultados con esos parámetros."));
    };
    bar.appendChild(b);
    const b2 = el("button", "g", "Probar en Preguntar");
    b2.onclick = () => { $("#q").value = c.pregunta; irA("preguntar"); preguntar(); };
    bar.appendChild(b2);
    caja.appendChild(bar);
    caja.appendChild(salida);

    const det = el("details");
    det.appendChild(el("summary", null, "Ver SPARQL equivalente"));
    det.appendChild(el("pre", null, c.sparql));
    caja.appendChild(det);
    cont.appendChild(caja);
  });
}

/* ================================ ENTREVISTA ============================== */
let ENT = null;
function preguntaDe(q) {
  return { id: q[0], plantilla: q[1], bloque: BANCO.bloques[q[2]], rol: BANCO.roles[q[3]],
           veh: q[4], mant: q[5], comp: q[6], extra: q[7], tipoRegla: q[8],
           texto: q[9], repregunta: BANCO.repreguntas[q[10]], destino: BANCO.destinos[q[11]] };
}

function pintarEntrevista() {
  const c = $("#entrevista-app");
  c.innerHTML = "";
  const guardada = leer(CLAVE_SES, null);
  if (guardada && !ENT) {
    const av = el("div", "aviso");
    av.innerHTML = `<strong>Hay una sesión sin terminar</strong> del ${esc(guardada.fecha)}, ${esc(guardada.rol)}, con ${guardada.reglas.length} reglas.`;
    const r = el("div", "row"); r.style.marginTop = "10px";
    const b1 = el("button", null, "Retomar");
    b1.onclick = () => { ENT = guardada; ENT.cola = ENT.cola.map((id) => BANCO.q.map(preguntaDe).find((p) => p.id === id)).filter(Boolean); pintarSesion(); };
    const b2 = el("button", "g", "Descartar");
    b2.onclick = () => { localStorage.removeItem(CLAVE_SES); pintarEntrevista(); };
    r.appendChild(b1); r.appendChild(b2); av.appendChild(r);
    c.appendChild(av);
  }

  const caja = el("div", "card");
  caja.appendChild(el("h2", "serif h2", "Preparar la sesión"));
  const g = el("div", "grid");
  const selRol = el("select");
  BANCO.roles.forEach((r) => selRol.add(new Option(r, r)));
  /* Se preselecciona el rol activo cuando tiene preguntas en el banco. Sigue
     siendo editable: el investigador entrevista a cualquiera de los cuatro. */
  const suyo = rolActual().banco;
  if (suyo && BANCO.roles.includes(suyo)) selRol.value = suyo;
  const inNom = el("input"); inNom.placeholder = "Nombre y apellidos";
  const inId = el("input"); inId.value = "EXP-01";
  const inN = el("input"); inN.type = "number"; inN.value = "1"; inN.min = "1";
  const inLim = el("input"); inLim.type = "number"; inLim.value = "8"; inLim.min = "1"; inLim.max = "30";
  [["Rol del entrevistado", selRol], ["Nombre del experto", inNom], ["ID en la plantilla", inId],
   ["N.º de sesión", inN], ["Preguntas en la sesión", inLim]].forEach(([t, inp]) => {
    const d = el("div"); d.appendChild(el("label", "lbl", t)); d.appendChild(inp); g.appendChild(d);
  });
  caja.appendChild(g);

  const cuenta = el("p", "note");
  const actualizar = () => {
    const n = BANCO.q.map(preguntaDe).filter((p) => p.rol === selRol.value).length;
    cuenta.textContent = `${n} preguntas de prioridad alta disponibles para este rol.`;
  };
  selRol.onchange = actualizar; actualizar();
  caja.appendChild(cuenta);

  const b = el("button", null, "Comenzar sesión");
  b.onclick = () => {
    const rol = selRol.value;
    const todas = BANCO.q.map(preguntaDe).filter((p) => p.rol === rol);
    const porB = {};
    todas.forEach((p) => (porB[p.bloque] = porB[p.bloque] || []).push(p));
    const listas = Object.values(porB).map((l) => l.slice());
    const cola = [];
    let k = 0;
    const lim = Math.min(Number(inLim.value) || 8, todas.length);
    while (cola.length < lim && k < 3000) {
      const l = listas[k % listas.length];
      if (l && l.length) cola.push(l.shift());
      k++;
      if (listas.every((x) => !x.length)) break;
    }
    ENT = { rol, experto: inNom.value.trim(), idExperto: inId.value.trim() || "EXP-01",
            numero: Number(inN.value) || 1, fecha: hoy(), idx: 0, cola,
            turnos: {}, reglas: [], avance: [] };
    guardarSesion();
    pintarSesion();
  };
  caja.appendChild(b);
  c.appendChild(caja);
}

function guardarSesion() {
  if (!ENT) return;
  escribir(CLAVE_SES, { ...ENT, cola: ENT.cola.map((p) => p.id) });
}

const vozEnt = crearVoz({
  onParcial: (t) => { const i = $("#e-interim"); if (i) i.textContent = t; },
  onFinal: (t) => { anadirTurno(t, vozEnt.quien || "experto", "voz"); },
  onFin: () => { const b = $("#e-voz"); if (b) { b.classList.remove("rec"); b.textContent = "Grabar al experto"; } const i = $("#e-interim"); if (i) i.textContent = ""; },
  onError: (m) => { const e = $("#e-err"); if (e) { e.textContent = m; e.classList.remove("hide"); } },
});

function turnosActuales() {
  const p = ENT.cola[ENT.idx];
  return (ENT.turnos[p.id] = ENT.turnos[p.id] || []);
}
function anadirTurno(texto, quien, via) {
  const t = (texto || "").trim();
  if (!t || !ENT) return;
  turnosActuales().push({ quien, texto: t, original: t, via, revisado: false, ts: new Date().toISOString() });
  guardarSesion();           // se persiste antes de razonar sobre él
  pintarSesion();
}

function pintarSesion() {
  const c = $("#entrevista-app");
  c.innerHTML = "";
  if (!ENT) return pintarEntrevista();
  if (ENT.idx >= ENT.cola.length) return pintarCierreEntrevista();

  const p = ENT.cola[ENT.idx];
  const caja = el("div", "card");
  const cab = el("div", "row");
  cab.style.justifyContent = "space-between";
  cab.appendChild(el("span", "note", `${p.id} · ${p.bloque}`));
  cab.appendChild(el("span", "note", `${ENT.idx + 1} de ${ENT.cola.length} · ${ENT.reglas.length} reglas`));
  caja.appendChild(cab);
  caja.appendChild(el("h2", "serif h2", p.texto));
  caja.appendChild(el("p", "note", "Destino en el modelo: " + p.destino));

  const errd = el("div", "err hide"); errd.id = "e-err";
  caja.appendChild(errd);

  const cont = el("div");
  turnosActuales().forEach((t, i) => {
    const d = el("div", "turn " + (t.quien === "experto" ? "exp" : "ent"));
    const hd = el("div", "turn-hd");
    hd.appendChild(el("span", null, t.quien === "experto" ? "Experto" : "Entrevistador"));
    hd.appendChild(el("span", "tag", t.via));
    if (t.revisado) hd.appendChild(el("span", "tag esp", "corregido"));
    const bq = el("button", "g sm", "Quitar");
    bq.style.marginLeft = "auto";
    bq.onclick = () => { turnosActuales().splice(i, 1); guardarSesion(); pintarSesion(); };
    hd.appendChild(bq);
    const tx = el("div", "turn-tx", t.texto);
    tx.contentEditable = "true";
    tx.onblur = () => {
      const nv = tx.textContent.trim();
      if (nv && nv !== t.texto) { t.texto = nv; t.revisado = nv !== t.original; guardarSesion(); }
    };
    d.appendChild(hd); d.appendChild(tx); cont.appendChild(d);
  });
  caja.appendChild(cont);
  const inter = el("div", "interim"); inter.id = "e-interim";
  caja.appendChild(inter);

  const bar = el("div", "row");
  bar.style.marginTop = "12px";
  const bv = el("button", "g", "Grabar al experto"); bv.id = "e-voz";
  bv.onclick = () => {
    if (!vozEnt.disponible) { errd.textContent = "Este navegador no tiene reconocimiento de voz. Escriba la respuesta."; errd.classList.remove("hide"); return; }
    if (vozEnt.activo()) { vozEnt.detener(); return; }
    vozEnt.quien = "experto";
    bv.classList.add("rec"); bv.innerHTML = '<span class="dot"></span>Grabando';
    vozEnt.iniciar();
  };
  bar.appendChild(bv);
  const brep = el("button", "g", "Repregunta del banco");
  brep.onclick = () => anadirTurno(p.repregunta, "entrevistador", "escrito");
  bar.appendChild(brep);
  caja.appendChild(bar);

  const ta = el("textarea");
  ta.placeholder = "O escriba lo que dijo el experto";
  ta.style.marginTop = "12px";
  caja.appendChild(ta);
  const bar2 = el("div", "row");
  bar2.style.marginTop = "10px";
  const badd = el("button", "g", "Añadir turno");
  badd.onclick = () => { anadirTurno(ta.value, "experto", "escrito"); };
  const bform = el("button", null, "Formalizar la regla");
  bform.onclick = () => formalizar(caja);
  const bsalt = el("button", "g", "Saltar");
  bsalt.onclick = () => { ENT.avance.push({ id: p.id, estado: "Pendiente" }); ENT.idx++; guardarSesion(); pintarSesion(); };
  const bna = el("button", "g", "No aplica");
  bna.onclick = () => { ENT.avance.push({ id: p.id, estado: "No aplica" }); ENT.idx++; guardarSesion(); pintarSesion(); };
  [badd, bform, bsalt, bna].forEach((b) => bar2.appendChild(b));
  caja.appendChild(bar2);
  c.appendChild(caja);
}

function formalizar(caja) {
  const p = ENT.cola[ENT.idx];
  const ultimo = [...turnosActuales()].reverse().find((t) => t.quien === "experto");
  if (!ultimo) { const e = $("#e-err"); e.textContent = "Todavía no hay ningún turno del experto que formalizar."; e.classList.remove("hide"); return; }
  const f = el("div", "card");
  f.style.borderLeft = "5px solid var(--verde)";
  f.appendChild(el("h2", "serif h2", "Formalice la regla y confírmela con el experto"));
  const cond = el("textarea"); cond.placeholder = "SI: en qué situación aplica";
  const acc = el("textarea"); acc.placeholder = "ENTONCES: qué se debe hacer";
  const mot = el("input"); mot.placeholder = "PORQUE: motivo";
  const tipo = el("select");
  BANCO.cat.TipoRegla.forEach(([i, l]) => tipo.add(new Option(l, i)));
  const pn = el("input"); pn.placeholder = "Parámetro, p. ej. minimoUnidadesRuta";
  const pv = el("input"); pv.type = "number"; pv.placeholder = "Valor";
  const frag = el("textarea"); frag.value = ultimo.texto;
  [["Condición (SI)", cond], ["Acción (ENTONCES)", acc], ["Motivo", mot]].forEach(([t, i]) => {
    f.appendChild(el("label", "lbl", t)); f.appendChild(i);
  });
  const g = el("div", "grid");
  [["Tipo de regla", tipo], ["Parámetro", pn], ["Valor", pv]].forEach(([t, i]) => {
    const d = el("div"); d.appendChild(el("label", "lbl", t)); d.appendChild(i); g.appendChild(d);
  });
  f.appendChild(g);
  f.appendChild(el("label", "lbl", "Palabras del experto que sustentan la regla"));
  f.appendChild(frag);
  const bar = el("div", "row");
  bar.style.marginTop = "13px";
  const ok = el("button", null, "El experto confirma");
  ok.onclick = () => {
    if (!cond.value.trim() || !acc.value.trim()) { alert("Complete la condición y la acción."); return; }
    ENT.reglas.push({
      ID: "REG-" + nz(ENT.reglas.length + 1), "Texto original": ultimo.texto,
      "Tipo de regla": tipo.value, "Validación": "Pendiente",
      "Condición (SI)": cond.value.trim(), "Acción (ENTONCES)": acc.value.trim(),
      Categorías: p.veh || "", Rutas: (p.extra.match(/RUT-\d+/) || [""])[0],
      "Tipos de mantenimiento": p.mant || "", Componentes: p.comp || "",
      Parámetro: pn.value.trim(), Valor: pv.value, "Peso (0-1)": "", Motivo: mot.value.trim(),
      Fuente: ENT.idExperto, Sesión: "SES-" + nz(ENT.numero, 2),
      "ID pregunta origen": p.id, "Validada por": "", "Fecha validación": "",
    });
    ENT.avance.push({ id: p.id, estado: "Respondida" });
    ENT.idx++;
    guardarSesion();
    pintarSesion();
  };
  const no = el("button", "g", "Seguir preguntando");
  no.onclick = () => f.remove();
  bar.appendChild(ok); bar.appendChild(no);
  f.appendChild(bar);
  caja.parentNode.appendChild(f);
  f.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function pintarCierreEntrevista() {
  const c = $("#entrevista-app");
  c.innerHTML = "";
  const turnos = Object.values(ENT.turnos).flat();
  const voz = turnos.filter((t) => t.via === "voz").length;
  const corr = turnos.filter((t) => t.revisado).length;
  const caja = el("div", "card");
  caja.appendChild(el("h2", "serif h2", ENT.reglas.length ? `${ENT.reglas.length} reglas capturadas` : "Sesión cerrada sin reglas"));
  caja.appendChild(el("p", "note",
    `${ENT.avance.length} preguntas vistas · ${turnos.length} turnos (${voz} por voz) · ` +
    `${corr} transcripciones corregidas${voz ? ` (${Math.round((corr / voz) * 100)} % de los turnos hablados)` : ""}`));
  if (ENT.reglas.length) {
    caja.appendChild(tabla(["ID", "Tipo de regla", "Condición (SI)", "Acción (ENTONCES)", "ID pregunta origen"], ENT.reglas));
  }
  const bar = el("div", "row");
  bar.style.marginTop = "14px";
  const bd = el("button", null, "Descargar para la plantilla");
  bd.onclick = () => {
    const txt = Object.entries(ENT.turnos).map(([id, ts]) => {
      const p = ENT.cola.find((x) => x.id === id);
      return `[${id}] ${p ? p.texto : ""}\n` + ts.map((t) => `  ${t.quien === "experto" ? "Experto" : "Entrevistador"}${t.revisado ? " [corregido]" : ""}: ${t.texto}`).join("\n");
    }).join("\n\n");
    const paq = {
      sesion: { numero: ENT.numero, rol: ENT.rol, experto: ENT.experto, idExperto: ENT.idExperto,
                fecha: ENT.fecha, modelo: "captura por voz (MVP web)", versionPrompt: "entrevista-voz-v1",
                preguntasVistas: ENT.avance.length, turnos: turnos.length, turnosPorVoz: voz, turnosCorregidos: corr },
      FuenteTextual: [{ ID: "FUE-CHAT-" + nz(ENT.numero, 2), "Título": `Sesión ${ENT.numero} por voz — ${ENT.rol}`,
        "Tipo de fuente": "SesionChatbot", Fecha: ENT.fecha, "Redactada por": ENT.idExperto,
        "Vehículo mencionado": "", "Sesión de entrevista": "SES-" + nz(ENT.numero, 2),
        "Ruta del archivo": `corpus/chatbot/sesion-${nz(ENT.numero, 2)}.txt`,
        "N.º palabras": txt.split(/\s+/).length, Texto: txt }],
      ReglaExperto: ENT.reglas, ExtraccionLLM: [],
      AvanceBanco: ENT.avance.map((a) => ({ "ID pregunta": a.id, Bloque: "", Estado: a.estado, Fecha: ENT.fecha })),
    };
    descargar(`sesion-${nz(ENT.numero, 2)}.json`, JSON.stringify(paq, null, 2), "application/json");
    descargar(`sesion-${nz(ENT.numero, 2)}-transcripcion.txt`, txt);
  };
  const bn = el("button", "g", "Nueva sesión");
  bn.onclick = () => { localStorage.removeItem(CLAVE_SES); ENT = null; pintarEntrevista(); };
  bar.appendChild(bd); bar.appendChild(bn);
  caja.appendChild(bar);
  caja.appendChild(el("p", "note",
    "Importe el JSON con 09_importar_sesion.py para que las reglas entren en la plantilla y de ahí al grafo."));
  c.appendChild(caja);
}

/* ================================= REPORTAR =============================== */
const vozRep = crearVoz({
  onParcial: (t) => { const i = $("#r-interim"); if (i) i.textContent = t; },
  onFinal: (t) => { const ta = $("#r-texto"); ta.value = (ta.value + " " + t).trim(); const i = $("#r-interim"); if (i) i.textContent = ""; },
  onFin: () => { const b = $("#r-voz"); if (b) { b.classList.remove("rec"); b.textContent = "Dictar"; } },
  onError: (m) => alert(m),
});

function pintarReportar() {
  const c = $("#reportar-app");
  c.innerHTML = "";
  const caja = el("div", "card");
  const g = el("div", "grid");
  const selV = el("select");
  G.individuos(E("Vehiculo")).forEach((v) =>
    selV.add(new Option(`${G.lit(v, E("codigoInterno")) || ""} · ${G.lit(v, E("placa"))}`, corto(v))));
  const selC = el("select");
  selC.add(new Option("(no sé cuál)", ""));
  opciones(G, "TipoComponente").forEach((o) => selC.add(new Option(o.etiqueta, o.id)));
  const selS = el("select");
  opciones(G, "Severidad").forEach((o) => selS.add(new Option(o.etiqueta, o.id)));
  const selR = el("select");
  selR.add(new Option("(ninguna)", ""));
  opciones(G, "Ruta").forEach((o) => selR.add(new Option(o.etiqueta, o.id)));
  const selD = el("select");
  G.individuos(E("Conductor")).forEach((x) => selD.add(new Option(G.lit(x, E("nombreCompleto")), corto(x))));
  [["Unidad", selV], ["Conductor", selD], ["Componente", selC], ["Severidad", selS], ["Ruta", selR]]
    .forEach(([t, i]) => { const d = el("div"); d.appendChild(el("label", "lbl", t)); d.appendChild(i); g.appendChild(d); });
  caja.appendChild(g);

  caja.appendChild(el("label", "lbl", "Qué pasó, en sus palabras"));
  const ta = el("textarea"); ta.id = "r-texto";
  ta.placeholder = "En la bajada de la Panamericana el freno no respondió como debe…";
  caja.appendChild(ta);
  const inter = el("div", "interim"); inter.id = "r-interim";
  caja.appendChild(inter);

  const bar = el("div", "row");
  bar.style.marginTop = "12px";
  const bv = el("button", "g", "Dictar"); bv.id = "r-voz";
  bv.onclick = () => {
    if (!vozRep.disponible) { alert("Este navegador no tiene reconocimiento de voz. Use Chrome o Edge."); return; }
    if (vozRep.activo()) { vozRep.detener(); return; }
    bv.classList.add("rec"); bv.innerHTML = '<span class="dot"></span>Escuchando';
    vozRep.iniciar();
  };
  const be = el("button", null, "Enviar reporte");
  be.onclick = () => {
    const texto = ta.value.trim();
    if (!texto) { alert("Escriba o dicte qué pasó."); return; }
    const props = leer(CLAVE_PROP, []);
    const base = { fecha: ahora(), vehiculo: selV.value, conductor: selD.value, ruta: selR.value, texto };
    // Los campos elegidos en una lista son datos confirmados por la persona: confianza 1.
    const directos = [];
    if (selC.value) directos.push({ predicado: "etul:tipoComponente", objeto: selC.value });
    if (selS.value) directos.push({ predicado: "etul:severidad", objeto: selS.value });
    // El texto libre se interpreta: eso sí es extracción y va a revisión.
    const props2 = extraerDeTexto(texto, base, directos);
    escribir(CLAVE_PROP, [...props, ...props2]);
    ta.value = "";
    pintarRevision();
    const av = el("div", "aviso");
    av.innerHTML = `<strong>Reporte registrado.</strong> Se generaron ${props2.length} hechos candidatos
      a partir del texto libre. Están en la bandeja de revisión, no en el grafo.`;
    const b = el("button", "g", "Ver la bandeja");
    b.style.marginTop = "10px";
    b.onclick = () => irA("revision");
    av.appendChild(b);
    caja.parentNode.appendChild(av);
    setTimeout(() => av.remove(), 9000);
  };
  bar.appendChild(bv); bar.appendChild(be);
  caja.appendChild(bar);
  caja.appendChild(el("p", "note",
    "Lo que elige en las listas es un dato confirmado por usted. Lo que escribe en texto libre lo " +
    "interpreta el sistema, y por eso pasa por revisión antes de entrar al grafo."));
  c.appendChild(caja);
}

/* Extractor local por reglas léxicas. En producción lo hace un modelo de lenguaje
   con el prompt de 06_prompts_llm.md; el contrato de salida es el mismo. */
function extraerDeTexto(texto, base, directos) {
  const t = texto.toLowerCase();
  const out = [];
  const add = (predicado, objeto, frag, conf) => out.push({
    id: "EXT-" + Date.now().toString(36) + "-" + out.length,
    ...base, predicado, objeto, fragmento: frag, confianza: conf,
    estado: "ExtPropuesta", origen: "extractor léxico local",
  });
  const comp = [["freno", "Frenos"], ["puerta", "PuertasServicio"], ["motor", "Motor"],
    ["caja", "Transmision"], ["cambio", "Transmision"], ["llanta", "Neumaticos"], ["neumático", "Neumaticos"],
    ["suspensi", "Suspension"], ["direcci", "Direccion"], ["luz", "SistemaElectrico"], ["luces", "SistemaElectrico"],
    ["bater", "SistemaElectrico"], ["aire", "SistemaNeumatico"], ["gas", "SistemaCombustible"]];
  for (const [k, v] of comp) {
    const i = t.indexOf(k);
    if (i >= 0) { add("etul:tipoComponente", v, texto.slice(Math.max(0, i - 25), i + 35).trim(), 0.72); break; }
  }
  const grave = ["no respond", "no frena", "se quedó", "se quedo", "varad", "no continué", "no continue", "humo", "fuego"];
  const gi = grave.find((k) => t.includes(k));
  if (gi) add("etul:severidad", "SeveridadAlta", texto.slice(Math.max(0, t.indexOf(gi) - 20), t.indexOf(gi) + 40).trim(), 0.61);
  if (/ruta|recorrido|en plena|bajada|avenida|paradero/.test(t)) add("etul:detectadaEnRuta", "true", texto.slice(0, 70).trim(), 0.83);
  const km = texto.match(/\b(\d{4,7})\s*(km|kil[oó]metros)?\b/i);
  if (km && Number(km[1]) > 1000) add("etul:kmAlReportar", km[1], km[0], 0.55);
  directos.forEach((d) => out.push({
    id: "DIR-" + Date.now().toString(36) + "-" + out.length, ...base, ...d,
    fragmento: "(seleccionado en una lista por la persona)", confianza: 1,
    estado: "Confirmado", origen: "campo de formulario",
  }));
  return out;
}

/* ================================= REVISIÓN =============================== */
function pintarRevision() {
  const c = $("#revision-app");
  c.innerHTML = "";
  const props = leer(CLAVE_PROP, []);
  if (!ALMACEN) c.appendChild(Object.assign(el("div", "aviso"),
    { textContent: "Este navegador no permite guardar datos del sitio: la bandeja se vacía al recargar." }));
  if (!props.length) {
    c.appendChild(Object.assign(el("div", "card"),
      { innerHTML: '<p class="note" style="margin:0">La bandeja está vacía. Registre un reporte en «Reportar falla» para ver cómo funciona.</p>' }));
    return;
  }
  const pend = props.filter((p) => p.estado === "ExtPropuesta");
  const res = el("div", "stats");
  [["pendientes", pend.length], ["aceptadas", props.filter((p) => p.estado === "ExtAceptada").length],
   ["rechazadas", props.filter((p) => p.estado === "ExtRechazada").length],
   ["confirmadas en el formulario", props.filter((p) => p.estado === "Confirmado").length]]
    .forEach(([k, v]) => { const d = el("div", "stat"); d.appendChild(el("b", null, v)); d.appendChild(el("span", null, k)); res.appendChild(d); });
  c.appendChild(res);

  props.slice().reverse().forEach((p) => {
    const caja = el("div", "card");
    const cab = el("div", "row");
    cab.style.justifyContent = "space-between";
    const veh = G.individuos(E("Vehiculo")).find((v) => corto(v) === p.vehiculo);
    cab.appendChild(el("span", "note", `${p.fecha} · ${veh ? "padrón " + (G.lit(veh, E("codigoInterno")) || corto(veh)) : p.vehiculo}`));
    const est = { ExtPropuesta: "esp", ExtAceptada: "ok", ExtRechazada: "mal", Confirmado: "ok" }[p.estado] || "";
    cab.appendChild(el("span", "tag " + est, { ExtPropuesta: "Pendiente", ExtAceptada: "Aceptada",
      ExtRechazada: "Rechazada", Confirmado: "Confirmado por la persona" }[p.estado] || p.estado));
    caja.appendChild(cab);

    const t = el("table", "props");
    const tb = el("tbody");
    [["Propiedad propuesta", p.predicado], ["Valor", p.objeto],
     ["Confianza", p.confianza], ["Origen", p.origen],
     ["Fragmento que lo sustenta", p.fragmento]].forEach(([k, v]) => {
      const tr = el("tr"); tr.appendChild(el("td", null, k)); tr.appendChild(el("td", null, String(v))); tb.appendChild(tr);
    });
    t.appendChild(tb);
    caja.appendChild(t);

    if (p.estado === "ExtPropuesta") {
      const bar = el("div", "row");
      bar.style.marginTop = "12px";
      const ok = el("button", null, "Aceptar");
      ok.onclick = () => cambiar(p.id, "ExtAceptada");
      const no = el("button", "g", "Rechazar");
      no.onclick = () => cambiar(p.id, "ExtRechazada");
      bar.appendChild(ok); bar.appendChild(no);
      caja.appendChild(bar);
    }
    c.appendChild(caja);
  });

  const bar = el("div", "row");
  bar.style.marginTop = "18px";
  const bd = el("button", "g", "Descargar la bandeja");
  bd.onclick = () => descargar("bandeja-revision.json", JSON.stringify(props, null, 2), "application/json");
  const bv = el("button", "g", "Vaciar la bandeja");
  bv.onclick = () => { if (confirm("¿Vaciar todas las propuestas?")) { escribir(CLAVE_PROP, []); pintarRevision(); } };
  bar.appendChild(bd); bar.appendChild(bv);
  c.appendChild(bar);
}
function cambiar(id, estado) {
  const props = leer(CLAVE_PROP, []).map((p) => (p.id === id ? { ...p, estado, revisadoEn: ahora() } : p));
  escribir(CLAVE_PROP, props);
  pintarRevision();
}

/* ================================= utilidades ============================= */
function descargar(nombre, contenido, tipo) {
  try {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([contenido], { type: tipo || "text/plain;charset=utf-8" }));
    a.download = nombre;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  } catch (e) {
    prompt("Copie el contenido:", contenido.slice(0, 2000));
  }
}
