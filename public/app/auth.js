/* =============================================================================
   auth.js — roles, vistas y consultas permitidas
   ETUL 4 S.A.

   Este módulo es el MODELO DE ROLES: qué vistas y qué consultas corresponden a
   cada puesto. No decide quién es usted; eso lo hace sesion.js contra Firebase
   Auth. El rol llega desde el token como custom claim firmado por Google, y
   aquí solo se traduce a permisos.

   La separación es deliberada y conviene mantenerla: este archivo no importa
   nada de Firebase, así que se puede cargar desde Node. Las comprobaciones del
   despliegue continuo lo importan para cruzar roles, vistas y consultas antes
   de publicar; si alguien le añadiera un import del SDK, esa comprobación
   dejaría de correr.

   LO QUE SIGUE SIN HACER, y hay que decirlo en la defensa antes de que lo
   pregunten: ocultar una pestaña no protege un dato. Firebase Hosting sirve
   los archivos de forma pública, así que el grafo se puede descargar sin haber
   entrado. El acceso por rol decide qué ve la interfaz; con datos reales, el
   filtrado tendría que ocurrir en el servidor, sobre el mismo mapa
   CONSULTAS_POR_ROL, y el cliente no recibiría siquiera las plantillas que no
   le tocan.

   Para añadir un rol: defínalo en ROLES, sus consultas en CONSULTAS_POR_ROL y
   su panel en PANEL_POR_ROL. Los tres mapas se comprueban al cargar el módulo.
============================================================================= */

/* Las vistas son las secciones de index.html: cada una es <section id="v-ID">
   con su pestaña <button data-v="ID">. */
export const VISTAS = {
  preguntar:  "Preguntar",
  explorar:   "Explorar el grafo",
  red:        "Red de entidades",
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
  /* Ninguna. El conductor no consulta el grafo: lo alimenta. Darle consultas
     sería inventarle una tarea que en el patio no hace. */
  "conductor":          [],
  "investigador":       "*",
};

/* ------------------------------ qué vistas ve ------------------------------
   «acerca» se añade siempre: la advertencia sobre los datos ficticios y la
   nota de privacidad tienen que estar al alcance de cualquiera.               */
export const PANEL_POR_ROL = {
  "jefe-mantenimiento": ["preguntar", "explorar", "red", "consultas", "entrevista", "revision", "validacion"],
  "jefe-operaciones":   ["preguntar", "explorar", "red", "consultas", "entrevista", "validacion"],
  "programador":        ["preguntar", "explorar", "red", "consultas", "entrevista", "validacion"],
  "tecnico":            ["preguntar", "consultas", "entrevista", "reportar", "validacion"],
  /* Dos módulos y se acabó: reportar la falla y «Acerca de», que lleva la
     advertencia sobre los datos ficticios y debe estar al alcance de cualquiera.
     Antes tenía también «Preguntar»; se le quitó porque no es su trabajo. */
  "conductor":          ["reportar"],
  "investigador":       ["preguntar", "explorar", "red", "consultas", "entrevista", "reportar", "revision", "validacion"],
};

/* ------------------------------- estado actual ----------------------------
   Nace vacío. Antes se leía de localStorage, y eso era coherente con un
   desplegable: el navegador recordaba lo último elegido. Ya no: el rol es una
   afirmación del token, no una preferencia del equipo. Si no hay sesión, no
   hay rol, y sin rol no se ve nada.                                          */
let actual = null;
const oyentes = [];

/** Rol activo, o null si no hay sesión. */
export function rolActual() {
  return ROLES.find((r) => r.id === actual) || null;
}

export function haySesion() { return actual !== null; }

/** La llama main.js con lo que venga del claim. `null` al cerrar sesión. */
export function fijarRol(id) {
  const nuevo = ROLES.some((r) => r.id === id) ? id : null;
  if (nuevo === actual) return false;
  actual = nuevo;
  oyentes.forEach((f) => { try { f(rolActual()); } catch (e) { console.error(e); } });
  return true;
}

/** Se ejecuta cada vez que cambia el rol. Devuelve la función para darse de baja. */
export function alCambiarRol(f) {
  oyentes.push(f);
  return () => { const i = oyentes.indexOf(f); if (i >= 0) oyentes.splice(i, 1); };
}

/* --------------------------------- permisos -------------------------------
   Sin rol no se concede nada, ni siquiera «acerca»: la puerta de acceso ocupa
   toda la pantalla y detrás no debe quedar nada visible.                     */
export function vistasPermitidas(id = actual) {
  if (!id) return [];
  return [...(PANEL_POR_ROL[id] || []), "acerca"];
}

export function puedeVer(vista, id = actual) {
  return vistasPermitidas(id).includes(vista);
}

/** Ids de consulta que el rol puede ejecutar. `todas` es el catálogo completo;
    se recibe como argumento para no crear una dependencia circular con
    consultas.js, que no tiene por qué saber que existen los roles. */
export function consultasPermitidas(todas, id = actual) {
  if (!id) return [];
  const p = CONSULTAS_POR_ROL[id];
  const ids = todas.map((c) => c.id);
  return p === "*" ? ids : ids.filter((x) => (p || []).includes(x));
}

export function puedeConsultar(idConsulta, id = actual) {
  if (!id) return false;
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
