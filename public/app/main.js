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
import { ROLES, rolActual, fijarRol, alCambiarRol, vistasPermitidas, puedeVer,
         consultasPermitidas, haySesion } from "./auth.js";
import { crearValidacion } from "./validacion.js";
import { arrancarSesion, entrar, salir, mensajeDeError } from "./sesion.js";
import { ICO, botonIcono, cambiarIcono } from "./iconos.js";
import { crearRed } from "./red.js";
import { abrirAlmacen, modoAlmacen, motivoAlmacen,
         listar, guardar, actualizar, borrar, vaciar, escuchar, nuevoId } from "./almacen.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x !== undefined) n.textContent = x; return n; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nz = (n, d = 3) => String(n).padStart(d, "0");
const hoy = () => new Date().toISOString().slice(0, 10);
const ahora = () => new Date().toISOString().slice(0, 16).replace("T", " ");

let G = null, IX = null, BANCO = null, HIST = null, VAL = null, RED = null;
const ENDPOINT_MODELO = "/api/agente";     // función servidor, si está desplegada
/* Nombres de colección, no claves de localStorage: almacen.js decide si eso se
   traduce en un documento de Firestore o en una entrada del navegador. */
const COL_PROP = "propuestas";
const COL_SES = "sesiones";
let USUARIO = null;          // { uid, correo, rol }, para firmar lo que se cree
let dejarDeEscuchar = null;
let SESION_PENDIENTE = null; // entrevista sin cerrar, si la hay

/* --------------------------- almacenamiento local ------------------------- */
let ALMACEN = true;
try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); } catch (e) { ALMACEN = false; }
const leer = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch (e) { return def; } };
const escribir = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

/* ================================= arranque ==============================
   Orden de los acontecimientos, y el orden importa:

     1. se aplica el panel con el rol actual, que al principio es ninguno;
     2. se conecta con Firebase y se espera a saber quién entra;
     3. solo con sesión confirmada se descarga y analiza el grafo.

   El grafo no se pide antes de tiempo a propósito. No es que lo proteja
   —Hosting lo sirve público de todas formas—, es que analizar 156 KB de Turtle
   mientras alguien mira una pantalla de acceso no tiene sentido.

   El filtro de módulos se aplica ANTES de pedir nada, y esa es la lección de
   la corrección anterior: si se aplicara al final, un fallo de red dejaría
   todas las pestañas visibles. Tiene que fallar cerrado.

   Las declaraciones de función se elevan, así que se pueden llamar aquí
   arriba; el módulo se ejecuta con el DOM ya construido porque
   <script type="module"> es diferido.                                       */
aplicarPanelRol();
prepararPuerta();

let arrancado = false;

async function arrancar() {
  if (arrancado) return;
  arrancado = true;
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
    pintarEstadisticas(s);
    pintarSelectorClases();
    pintarReportar();
    pintarRevision();
    let evaluado = null;
    if (USUARIO) {
      try {
        const docs = await listar("validacion");
        const mio = docs.find((d) => d.id === USUARIO.uid);
        if (mio && mio.historias) evaluado = mio.historias;
      } catch (e) { /* sin servidor: se usa lo del navegador */ }
    }
    VAL = crearValidacion($("#validacion-app"), HIST,
      { rol: rolActual, irA, descargar, usuario: USUARIO, evaluado });
    /* Sesión de entrevista sin cerrar, si la hay. Solo las propias: las reglas
       del servidor ya lo imponen, y aquí se filtra para que el investigador
       —que sí las ve todas— no retome por error la de otro. */
    try {
      const sesiones = await listar(COL_SES, { mio: true });
      SESION_PENDIENTE = sesiones
        .filter((x) => !x.cerrada && (!USUARIO || x.creadoPor === USUARIO.uid))
        .sort((a, b) => (b.creadoEn || "").localeCompare(a.creadoEn || ""))[0] || null;
    } catch (e) { SESION_PENDIENTE = null; }

    RED = crearRed($("#red-app"), G, {
      alAbrirIndividuo: (iri) => { irA("explorar"); mostrarDetalle(iri); },
    });
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
}

