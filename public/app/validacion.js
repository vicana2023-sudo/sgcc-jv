/* =============================================================================
   validacion.js — panel de validación de las historias de usuario
   ETUL 4 S.A.

   Sirve para que un usuario real recorra las historias de usuario del sistema y
   declare, una por una, si el prototipo las cumple. Cada veredicto va con una
   observación escrita: un «no cumple» sin motivo no sirve para corregir nada.

   Las historias no están en el código: se cargan de datos/historias.json. Este
   módulo solo depende de la forma de los campos (id, modulo, rol, titulo,
   historia, criterio, vista), no de su contenido, así que el archivo se puede
   reemplazar por la exportación del manual de historias sin tocar nada de aquí.

   Lo evaluado se guarda en este navegador, igual que la bandeja de revisión.
   Para que sirva de evidencia hay que exportarlo: el CSV y el JSON son el
   resultado, no lo que queda en la pantalla.
============================================================================= */

import { puedeVer, ROLES, VISTAS } from "./auth.js";
import { modoAlmacen, guardar } from "./almacen.js";

const COL = "validacion";

const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x !== undefined) n.textContent = x; return n; };

/* Un documento por persona, con su identificador de usuario como nombre: así la
   regla del servidor es trivial («solo escribes sobre el tuyo») y no hay forma
   de tocar el veredicto de otro.

   El estado se mantiene en memoria y se vuelca entero en cada cambio. Son 72
   entradas: escribir el documento completo cuesta menos que llevar la cuenta de
   qué campo cambió, y evita que un fallo a mitad deje media evaluación.

   La copia en el navegador se conserva siempre, tenga o no Firestore: es lo que
   permite seguir evaluando si se cae la red durante una sesión de validación,
   que puede durar una hora.                                                  */
let cache = null;
let quien = "local";

const leer = () => {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem("etul4_" + COL + "_" + quien)) ?? {}; }
  catch (e) { cache = {}; }
  return cache;
};
const escribir = (v) => {
  cache = v;
  try { localStorage.setItem("etul4_" + COL + "_" + quien, JSON.stringify(v)); } catch (e) {}
  if (modoAlmacen() === "firestore") guardar(COL, quien, { historias: v });
};
const ahora = () => new Date().toISOString().slice(0, 16).replace("T", " ");

/* Clase de etiqueta por veredicto, para que el color diga lo mismo que el texto. */
const COLOR = {
  "Cumple": "ok",
  "Cumple parcialmente": "esp",
  "No cumple": "mal",
  "No aplica": "",
};

/**
 * @param {HTMLElement} contenedor  dónde pintar
 * @param {object} datos            el contenido de historias.json
 * @param {object} opciones
 *        rol       función que devuelve el rol activo (objeto de auth.ROLES)
 *        irA       función para cambiar de vista, o null para no ofrecer el salto
 *        descargar función (nombre, contenido, tipo)
 */
