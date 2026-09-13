/* =============================================================================
   auth.js — roles, vistas y consultas permitidas
   ETUL 4 S.A.

   ADVERTENCIA, y conviene decirla en la defensa antes de que la pregunten:
   esto NO ES AUTENTICACIÓN. No hay contraseña, no hay sesión, no hay servidor
   que verifique nada. El rol se elige en un desplegable y se guarda en este
   navegador. Cualquiera puede cambiarlo, y quien abra la consola ve el grafo
   entero sin importar el rol.

   Lo que sí demuestra este módulo es la otra mitad del problema: qué consultas
   y qué vistas tiene sentido darle a cada perfil, que es una decisión de
   modelado, no de seguridad. En producción el mismo mapa CONSULTAS_POR_ROL
   vive en el servidor, detrás de Firebase Auth, y el cliente no recibe siquiera
   las plantillas que no le tocan. Aquí solo se ocultan.

   Para añadir un rol: defínalo en ROLES, sus consultas en CONSULTAS_POR_ROL y
   su panel en PANEL_POR_ROL. Los tres mapas se comprueban al cargar el módulo.
============================================================================= */

const CLAVE_ROL = "etul4_rol_v1";

/* Las vistas son las secciones de index.html: cada una es <section id="v-ID">
   con su pestaña <button data-v="ID">. */
export const VISTAS = {
  preguntar:  "Preguntar",
  explorar:   "Explorar el grafo",
  consultas:  "Consultas",
  entrevista: "Entrevista por voz",
  reportar:   "Reportar falla",
  revision:   "Revisión",
  validacion: "Validación",
  acerca:     "Acerca de",
};

/* -------------------------------- los roles -------------------------------
   `banco` enlaza con los roles del banco de preguntas (datos/banco.json), que
   son solo cuatro. Los roles sin `banco` no tienen preguntas de entrevista
   asignadas: al conductor no se le entrevista, se le reporta; el investigador
   entrevista, no es entrevistado.                                            */
export const ROLES = [
  {
    id: "jefe-mantenimiento",
    nombre: "Jefe de mantenimiento",
    descripcion: "Decide qué entra al taller y con qué prioridad. Es el experto cuyas reglas se capturan.",
    banco: "Jefe de mantenimiento",
  },
  {
    id: "jefe-operaciones",
    nombre: "Jefe de operaciones",
    descripcion: "Responde por la cobertura de las cuatro rutas. Le importa la disponibilidad, no la falla.",
    banco: "Jefe de operaciones",
  },
  {
    id: "programador",
    nombre: "Programador de flota",
    descripcion: "Arma la programación diaria: qué unidad a qué ruta y cuál se libera al taller.",
    banco: "Programador de flota",
  },
  {
    id: "tecnico",
    nombre: "Técnico senior",
    descripcion: "Ejecuta las órdenes de trabajo. Consulta historial de fallas y disponibilidad de repuestos.",
    banco: "Técnico senior",
  },
  {
    id: "conductor",
    nombre: "Conductor",
    descripcion: "No consulta el grafo: lo alimenta. Reporta la falla al llegar al patio.",
    banco: null,
  },
  {
    id: "investigador",
    nombre: "Investigador (tesista)",
    descripcion: "Ve todo, incluidas las consultas de trazabilidad y las métricas de evaluación.",
    banco: null,
  },
];

/* ------------------------- qué consulta ve cada rol ------------------------
   "*" significa todas. El criterio es el uso real, no la jerarquía: el
   conductor no ve Q01 porque nunca va a preguntar qué unidad tiene el servicio
   vencido; el jefe de operaciones no ve Q04 ni Q13 porque la falla repetida y
   el stock de repuestos no son decisión suya.

   Q24, Q29 y Q30 miden el comportamiento del propio sistema. Son instrumentos
   de la tesis, no del negocio: solo el investigador las ve. Q28 (de qué texto
   salió una regla) sí la ve el jefe de mantenimiento, porque es quien tiene
   que poder desmentir una regla que se le atribuye.                           */