/* ================================== pestañas ============================== */
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  /* La comprobación va aquí y no solo en la pestaña: ocultar el botón evita el
     clic, pero irA() se llama también desde el panel de validación y desde el
     propio cambio de rol. Un único punto que decide qué módulo se abre. */
  if (!puedeVer(b.dataset.v)) return;
  $$("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $$("main > section").forEach((s) => s.classList.toggle("hide", s.id !== "v-" + b.dataset.v));
  window.scrollTo(0, 0);
  /* La red se monta al abrirse, no al arrancar: un <canvas> dentro de una
     sección oculta mide cero de ancho, y el dibujo saldría del tamaño de un
     sello. */
  if (b.dataset.v === "red" && RED) RED.pintar();
});
function irA(vista) { const b = $(`#tabs button[data-v="${vista}"]`); if (b) b.click(); }

/* ================================== SESIÓN ===============================
   La puerta de acceso. El rol NO se elige aquí: llega en el token como custom
   claim y este módulo solo lo traslada a auth.js. Si el token no trae rol, no
   se entra: se avisa y se cierra la sesión, porque una cuenta sin rol no tiene
   nada que ver y dejarla pasar a una pantalla vacía solo confunde.          */
function prepararPuerta() {
  alCambiarRol(aplicarRol);

  const form = $("#f-login");
  const err = $("#login-err");
  const boton = $("#b-entrar");

  const fallo = (m) => { err.textContent = m; err.classList.remove("hide"); };
  const limpiar = () => { err.textContent = ""; err.classList.add("hide"); };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    limpiar();
    boton.disabled = true;
    boton.textContent = "Entrando…";
    try {
      await entrar($("#correo").value, $("#clave").value);
      /* No se toca la pantalla aquí: lo hace el vigilante de sesión de abajo,
         que es el que sabe si el usuario tiene rol. */
    } catch (ex) {
      fallo(mensajeDeError(ex));
      $("#clave").value = "";
      $("#clave").focus();
    } finally {
      boton.disabled = false;
      boton.textContent = "Entrar";
    }
  });

  $("#b-salir").onclick = async () => {
    try { await salir(); } catch (e) { /* ya estaba fuera */ }
  };

  arrancarSesion(async (estado) => {
    /* Aquí NO se limpia el aviso. Al rechazar una cuenta sin rol se llama a
       salir(), y eso vuelve a entrar por esta función con estado nulo: si
       limpiara, borraría el mensaje que acaba de explicar por qué no entró, y
       el usuario se quedaría mirando la puerta sin saber qué pasó. El aviso lo
       limpia el envío del formulario, que es el momento en que deja de
       importar. */
    if (!estado) { cerrarPantalla(); return; }

    /* Autenticado, pero el rol tiene que existir en el catálogo. Un claim con un
       rol desconocido —porque se renombró en auth.js y no se volvió a correr el
       script— no puede abrir la aplicación con cero módulos: eso parecería un
       fallo del sistema cuando es un desajuste de administración. Se trata igual
       que la falta de rol. */
    const conocido = estado.rol && ROLES.some((r) => r.id === estado.rol);
    if (!conocido) {
      cerrarPantalla();
      fallo(estado.rol
        ? `La cuenta ${estado.usuario.correo} tiene asignado el rol «${estado.rol}», que este ` +
          `sistema no reconoce. El investigador debe corregirlo con el script de administración.`
        : `La cuenta ${estado.usuario.correo} existe, pero no tiene ningún rol asignado. ` +
          `El investigador debe asignárselo con el script de administración.`);
      try { await salir(); } catch (e) {}
      return;
    }

    limpiar();
    USUARIO = { uid: estado.usuario.uid, correo: estado.usuario.correo, rol: estado.rol };
    fijarRol(estado.rol);
    abrirPantalla(estado);
    /* El almacén se abre antes que el grafo: si hay Firestore, la bandeja
       llega compartida desde el primer pintado y no parpadea de vacía a llena. */
    await abrirAlmacen(USUARIO);
    if (dejarDeEscuchar) dejarDeEscuchar();
    /* Con Firestore, el jefe de mantenimiento ve entrar el reporte del
       conductor sin recargar. Sin él, esto no hace nada. */
    dejarDeEscuchar = escuchar(COL_PROP, () => { if (puedeVer("revision")) pintarRevision(); });
    arrancar();                      // el grafo se descarga recién ahora
  }).catch(() => {
    fallo("No se pudo cargar Firebase. Revise su conexión y vuelva a intentarlo.");
  });
}