export function crearValidacion(contenedor, datos, opciones = {}) {
  /* El identificador del usuario llega desde main.js: sin él, los veredictos de
     dos personas que compartieran navegador se pisarían. */
  if (opciones.usuario && opciones.usuario.uid) quien = opciones.usuario.uid;
  if (opciones.evaluado) cache = opciones.evaluado;

  /* Nunca debería llegar nulo —solo se pinta con sesión—, pero el panel no es
     el sitio donde descubrir que sí. */
  const rolDe = () => (opciones.rol ? opciones.rol() : null) || ROLES[0];
  const irA = opciones.irA || null;
  const bajar = opciones.descargar || descargarPorDefecto;
  const VEREDICTOS = datos.veredictos || ["Cumple", "Cumple parcialmente", "No cumple", "No aplica"];

  /* Filtros: viven fuera de pintar() para que no se reinicien al repintar
     después de cada veredicto. */
  const filtro = { modulo: "", veredicto: "", texto: "", todas: false };

  function delRol(h, rol) {
    return h.rol === "todos" || h.rol === rol.id;
  }

  function visibles() {
    const rol = rolDe();
    return datos.historias.filter((h) => {
      if (!filtro.todas && !delRol(h, rol)) return false;
      if (filtro.modulo && h.modulo !== filtro.modulo) return false;
      const v = (leer()[h.id] || {}).veredicto || "";
      if (filtro.veredicto === "__sin") { if (v) return false; }
      else if (filtro.veredicto && v !== filtro.veredicto) return false;
      if (filtro.texto) {
        const t = (h.id + " " + h.titulo + " " + h.historia + " " + h.criterio).toLowerCase();
        if (!t.includes(filtro.texto)) return false;
      }
      return true;
    });
  }

  function pintar() {
    const rol = rolDe();
    const estado = leer();
    contenedor.innerHTML = "";

    /* ------------------------------ resumen ------------------------------ */
    const ambito = filtro.todas ? datos.historias : datos.historias.filter((h) => delRol(h, rol));
    const cuenta = (v) => ambito.filter((h) => ((estado[h.id] || {}).veredicto || "") === v).length;
    const res = el("div", "stats");
    [...VEREDICTOS.map((v) => [v.toLowerCase(), cuenta(v)]), ["sin evaluar", cuenta("")]]
      .forEach(([k, n]) => {
        const d = el("div", "stat");
        d.appendChild(el("b", null, String(n)));
        d.appendChild(el("span", null, k));
        res.appendChild(d);
      });
    contenedor.appendChild(res);

    /* ------------------------------ filtros ------------------------------ */
    const caja = el("div", "card");
    const g = el("div", "grid");

    /* Solo los módulos que tienen alguna historia para este rol. Ofrecer los
       doce cuando el rol solo alcanza cinco lleva a elegir uno y encontrarse la
       lista vacía, sin saber si es cosa del filtro o del rol. */
    const modulosDelRol = (datos.modulos || []).filter((m) => ambito.some((h) => h.modulo === m));
    const selM = el("select");
    selM.add(new Option(`(sus ${modulosDelRol.length} módulos)`, ""));
    modulosDelRol.forEach((m) => selM.add(new Option(m, m)));
    /* Si el rol cambió y el módulo filtrado ya no le corresponde, el filtro se
       suelta en vez de dejar la vista vacía. */
    if (filtro.modulo && !modulosDelRol.includes(filtro.modulo)) filtro.modulo = "";
    selM.value = filtro.modulo;
    selM.onchange = () => { filtro.modulo = selM.value; pintar(); };

    const selV = el("select");
    selV.add(new Option("(cualquier veredicto)", ""));
    selV.add(new Option("Sin evaluar", "__sin"));
    VEREDICTOS.forEach((v) => selV.add(new Option(v, v)));
    selV.value = filtro.veredicto;
    selV.onchange = () => { filtro.veredicto = selV.value; pintar(); };

    const inT = el("input");
    inT.placeholder = "Buscar en el texto de la historia";
    inT.value = filtro.texto;
    inT.oninput = () => { filtro.texto = inT.value.trim().toLowerCase(); pintar(); };

    [["Módulo", selM], ["Veredicto", selV], ["Buscar", inT]].forEach(([t, i]) => {
      const d = el("div"); d.appendChild(el("label", "lbl", t)); d.appendChild(i); g.appendChild(d);
    });
    caja.appendChild(g);

    const lab = el("label", "row modo");
    lab.style.marginTop = "14px";
    const chk = el("input"); chk.type = "checkbox"; chk.checked = filtro.todas;
    chk.onchange = () => { filtro.todas = chk.checked; pintar(); };
    lab.appendChild(chk);
    lab.appendChild(el("span", "note",
      `Ver las ${datos.historias.length} historias, no solo las de «${rol.nombre}»`));
    caja.appendChild(lab);
    contenedor.appendChild(caja);

    /* ---------------------------- las historias -------------------------- */
    const lista = visibles();
    if (!lista.length) {
      contenedor.appendChild(Object.assign(el("div", "card"),
        { innerHTML: '<p class="note" style="margin:0">Ningún resultado con esos filtros.</p>' }));
    }

    let moduloActual = null;
    for (const h of lista) {
      if (h.modulo !== moduloActual) {
        moduloActual = h.modulo;
        contenedor.appendChild(el("h2", "serif h2", moduloActual));
      }

      const c = el("div", "card");
      const marca = estado[h.id] || {};

      const cab = el("div", "row");
      cab.style.justifyContent = "space-between";
      const izq = el("div", "row");
      izq.appendChild(el("span", "tag", h.id));
      izq.appendChild(el("span", "note", h.rol === "todos" ? "cualquier rol"
        : (ROLES.find((r) => r.id === h.rol) || {}).nombre || h.rol));
      cab.appendChild(izq);
      if (marca.veredicto) {
        const t = el("span", "tag " + (COLOR[marca.veredicto] ?? ""), marca.veredicto);
        t.title = "Evaluado el " + (marca.fecha || "");
        cab.appendChild(t);
      }
      c.appendChild(cab);

      c.appendChild(el("h3", "serif h2", h.titulo));
      c.appendChild(el("p", null, h.historia));
      const cr = el("p", "note");
      cr.appendChild(el("b", null, "Se comprueba así: "));
      cr.appendChild(document.createTextNode(h.criterio));
      c.appendChild(cr);

      /* veredicto */
      c.appendChild(el("label", "lbl", "Veredicto"));
      const bar = el("div", "row");
      VEREDICTOS.forEach((v) => {
        const b = el("button", marca.veredicto === v ? null : "g", v);
        b.onclick = () => {
          const e = leer();
          const previo = e[h.id] || {};
          /* Volver a pulsar el veredicto activo lo retira: evaluar por error no
             debería ser irreversible. */
          if (previo.veredicto === v) delete e[h.id].veredicto;
          else e[h.id] = { ...previo, veredicto: v, rol: rol.id, fecha: ahora() };
          escribir(e);
          pintar();
        };
        bar.appendChild(b);
      });
      c.appendChild(bar);

      /* observación */
      c.appendChild(el("label", "lbl", "Observación"));
      const ta = el("textarea");
      ta.placeholder = "Qué falla, qué falta, con qué unidad o ruta se comprobó";
      ta.value = marca.observacion || "";
      ta.onblur = () => {
        const e = leer();
        const previo = e[h.id] || {};
        const nv = ta.value.trim();
        if ((previo.observacion || "") === nv) return;
        e[h.id] = { ...previo, observacion: nv, rol: rol.id, fecha: ahora() };
        escribir(e);
      };
      c.appendChild(ta);

      /* salto a la vista que la historia describe */
      if (irA && h.vista) {
        const bar2 = el("div", "row");
        bar2.style.marginTop = "12px";
        const b = el("button", "g sm", "Ir a «" + (VISTAS[h.vista] || h.vista) + "»");
        if (!puedeVer(h.vista)) {
          b.disabled = true;
          b.title = `El rol «${rol.nombre}» no tiene acceso a esa vista. Cambie de rol para comprobarla.`;
        } else {
          b.onclick = () => irA(h.vista);
        }
        bar2.appendChild(b);
        c.appendChild(bar2);
      }

      contenedor.appendChild(c);
    }

    /* ----------------------------- exportación --------------------------- */
    const pie = el("div", "row");
    pie.style.marginTop = "22px";

    const bc = el("button", "g", "Descargar CSV");
    bc.onclick = () => bajar("validacion-historias.csv", aCSV(datos.historias, leer()), "text/csv;charset=utf-8");

    const bj = el("button", "g", "Descargar JSON");
    bj.onclick = () => {
      const e = leer();
      const paq = {
        fecha: ahora(),
        rolQueValida: rol.id,
        origenHistorias: datos._origen || "",
        total: datos.historias.length,
        evaluadas: datos.historias.filter((h) => (e[h.id] || {}).veredicto).length,
        resultados: datos.historias.map((h) => ({
          id: h.id, modulo: h.modulo, rol: h.rol, titulo: h.titulo,
          historia: h.historia, criterio: h.criterio,
          veredicto: (e[h.id] || {}).veredicto || "",
          observacion: (e[h.id] || {}).observacion || "",
          evaluadaPor: (e[h.id] || {}).rol || "",
          fecha: (e[h.id] || {}).fecha || "",
        })),
      };
      bajar("validacion-historias.json", JSON.stringify(paq, null, 2), "application/json");
    };

    const bv = el("button", "g", "Borrar lo evaluado");
    bv.onclick = () => {
      if (!confirm("¿Borrar todos los veredictos y observaciones? No se puede deshacer.")) return;
      escribir({});
      pintar();
    };

    [bc, bj, bv].forEach((b) => pie.appendChild(b));
    contenedor.appendChild(pie);

    contenedor.appendChild(el("p", "note",
      modoAlmacen() === "firestore"
        ? "Lo evaluado queda guardado a su nombre en el servidor: puede seguir desde otro equipo. " +
          "Aun así, descárguelo: el anexo de la tesis es el archivo, no la pantalla."
        : "Lo evaluado se guarda solo en este navegador. Para que cuente como evidencia de la " +
          "validación hay que descargarlo: al borrar los datos del sitio se pierde."));
  }

  return { pintar };
}

/* --------------------------------- utilidades ----------------------------- */
function aCSV(historias, estado) {
  const q = (s) => '"' + String(s ?? "").replace(/"/g, '""') + '"';
  const cab = ["ID", "Módulo", "Rol", "Título", "Historia", "Criterio", "Veredicto", "Observación", "Evaluada por", "Fecha"];
  const filas = historias.map((h) => {
    const e = estado[h.id] || {};
    return [h.id, h.modulo, h.rol, h.titulo, h.historia, h.criterio,
            e.veredicto || "", e.observacion || "", e.rol || "", e.fecha || ""].map(q).join(";");
  });
  /* Punto y coma y BOM: es lo que abre bien Excel en español sin pasar por el
     asistente de importación. */
  return "\uFEFF" + [cab.map(q).join(";"), ...filas].join("\r\n");
}

function descargarPorDefecto(nombre, contenido, tipo) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([contenido], { type: tipo || "text/plain;charset=utf-8" }));
  a.download = nombre;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