export const CONSULTAS_POR_ROL = {
  "jefe-mantenimiento": ["Q01", "Q02", "Q04", "Q06", "Q09", "Q11", "Q13", "Q15", "Q16", "Q28"],
  "jefe-operaciones":   ["Q02", "Q11", "Q15", "Q16", "Q17", "Q19"],
  "programador":        ["Q01", "Q02", "Q06", "Q13", "Q15", "Q16", "Q17", "Q19"],
  "tecnico":            ["Q01", "Q02", "Q04", "Q06", "Q13"],
  "conductor":          ["Q02", "Q16"],
  "investigador":       "*",
};

/* ------------------------------ qué vistas ve ------------------------------
   «acerca» se añade siempre: la advertencia sobre los datos ficticios y la
   nota de privacidad tienen que estar al alcance de cualquiera.               */
export const PANEL_POR_ROL = {
  "jefe-mantenimiento": ["preguntar", "explorar", "consultas", "entrevista", "revision", "validacion"],
  "jefe-operaciones":   ["preguntar", "explorar", "consultas", "entrevista", "validacion"],
  "programador":        ["preguntar", "explorar", "consultas", "entrevista", "validacion"],
  "tecnico":            ["preguntar", "consultas", "entrevista", "reportar", "validacion"],
  "conductor":          ["preguntar", "reportar"],
  "investigador":       ["preguntar", "explorar", "consultas", "entrevista", "reportar", "revision", "validacion"],
};

const POR_DEFECTO = "jefe-mantenimiento";

/* ------------------------------- estado actual ---------------------------- */
let actual = POR_DEFECTO;
const oyentes = [];

try {
  const g = localStorage.getItem(CLAVE_ROL);
  if (g && ROLES.some((r) => r.id === g)) actual = g;
} catch (e) { /* navegador sin almacenamiento: se queda con el rol por defecto */ }

export function rolActual() {
  return ROLES.find((r) => r.id === actual) || ROLES[0];
}

export function fijarRol(id) {
  if (!ROLES.some((r) => r.id === id)) return false;
  if (id === actual) return false;
  actual = id;
  try { localStorage.setItem(CLAVE_ROL, id); } catch (e) {}
  oyentes.forEach((f) => { try { f(rolActual()); } catch (e) { console.error(e); } });
  return true;
}

/** Se ejecuta cada vez que cambia el rol. Devuelve la función para darse de baja. */
export function alCambiarRol(f) {
  oyentes.push(f);
  return () => { const i = oyentes.indexOf(f); if (i >= 0) oyentes.splice(i, 1); };
}

/* --------------------------------- permisos ------------------------------- */
export function vistasPermitidas(id = actual) {
  return [...(PANEL_POR_ROL[id] || []), "acerca"];
}

export function puedeVer(vista, id = actual) {
  return vistasPermitidas(id).includes(vista);
}

/** Ids de consulta que el rol puede ejecutar. `todas` es el catálogo completo;
    se recibe como argumento para no crear una dependencia circular con
    consultas.js, que no tiene por qué saber que existen los roles. */
export function consultasPermitidas(todas, id = actual) {
  const p = CONSULTAS_POR_ROL[id];
  const ids = todas.map((c) => c.id);
  return p === "*" ? ids : ids.filter((x) => (p || []).includes(x));
}

export function puedeConsultar(idConsulta, id = actual) {
  const p = CONSULTAS_POR_ROL[id];
  return p === "*" || (p || []).includes(idConsulta);
}

/* --------------------------- comprobación de los mapas ---------------------
   Un rol sin entrada en CONSULTAS_POR_ROL o en PANEL_POR_ROL se queda mudo sin
   avisar. Es el error más fácil de cometer al añadir un rol, así que se avisa
   por consola al cargar. No se lanza excepción: un mapa incompleto no debe
   impedir que la página cargue.                                              */
for (const r of ROLES) {
  if (!(r.id in CONSULTAS_POR_ROL)) console.warn(`auth: el rol «${r.id}» no tiene consultas en CONSULTAS_POR_ROL`);
  if (!(r.id in PANEL_POR_ROL)) console.warn(`auth: el rol «${r.id}» no tiene vistas en PANEL_POR_ROL`);
}
for (const id of Object.keys(PANEL_POR_ROL)) {
  const raras = PANEL_POR_ROL[id].filter((v) => !(v in VISTAS));
  if (raras.length) console.warn(`auth: el rol «${id}» declara vistas inexistentes: ${raras.join(", ")}`);
}