function abrirPantalla(estado) {
  document.body.classList.remove("sin-sesion");
  $("#u-correo").textContent = estado.usuario.correo;
  $("#u-rol").textContent = (ROLES.find((r) => r.id === estado.rol) || {}).nombre || estado.rol;
  $("#clave").value = "";
  aplicarRol();
}

function cerrarPantalla() {
  if (dejarDeEscuchar) { dejarDeEscuchar(); dejarDeEscuchar = null; }
  USUARIO = null;
  document.body.classList.add("sin-sesion");
  fijarRol(null);                     // dispara aplicarRol: oculta todo módulo
  $("#u-correo").textContent = "";
  $("#u-rol").textContent = "";
  $("#clave").value = "";
}

/* =================================== ROL =================================
   Qué módulos se ven. No depende del grafo, y por eso corre de entrada: el
   mapa de vistas y el catálogo de consultas son estáticos.

   Sin rol no se concede nada. Es el mismo principio de la corrección anterior:
   fallar cerrado, tanto si falta la sesión como si falla la red.            */
function aplicarPanelRol() {
  const rol = rolActual();
  const permitidas = vistasPermitidas();
  $$("#tabs button[data-v]").forEach((b) => b.classList.toggle("hide", !permitidas.includes(b.dataset.v)));

  if (!rol) { $("#rol-nota").textContent = ""; return; }

  /* Si el rol no alcanza la pestaña abierta, hay que moverse: dejarla abierta
     sería mostrar justamente lo que no le corresponde. */
  const abierta = $("#tabs button.on");
  if (!abierta || abierta.classList.contains("hide") || !permitidas.includes(abierta.dataset.v)) {
    irA(permitidas[0]);
  }

  const nCons = consultasPermitidas(CONSULTAS).length;
  $("#rol-nota").textContent =
    `${rol.descripcion}  ·  ${permitidas.length} módulos y ${nCons} de ${CONSULTAS.length} consultas. ` +
    `El rol viene de su usuario; no se elige.`;
}

/* Lo anterior más lo que sí necesita el grafo. Se llama al cambiar de rol y al
   terminar el arranque; mientras no haya grafo, repinta solo el panel. */
function aplicarRol() {
  aplicarPanelRol();
  if (!G || !haySesion()) return;
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

  if (puedeVer("red") && RED) {
    const bRed = botonIcono("grafo", "Ver en la red", "g sm");
    bRed.style.marginBottom = "var(--e3)";
    bRed.onclick = () => { RED.centrarEn(iri); irA("red"); RED.pintar(); };
    caja.appendChild(bRed);
  }

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
      `las demás no corresponden al rol «${(rolActual() || {}).nombre || "actual"}».` }));
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
  /* pintarEntrevista es sincrónica y la busca de sesiones no: se pinta primero
     el formulario y el aviso de «hay una sesión sin terminar» se inserta arriba
     cuando llega. Es preferible a dejar la pestaña en blanco esperando. */
  const guardada = SESION_PENDIENTE;
  if (guardada && !ENT) {
    const av = el("div", "aviso");
    av.innerHTML = `<strong>Hay una sesión sin terminar</strong> del ${esc(guardada.fecha)}, ${esc(guardada.rol)}, con ${guardada.reglas.length} reglas.`;
    const r = el("div", "row"); r.style.marginTop = "10px";
    const b1 = el("button", null, "Retomar");
    b1.onclick = () => { ENT = guardada; ENT.cola = ENT.cola.map((id) => BANCO.q.map(preguntaDe).find((p) => p.id === id)).filter(Boolean); pintarSesion(); };
    const b2 = el("button", "g", "Descartar");
    b2.onclick = async () => { await borrar(COL_SES, guardada.id); SESION_PENDIENTE = null; pintarEntrevista(); };
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
  const suyo = (rolActual() || {}).banco;
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

/* La sesión se guarda en cada turno, y ese es el punto: «persistir antes de
   razonar». La escritura no se espera —guardarSesion() no es await— porque
   bloquear la interfaz tras cada frase dictada haría inusable la entrevista;
   si la red falla, almacen.js cae al navegador y no se pierde nada. */
function guardarSesion() {
  if (!ENT) return;
  if (!ENT.id) ENT.id = nuevoId("SES");
  guardar(COL_SES, ENT.id, { ...ENT, cola: ENT.cola.map((p) => p.id), cerrada: false });
}

const cronoEnt = crearCronometro((t) => { const e = $("#e-tiempo"); if (e) e.textContent = t; });

const vozEnt = crearVoz({
  onParcial: (t) => { const i = $("#e-interim"); if (i) i.textContent = t; },
  onFinal: (t) => { anadirTurno(t, vozEnt.quien || "experto", "voz"); },
  onFin: () => { cronoEnt.parar(); pintarEstadoGrabacion(false); const i = $("#e-interim"); if (i) i.textContent = ""; },
  onError: (m) => { cronoEnt.parar(); pintarEstadoGrabacion(false); const e = $("#e-err"); if (e) { e.textContent = m; e.classList.remove("hide"); } },
});

/* Testigo de grabación con punto rojo y cronómetro. En una entrevista de
   cuarenta minutos, saber si el reconocedor sigue vivo importa más que el
   botón: el navegador corta la escucha solo, y descubrirlo al final significa
   haber perdido la respuesta. */
function pintarEstadoGrabacion(grabando) {
  const b = $("#e-voz");
  if (b) {
    b.classList.toggle("rec", grabando);
    cambiarIcono(b, grabando ? "detener" : "microfono",
      grabando ? "Detener" : "Grabar al experto");
  }
  const t = $("#e-testigo");
  if (t) {
    t.classList.toggle("hide", !grabando);
    if (!grabando) { const e = $("#e-tiempo"); if (e) e.textContent = ""; }
  }
}

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
  const bv = botonIcono("microfono", "Grabar al experto", "g"); bv.id = "e-voz";
  bv.onclick = () => {
    if (!vozEnt.disponible) { errd.textContent = "Este navegador no tiene reconocimiento de voz. Escriba la respuesta."; errd.classList.remove("hide"); return; }
    if (vozEnt.activo()) { vozEnt.detener(); return; }
    vozEnt.quien = "experto";
    pintarEstadoGrabacion(true);
    cronoEnt.arrancar();
    vozEnt.iniciar();
  };
  bar.appendChild(bv);

  const testigo = el("span", "testigo hide"); testigo.id = "e-testigo";
  testigo.innerHTML = ICO.grabando;
  testigo.appendChild(el("span", null, "grabando"));
  testigo.appendChild(Object.assign(el("span", "mic-tiempo"), { id: "e-tiempo" }));
  bar.appendChild(testigo);

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
  bn.onclick = async () => {
    if (ENT && ENT.id) await guardar(COL_SES, ENT.id, { ...ENT, cola: ENT.cola.map((p) => p.id), cerrada: true });
    ENT = null; SESION_PENDIENTE = null; pintarEntrevista();
  };
  bar.appendChild(bd); bar.appendChild(bn);
  caja.appendChild(bar);
  caja.appendChild(el("p", "note",
    "Importe el JSON con 09_importar_sesion.py para que las reglas entren en la plantilla y de ahí al grafo."));
  c.appendChild(caja);
}

/* ================================= REPORTAR =============================== */
/* Cronómetro compartido por los dos micrófonos. Ver correr los segundos es la
   única señal fiable de que el reconocedor sigue escuchando: el navegador corta
   la escucha solo y, sin esto, el usuario se queda hablándole a nadie. */
function crearCronometro(alPintar) {
  let t0 = 0, id = null;
  return {
    arrancar() { t0 = Date.now(); alPintar("0:00"); id = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      alPintar(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
    }, 1000); },
    parar() { clearInterval(id); id = null; },
  };
}

const cronoRep = crearCronometro((t) => { const e = $("#r-tiempo"); if (e) e.textContent = t; });

const vozRep = crearVoz({
  onParcial: (t) => { const i = $("#r-interim"); if (i) i.textContent = t; },
  onFinal: (t) => { const ta = $("#r-texto"); ta.value = (ta.value + " " + t).trim(); const i = $("#r-interim"); if (i) i.textContent = ""; },
  onFin: () => { cronoRep.parar(); pintarEstadoMic(false); },
  onError: (m) => { cronoRep.parar(); pintarEstadoMic(false); const e = $("#r-err"); if (e) { e.textContent = m; e.classList.remove("hide"); } },
});

/* El micrófono es un solo control que alterna. Dos botones —uno para empezar y
   otro para parar— obligan a mirar cuál está activo; uno solo, no. */
function pintarEstadoMic(grabando) {
  const b = $("#r-voz"); if (!b) return;
  b.classList.toggle("rec", grabando);
  b.innerHTML = grabando ? ICO.detener : ICO.microfono;
  const pie = $("#r-mic-pie");
  if (pie) pie.textContent = grabando ? "Escuchando… toque para terminar" : "Toque para contar qué pasó";
  const t = $("#r-tiempo"); if (t && !grabando) t.textContent = "";
}

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

  const ta = el("textarea"); ta.id = "r-texto";
  ta.placeholder = "En la bajada de la Panamericana el freno no respondió como debe…";
  const inter = el("div", "interim"); inter.id = "r-interim";

  const errd = el("div", "err hide"); errd.id = "r-err";
  caja.appendChild(errd);

  /* El micrófono, como control principal y no como un botón más de la fila.
     El conductor reporta de pie, en el patio, a veces con guantes: un objetivo
     grande y redondo se acierta sin mirar, y un rótulo de 90 píxeles no. */
  const mic = el("div", "mic-zona");
  const bv = el("button", "mic-boton"); bv.id = "r-voz";
  bv.type = "button";
  bv.setAttribute("aria-label", "Dictar lo que pasó");
  bv.innerHTML = ICO.microfono;
  bv.onclick = () => {
    errd.classList.add("hide");
    if (!vozRep.disponible) {
      errd.textContent = "Este navegador no reconoce la voz. Use Chrome o Edge, o escriba el texto abajo.";
      errd.classList.remove("hide");
      return;
    }
    if (vozRep.activo()) { vozRep.detener(); return; }
    pintarEstadoMic(true);
    cronoRep.arrancar();
    vozRep.iniciar();
  };
  mic.appendChild(bv);
  const micPie = el("div", "mic-pie");
  micPie.appendChild(Object.assign(el("span", null, "Toque para contar qué pasó"), { id: "r-mic-pie" }));
  micPie.appendChild(Object.assign(el("span", "mic-tiempo"), { id: "r-tiempo" }));
  mic.appendChild(micPie);
  caja.appendChild(mic);
  caja.appendChild(inter);

  caja.appendChild(el("label", "lbl", "Qué pasó, en sus palabras"));
  caja.appendChild(ta);

  const bar = el("div", "row");
  bar.style.marginTop = "12px";
  const be = botonIcono("reporte", "Enviar reporte");
  be.onclick = () => {
    const texto = ta.value.trim();
    if (!texto) { alert("Escriba o dicte qué pasó."); return; }
    const base = { fecha: ahora(), vehiculo: selV.value, conductor: selD.value, ruta: selR.value, texto };
    // Los campos elegidos en una lista son datos confirmados por la persona: confianza 1.
    const directos = [];
    if (selC.value) directos.push({ predicado: "etul:tipoComponente", objeto: selC.value });
    if (selS.value) directos.push({ predicado: "etul:severidad", objeto: selS.value });
    // El texto libre se interpreta: eso sí es extracción y va a revisión.
    const props2 = extraerDeTexto(texto, base, directos);
    be.disabled = true;
    Promise.all(props2.map((p) => guardar(COL_PROP, p.id, p)))
      .then(() => {
        ta.value = "";
        pintarRevision();
        pintarFlujoReporte(caja.parentNode, props2, selV.value);
      })
      .catch((err) => {
        errd.textContent = "No se pudo registrar el reporte: " + err.message;
        errd.classList.remove("hide");
      })
      .finally(() => { be.disabled = false; });
  };
  bar.appendChild(be);
  caja.appendChild(bar);
  caja.appendChild(el("p", "note",
    "Lo que elige en las listas es un dato confirmado por usted. Lo que escribe en texto libre lo " +
    "interpreta el sistema, y por eso pasa por revisión antes de entrar al grafo."));
  c.appendChild(caja);
}

/* ------------------------- qué pasa con el reporte ------------------------
   El conductor entrega el reporte y deja de verlo. Eso, en el patio, se traduce
   en no volver a reportar: si no se sabe adónde fue, parece que no sirvió.

   Este panel dibuja la cadena completa y marca dónde queda ahora, quién la
   recoge y qué pasa con cada rama. Es además la trazabilidad de la tesis puesta
   en pantalla: el mismo recorrido que después reconstruyen Q28 y Q29.        */
function pintarFlujoReporte(donde, propuestas, vehiculo) {
  const previo = $("#flujo-reporte");
  if (previo) previo.remove();

  const extraidos = propuestas.filter((p) => p.estado === "ExtPropuesta");
  const confirmados = propuestas.filter((p) => p.estado === "Confirmado");
  const veh = G.individuos(E("Vehiculo")).find((v) => corto(v) === vehiculo);
  const padron = veh ? (G.lit(veh, E("codigoInterno")) || corto(veh)) : vehiculo;

  const caja = el("div", "card flujo");
  caja.id = "flujo-reporte";
  caja.appendChild(el("h2", "serif h2", "Qué pasa ahora con su reporte"));
  caja.appendChild(el("p", "note",
    `Unidad ${padron} · ${ahora()}. Guardado en este navegador; en producción iría a Firestore.`));

  const pasos = [
    { ico: "reporte", rol: "Usted, el conductor", estado: "hecho",
      titulo: "Reporte registrado",
      detalle: `${confirmados.length} dato(s) confirmados por usted en las listas, con confianza 1. ` +
               `Esos no se interpretan: entran tal cual.` },
    { ico: "ondas", rol: "Extractor automático", estado: "hecho",
      titulo: `${extraidos.length} hecho(s) candidatos del texto libre`,
      detalle: extraidos.length
        ? `El sistema interpretó lo que dictó y propuso: ${[...new Set(extraidos.map((p) => p.predicado))].join(", ")}. ` +
          `Cada uno guarda el trozo exacto de sus palabras que lo sustenta.`
        : `De lo que dictó no se pudo proponer ningún hecho. No es un error: sin evidencia, no hay hecho.` },
    { ico: "revisar", rol: "Jefe de mantenimiento", estado: "espera",
      titulo: "Pendiente de revisión",
      detalle: `Nadie más puede aceptarlos. Ningún hecho propuesto por una máquina entra al grafo ` +
               `sin que una persona lo apruebe; es el cuello de botella real del sistema.` },
    { ico: "grafo", rol: "El grafo", estado: "futuro",
      titulo: "Lo aceptado se convierte en Falla y, si corresponde, en OrdenTrabajo",
      detalle: `Lo rechazado no se borra: queda como evidencia de error de extracción, y es lo que ` +
               `mide la consulta Q24.` },
  ];

  const lista = el("div", "pasos");
  pasos.forEach((p, i) => {
    const d = el("div", "paso " + p.estado);
    const ic = el("div", "paso-ico");
    ic.innerHTML = ICO[p.ico] || "";
    d.appendChild(ic);
    const cuerpo = el("div", "paso-cuerpo");
    const cab = el("div", "row");
    cab.appendChild(el("b", null, p.titulo));
    cab.appendChild(el("span", "tag" + (p.estado === "hecho" ? " ok" : p.estado === "espera" ? " esp" : ""),
      p.estado === "hecho" ? "hecho" : p.estado === "espera" ? "en espera" : "después"));
    cuerpo.appendChild(cab);
    cuerpo.appendChild(el("div", "note paso-rol", p.rol));
    cuerpo.appendChild(el("div", "note", p.detalle));
    d.appendChild(cuerpo);
    lista.appendChild(d);
  });
  caja.appendChild(lista);

  /* El botón a la bandeja solo si el rol puede abrirla: al conductor no se le
     ofrece una puerta que se le va a cerrar. */
  if (puedeVer("revision")) {
    const b = botonIcono("revisar", "Ir a la bandeja de revisión", "g");
    b.style.marginTop = "var(--e4)";
    b.onclick = () => irA("revision");
    caja.appendChild(b);
  } else {
    caja.appendChild(el("p", "note",
      "La bandeja no le corresponde a su rol: la revisa el jefe de mantenimiento."));
  }
  donde.appendChild(caja);
  caja.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
async function pintarRevision() {
  const c = $("#revision-app");
  c.innerHTML = "";
  const props = (await listar(COL_PROP)).sort((a, b) => (a.creadoEn || "").localeCompare(b.creadoEn || ""));

  /* Dónde están estos datos, dicho en la propia pantalla. Creer que se está
     compartiendo cuando no, es peor que no compartir. */
  const nota = el("div", modoAlmacen() === "firestore" ? "aviso" : "err");
  nota.innerHTML = modoAlmacen() === "firestore"
    ? `<strong>Bandeja compartida.</strong> Los reportes de todos los usuarios llegan aquí en vivo, y las reglas del servidor deciden quién puede aceptarlos.`
    : `<strong>Bandeja solo en este navegador</strong> (${esc(motivoAlmacen())}). Lo que reporte un conductor desde otro equipo no aparecerá aquí, y esto se pierde al borrar los datos del sitio.`;
  c.appendChild(nota);

  if (!ALMACEN && modoAlmacen() !== "firestore") c.appendChild(Object.assign(el("div", "aviso"),
    { textContent: "Este navegador tampoco permite guardar datos del sitio: la bandeja se vacía al recargar." }));
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
  bv.onclick = async () => {
    if (!confirm("¿Vaciar todas las propuestas? No se puede deshacer.")) return;
    const ok = await vaciar(COL_PROP);
    if (!ok) alert("El servidor no permitió borrar: solo el investigador puede vaciar la bandeja.");
    pintarRevision();
  };
  bar.appendChild(bd); bar.appendChild(bv);
  c.appendChild(bar);
}
/* Las reglas de Firestore solo dejan tocar estos tres campos, y solo a los
   roles revisores. Aceptar no puede aprovecharse para reescribir el hecho: eso
   es «el agente propone, nunca escribe» sostenido por el almacén y no por la
   buena voluntad del código. */
async function cambiar(id, estado) {
  await actualizar(COL_PROP, id, {
    estado,
    revisadoPor: USUARIO ? USUARIO.uid : "local",
    revisadoEn: ahora(),
  });
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
